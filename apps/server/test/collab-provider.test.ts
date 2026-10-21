import { CollabProvider, SharedDefinition, workflowSpec } from '@ow/collab'
import { workflows } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * The browser's provider (M16 step 3a) against the real server: it syncs, saves on request (the answer covering every
 * edit sent before it), keeps what's typed offline and syncs it on reconnect, reports a merge the schema refuses, and
 * carries presence.
 */

let env: TestEnv
let cookie: string
let baseUrl: string
let admin: ReturnType<typeof trpc>

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: {
  status: number
  body: { result?: { data: any }; error?: { message: string } }
}): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

const definition = (code: string): WorkflowDefinition => ({
  schemaVersion: 1,
  blocks: [
    { name: 'startTrigger', type: 'startTrigger' },
    { name: 'code1', type: 'code', config: { code } },
  ],
  edges: [{ from: 'startTrigger', port: 'out', to: 'code1' }],
})

async function createWorkflow(slug: string, code = 'return 1'): Promise<string> {
  const { id } = data(await admin.mutate('workflows.create', { slug, name: slug }))
  data(await admin.mutate('workflows.saveDraft', { id, revision: 1, definition: definition(code) }))
  return `workflow:${id}`
}

/** An editor: a document, its definition view and its provider. */
function editor(key: string) {
  const doc = new Y.Doc()
  const shared = new SharedDefinition<WorkflowDefinition>(doc, workflowSpec)
  const provider = new CollabProvider({
    url: `${baseUrl}/api/collab/${key}`,
    doc,
    createSocket: (url) => new WebSocket(url, { headers: { cookie } } as never),
    saveAfterMs: 50,
    minRetryMs: 50,
  })
  return {
    doc,
    shared,
    provider,
    synced: () => vi.waitFor(() => expect(provider.state).toBe('synced')),
    edit: (code: string) => {
      const v = shared.value
      shared.set({ ...v, blocks: v.blocks.map((b) => (b.type === 'code' ? { ...b, config: { code } } : b)) })
    },
    code: () => (shared.value.blocks[1] as { config: { code: string } } | undefined)?.config.code,
  }
}

const draftOf = async (key: string) =>
  (
    await env.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, key.split(':')[1]!))
  )[0]!

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  cookie = await login(env.app, 'admin@example.com')
  admin = trpc(env.app, cookie)
  baseUrl = (await env.app.listen({ port: 0, host: '127.0.0.1' })).replace('http', 'ws')
}, 120_000)

afterAll(async () => {
  await env?.stop()
})

describe('CollabProvider', () => {
  it('syncs, and saves to the draft on request with every edit sent before', async () => {
    const key = await createWorkflow('provider-save')
    const a = editor(key)
    await a.synced()
    expect(a.shared.value).toEqual(definition('return 1'))
    expect(a.provider.status).toEqual({ revision: 2, error: null })
    a.edit('return 2')
    expect(a.provider.unsaved).toBe(true)
    const status = await a.provider.save()
    expect(status).toEqual({ revision: 3, error: null })
    expect(a.provider.unsaved).toBe(false)
    expect((await draftOf(key)).draftDefinition).toEqual(definition('return 2'))
    // Nothing new: the same revision.
    expect(await a.provider.save()).toEqual({ revision: 3, error: null })
    a.provider.destroy()
  })

  it('asks for a save by itself once edits are idle', async () => {
    const key = await createWorkflow('provider-idle')
    const a = editor(key)
    await a.synced()
    const changes = vi.fn()
    a.provider.subscribe(changes)
    a.edit('return "idle"')
    await vi.waitFor(() => expect(a.provider.unsaved).toBe(false))
    expect(a.provider.status?.revision).toBe(3)
    expect(changes).toHaveBeenCalled()
    a.provider.destroy()
  })

  it('keeps what is typed offline and syncs it on reconnect', async () => {
    const key = await createWorkflow('provider-offline', 'abc')
    const a = editor(key)
    const b = editor(key)
    await a.synced()
    await b.synced()
    // a's connection drops.
    ;(a.provider as unknown as { socket: WebSocket }).socket.close()
    await vi.waitFor(() => expect(a.provider.state).not.toBe('synced'))
    a.edit('abcX')
    b.edit('Yabc')
    const saved = a.provider.save()
    await a.synced()
    expect((await saved).error).toBeNull()
    await vi.waitFor(() => expect(b.code()).toBe('YabcX'))
    expect(a.code()).toBe('YabcX')
    expect((await draftOf(key)).draftDefinition).toEqual(definition('YabcX'))
    a.provider.destroy()
    b.provider.destroy()
  })

  it('reports a merge the schema refuses, and keeps the edits unsaved', async () => {
    const key = await createWorkflow('provider-refused')
    const a = editor(key)
    await a.synced()
    a.shared.root.set('schemaVersion', 2)
    const status = await a.provider.save()
    expect(status.error).toMatch(/schemaVersion/)
    expect(a.provider.unsaved).toBe(true)
    // Put back, the document equals the draft again: nothing to write.
    a.shared.root.set('schemaVersion', 1)
    expect(await a.provider.save()).toEqual({ revision: 2, error: null })
    expect(a.provider.unsaved).toBe(false)
    a.provider.destroy()
  })

  it('carries presence, and takes it away on destroy', async () => {
    const key = await createWorkflow('provider-presence')
    const a = editor(key)
    const b = editor(key)
    await a.synced()
    await b.synced()
    a.provider.awareness.setLocalStateField('selection', ['code1'])
    await vi.waitFor(() =>
      expect(b.provider.awareness.getStates().get(a.doc.clientID)).toMatchObject({
        selection: ['code1'],
        user: { name: 'admin' },
      }),
    )
    a.provider.destroy()
    await vi.waitFor(() => expect(b.provider.awareness.getStates().has(a.doc.clientID)).toBe(false))
    b.provider.destroy()
  })
})
