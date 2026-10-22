import {
  type CollabStatus,
  MESSAGE_AWARENESS,
  MESSAGE_STATUS,
  MESSAGE_SYNC,
  SharedDefinition,
  workflowSpec,
} from '@ow/collab'
import { collabDocuments, collabUpdates, createDb, gitBranchDrafts, users, workflows } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { eq } from 'drizzle-orm'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'
import { buildApp } from '../src/api/app'
import { type CollabPeer, CollabRoom } from '../src/services/collab/rooms'
import { COLLAB_CHANNEL, CollabStore } from '../src/services/collab/store'
import { resolveTarget } from '../src/services/collab/target'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * Editing drafts together (M16 step 2a): `GET /api/collab/<key>` opens a draft's Yjs document, made from the draft
 * the first time; edits go to the others in the room and into Postgres; presence carries who people really are;
 * watchers can't write; strangers get nothing.
 */

let env: TestEnv
let adminCookie: string
let memberCookie: string
let admin: ReturnType<typeof trpc>
let memberGroupId: string
let baseUrl: string

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
  return id
}

/** Opens a real WebSocket (Node's, which can send the cookie); resolves once open, rejects if refused. */
function open(cookie: string, key: string, base = baseUrl): Promise<WebSocket> {
  const ws = new WebSocket(`${base}/api/collab/${key}`, { headers: { cookie } } as never)
  ws.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('refused'))
  })
}

/** Opens a connection and waits for the server to end it: its close code and reason. */
function endedWith(cookie: string, key: string): Promise<{ code: number; reason: string }> {
  const ws = new WebSocket(`${baseUrl}/api/collab/${key}`, { headers: { cookie } } as never)
  return new Promise((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason })
  })
}

/** A browser's side of the connection: a document kept in sync with the server's, and presence. */
async function connect(cookie: string, key: string, base = baseUrl) {
  const ws = await open(cookie, key, base)
  const doc = new Y.Doc()
  const shared = new SharedDefinition<WorkflowDefinition>(doc, workflowSpec)
  const awareness = new Awareness(doc)
  const send = (write: (e: encoding.Encoder) => void) => {
    const e = encoding.createEncoder()
    write(e)
    ws.send(encoding.toUint8Array(e))
  }
  let synced = false
  let status: CollabStatus | null = null
  ws.addEventListener('message', (event) => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer))
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder()
      encoding.writeVarUint(reply, MESSAGE_SYNC)
      const kind = sync.readSyncMessage(decoder, reply, doc, 'server')
      if (kind === sync.messageYjsSyncStep2) synced = true
      if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply))
    } else if (type === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'server')
    } else if (type === MESSAGE_STATUS) {
      status = JSON.parse(decoding.readVarString(decoder))
    }
  })
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'server') return
    send((e) => {
      encoding.writeVarUint(e, MESSAGE_SYNC)
      sync.writeUpdate(e, update)
    })
  })
  awareness.on('update', ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
    if (origin === 'server') return
    send((e) => {
      encoding.writeVarUint(e, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [...added, ...updated]))
    })
  })
  const ended = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
  )
  const closed = ended.then((e) => e.code)
  send((e) => {
    encoding.writeVarUint(e, MESSAGE_SYNC)
    sync.writeSyncStep1(e, doc)
  })
  await vi.waitFor(() => expect(synced).toBe(true))
  return {
    ws,
    shared,
    awareness,
    closed,
    edit: (code: string) => {
      const v = shared.value
      shared.set({ ...v, blocks: v.blocks.map((b) => (b.type === 'code' ? { ...b, config: { code } } : b)) })
    },
    status: () => status,
    closedWith: () => ended,
    code: () => (shared.value.blocks[1] as { config: { code: string } } | undefined)?.config.code,
    close: async () => {
      ws.close()
      await closed
    },
  }
}

/** Waits until the server has closed the document's room (stored and compacted). */
const settled = (key: string) =>
  vi.waitFor(async () => {
    expect(await env.db.select().from(collabUpdates).where(eq(collabUpdates.documentKey, key))).toEqual([])
  })

beforeAll(async () => {
  // Access is checked again often, so a test can see it end.
  env = await startTestApp({ COLLAB_ACCESS_CHECK_MS: '200' })
  baseUrl = (await env.app.listen({ port: 0, host: '127.0.0.1' })).replace('http', 'ws')
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  const member = await createLocalUser(env.db, 'member@example.com')
  adminCookie = await login(env.app, 'admin@example.com')
  memberCookie = await login(env.app, 'member@example.com')
  admin = trpc(env.app, adminCookie)
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: member.id })
}, 120_000)

afterAll(async () => {
  await env?.stop()
})

describe('collab documents', () => {
  it('makes a document from the draft and relays edits between two editors', async () => {
    const id = await createWorkflow('together')
    const key = `workflow:${id}`
    const a = await connect(adminCookie, key)
    expect(a.shared.value).toEqual(definition('return 1'))
    const b = await connect(adminCookie, key)
    a.edit('return 2')
    await vi.waitFor(() => expect(b.code()).toBe('return 2'))
    b.edit('return 2 + 3')
    await vi.waitFor(() => expect(a.code()).toBe('return 2 + 3'))
    const [doc] = await env.db.select().from(collabDocuments).where(eq(collabDocuments.key, key))
    expect(doc).toMatchObject({ workflowId: id })

    await a.close()
    await b.close()
    await settled(key)
    // Reopened from Postgres alone: the edits are there.
    const c = await connect(adminCookie, key)
    expect(c.code()).toBe('return 2 + 3')
    await c.close()
  })

  it('merges edits made offline when a peer reconnects', async () => {
    const key = `workflow:${await createWorkflow('offline', 'abc')}`
    const a = await connect(adminCookie, key)
    const b = await connect(adminCookie, key)
    // a goes offline, keeps typing; b types meanwhile.
    const kept = new Y.Doc()
    Y.applyUpdate(kept, Y.encodeStateAsUpdate(a.shared.doc))
    await a.close()
    const offline = new SharedDefinition<WorkflowDefinition>(kept, workflowSpec)
    const v = offline.value
    offline.set({
      ...v,
      blocks: v.blocks.map((x) => (x.type === 'code' ? { ...x, config: { code: 'abcX' } } : x)),
    })
    b.edit('Yabc')
    // a's new connection starts from what it kept.
    const again = await connect(adminCookie, key)
    Y.applyUpdate(again.shared.doc, Y.encodeStateAsUpdate(kept))
    await vi.waitFor(() => expect(b.code()).toBe('YabcX'))
    expect(again.code()).toBe('YabcX')
    await b.close()
    await again.close()
  })

  it('lets watchers read but not write, and keeps a protected draft read-only for everyone', async () => {
    const id = await createWorkflow('watched')
    const key = `workflow:${id}`
    data(
      await admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: id,
        groupId: memberGroupId,
        environmentId: null,
        level: 'use',
      }),
    )
    const editor = await connect(adminCookie, key)
    const watcher = await connect(memberCookie, key)
    // The watcher's browser keeps its own edit; nobody else gets it.
    watcher.edit('return "watcher"')
    editor.edit('return "editor"')
    await vi.waitFor(() => expect(watcher.code()).toContain('"editor"'))
    await new Promise((r) => setTimeout(r, 100))
    expect(editor.code()).toBe('return "editor"')
    await editor.close()
    await watcher.close()
    await settled(key)
    const fresh = await connect(adminCookie, key)
    expect(fresh.code()).toBe('return "editor"')
    await fresh.close()

    await env.db.update(workflows).set({ gitProtected: true }).where(eq(workflows.id, id))
    const protectedEditor = await connect(adminCookie, key)
    const other = await connect(adminCookie, key)
    protectedEditor.edit('return "protected"')
    await new Promise((r) => setTimeout(r, 100))
    expect(other.code()).toBe('return "editor"')
    await protectedEditor.close()
    await other.close()
  })

  it('shows presence with who people are, whatever their browser claims', async () => {
    const key = `workflow:${await createWorkflow('presence')}`
    const a = await connect(adminCookie, key)
    const b = await connect(adminCookie, key)
    a.awareness.setLocalState({ user: { id: 'someone-else', name: 'Mallory' }, selection: ['code1'] })
    await vi.waitFor(() =>
      expect(b.awareness.getStates().get(a.shared.doc.clientID)).toMatchObject({
        user: { name: 'admin' },
        selection: ['code1'],
      }),
    )
    // b can't speak for a's client id.
    const forged = new Awareness(new Y.Doc())
    forged.clientID = a.shared.doc.clientID
    // A newer clock than a's, so only the ownership check stops it.
    for (let i = 0; i < 5; i++) forged.setLocalState({ selection: ['forged'] })
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(e, encodeAwarenessUpdate(forged, [forged.clientID]))
    // Never shown to anyone, not even for a moment (a's browser would put its own state back at once).
    const seen: unknown[] = []
    const watch = (who: { awareness: Awareness }) =>
      who.awareness.on('change', () => seen.push(who.awareness.getStates().get(a.shared.doc.clientID)))
    watch(a)
    watch(b)
    b.ws.send(encoding.toUint8Array(e))
    await new Promise((r) => setTimeout(r, 100))
    expect(b.awareness.getStates().get(a.shared.doc.clientID)).toMatchObject({ selection: ['code1'] })
    expect(seen).not.toContainEqual(expect.objectContaining({ selection: ['forged'] }))
    // Leaving takes one's presence along.
    await a.close()
    await vi.waitFor(() => expect(b.awareness.getStates().has(a.shared.doc.clientID)).toBe(false))
    await b.close()
  })

  it('refuses other sites before the upgrade, and strangers and unknown drafts with a reason', async () => {
    const id = await createWorkflow('private')
    const inject = await env.app.inject({
      method: 'GET',
      url: `/api/collab/workflow:${id}`,
      headers: { cookie: adminCookie, origin: 'https://evil.example' },
    })
    expect(inject.statusCode).toBe(403)
    expect(await endedWith('', `workflow:${id}`)).toEqual({ code: 4403, reason: 'Not signed in' })
    const gone = { code: 4403, reason: 'This draft is gone, or you no longer have access to it' }
    expect(await endedWith(memberCookie, `workflow:${id}`)).toEqual(gone)
    expect(await endedWith(adminCookie, 'workflow:not-a-uuid')).toEqual(gone)
    expect(await endedWith(adminCookie, `app:${id}`)).toEqual(gone)
  })

  it('ends the connection when access goes or changes, with why', async () => {
    const id = await createWorkflow('revoked')
    const key = `workflow:${id}`
    const grant = (level: string | null) =>
      admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: id,
        groupId: memberGroupId,
        environmentId: null,
        level,
      })
    data(await grant('use'))
    const watcher = await connect(memberCookie, key)
    data(await grant(null))
    expect(await watcher.closed).toBe(4403)

    // Protected: an editor's draft turns read-only.
    const editor = await connect(adminCookie, key)
    await env.db.update(workflows).set({ gitProtected: true }).where(eq(workflows.id, id))
    expect(await editor.closedWith()).toEqual({
      code: 4403,
      reason: 'You can only view this draft now: reload',
    })
    await env.db.update(workflows).set({ gitProtected: false }).where(eq(workflows.id, id))

    // Signed out (in another tab, say), and the workflow deleted.
    const own = await login(env.app, 'admin@example.com')
    const signedIn = await connect(own, key)
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: own } })
    expect(await signedIn.closedWith()).toEqual({ code: 4403, reason: 'Not signed in' })
    const last = await connect(adminCookie, key)
    data(await admin.mutate('workflows.delete', { id }))
    expect((await last.closedWith()).code).toBe(4403)
  })

  it('edits a Git branch draft together, and folds in a pull from the branch', async () => {
    const id = await createWorkflow('on-a-branch')
    // A protected workflow's draft on a branch (M11), as opening one makes it.
    await env.db.update(workflows).set({ gitProtected: true }).where(eq(workflows.id, id))
    const [draft] = await env.db
      .insert(gitBranchDrafts)
      .values({
        workflowId: id,
        branch: 'feature',
        definition: definition('return "branch"'),
        name: 'on-a-branch',
        baseCommit: 'abc123',
        branchExists: true,
      })
      .returning()
    const key = `branch:${draft!.id}`
    const a = await connect(adminCookie, key)
    const b = await connect(adminCookie, key)
    expect(a.code()).toBe('return "branch"')
    a.edit('return "branch" + 1')
    await vi.waitFor(() => expect(b.code()).toBe('return "branch" + 1'))
    await vi.waitFor(
      async () => {
        const [row] = await env.db.select().from(gitBranchDrafts).where(eq(gitBranchDrafts.id, draft!.id))
        expect(row).toMatchObject({ revision: 2, definition: definition('return "branch" + 1') })
      },
      { timeout: 3000 },
    )

    // "Update from branch": the draft takes the branch's files, a revision on; both editors get it.
    await env.db
      .update(gitBranchDrafts)
      .set({ definition: definition('return "pulled"'), revision: 3 })
      .where(eq(gitBranchDrafts.id, draft!.id))
    await vi.waitFor(() => expect(a.code()).toBe('return "pulled"'))
    await vi.waitFor(() => expect(b.code()).toBe('return "pulled"'))
    await vi.waitFor(() => expect(a.status()).toEqual({ revision: 3, error: null }))
    await a.close()
    await b.close()
  })

  it('drops the document with its workflow', async () => {
    const id = await createWorkflow('deleted')
    const key = `workflow:${id}`
    const a = await connect(adminCookie, key)
    a.edit('return 9')
    await a.close()
    await settled(key)
    data(await admin.mutate('workflows.delete', { id }))
    expect(await env.db.select().from(collabDocuments).where(eq(collabDocuments.key, key))).toEqual([])
  })

  it('writes the document to the draft while edits flow and when the last person leaves', async () => {
    const id = await createWorkflow('written')
    const key = `workflow:${id}`
    const draft = async () => (await env.db.select().from(workflows).where(eq(workflows.id, id)))[0]!
    const a = await connect(adminCookie, key)
    expect(a.status()).toEqual({ revision: 2, error: null })
    a.edit('return "flowing"')
    // At most a second later, the draft has it, a revision on.
    await vi.waitFor(async () => expect((await draft()).draftRevision).toBe(3), { timeout: 3000 })
    expect((await draft()).draftDefinition).toEqual(definition('return "flowing"'))
    await vi.waitFor(() => expect(a.status()).toEqual({ revision: 3, error: null }))
    // Leaving writes at once, without waiting for the second.
    a.edit('return "leaving"')
    await a.close()
    await vi.waitFor(async () =>
      expect((await draft()).draftDefinition).toEqual(definition('return "leaving"')),
    )
    expect((await draft()).draftRevision).toBe(4)
    const [admin] = await env.db.select().from(collabDocuments).where(eq(collabDocuments.key, key))
    expect(admin?.revision).toBe(4)
  })

  it("doesn't write a merged document the schema refuses, and says why", async () => {
    const id = await createWorkflow('refused')
    const key = `workflow:${id}`
    const a = await connect(adminCookie, key)
    a.shared.root.set('schemaVersion', 2)
    await vi.waitFor(() => expect(a.status()?.error).toMatch(/schemaVersion/), { timeout: 3000 })
    const [stored] = await env.db.select().from(workflows).where(eq(workflows.id, id))
    expect(stored?.draftRevision).toBe(2)
    a.shared.root.set('schemaVersion', 1)
    a.edit('return "fixed"')
    await vi.waitFor(() => expect(a.status()).toEqual({ revision: 3, error: null }), { timeout: 3000 })
    await a.close()
  })

  it('folds a draft saved some other way into the open document, and into a closed one', async () => {
    const id = await createWorkflow('folded', 'return 1')
    const key = `workflow:${id}`
    const a = await connect(adminCookie, key)
    const b = await connect(adminCookie, key)
    // An old tab or an API client saves the whole draft.
    data(
      await admin.mutate('workflows.saveDraft', { id, revision: 2, definition: definition('return "rest"') }),
    )
    await vi.waitFor(() => expect(a.code()).toBe('return "rest"'))
    await vi.waitFor(() => expect(b.code()).toBe('return "rest"'))
    await vi.waitFor(() => expect(a.status()).toEqual({ revision: 3, error: null }))
    // Folded once: the text isn't doubled by two rooms' worth of edits, and editing carries on from there.
    b.edit('return "rest" + 1')
    await vi.waitFor(() => expect(a.code()).toBe('return "rest" + 1'))
    await a.close()
    await b.close()
    await settled(key)
    const [stored] = await env.db.select().from(workflows).where(eq(workflows.id, id))
    expect(stored).toMatchObject({ draftRevision: 4, draftDefinition: definition('return "rest" + 1') })

    // Saved while nobody has it open: the next one to open it sees the save.
    data(
      await admin.mutate('workflows.saveDraft', {
        id,
        revision: 4,
        definition: definition('return "closed"'),
      }),
    )
    const c = await connect(adminCookie, key)
    expect(c.code()).toBe('return "closed"')
    expect(c.status()).toEqual({ revision: 5, error: null })
    await c.close()
  })
})

/** Another API process on the same database, as Compose runs two. */
async function secondProcess() {
  const { db, sql, close } = createDb(env.databaseUrl, { max: 5 })
  const app = await buildApp({ db, config: env.config, logger: false, listener: sql })
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace('http', 'ws')
  return {
    url,
    stop: async () => {
      await app.close()
      await close()
    },
  }
}

describe('collab documents across API processes', () => {
  let other: Awaited<ReturnType<typeof secondProcess>>
  beforeAll(async () => {
    other = await secondProcess()
  })
  afterAll(async () => {
    await other?.stop()
  })

  it('relays edits both ways, and the draft gets them all', async () => {
    const id = await createWorkflow('two-processes', 'abc')
    const key = `workflow:${id}`
    const a = await connect(adminCookie, key)
    const b = await connect(adminCookie, key, other.url)
    a.edit('Xabc')
    await vi.waitFor(() => expect(b.code()).toBe('Xabc'))
    b.edit('XabcY')
    await vi.waitFor(() => expect(a.code()).toBe('XabcY'))
    // Typed at the same time on both sides: merged alike.
    a.edit('1XabcY')
    b.edit('XabcY2')
    await vi.waitFor(() => expect(a.code()).toBe('1XabcY2'))
    await vi.waitFor(() => expect(b.code()).toBe('1XabcY2'))
    await a.close()
    await b.close()
    await settled(key)
    const [stored] = await env.db.select().from(workflows).where(eq(workflows.id, id))
    expect(stored?.draftDefinition).toEqual(definition('1XabcY2'))
  })

  it('shows presence from the other process, including people there before the room opened here', async () => {
    const id = await createWorkflow('presence-across')
    const key = `workflow:${id}`
    // A watcher has presence too.
    data(
      await admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: id,
        groupId: memberGroupId,
        environmentId: null,
        level: 'use',
      }),
    )
    const a = await connect(adminCookie, key)
    a.awareness.setLocalState({ selection: ['code1'] })
    await new Promise((r) => setTimeout(r, 100))
    const b = await connect(memberCookie, key, other.url)
    await vi.waitFor(() =>
      expect(b.awareness.getStates().get(a.shared.doc.clientID)).toMatchObject({
        user: { name: 'admin' },
        selection: ['code1'],
      }),
    )
    b.awareness.setLocalState({ selection: ['startTrigger'] })
    await vi.waitFor(() =>
      expect(a.awareness.getStates().get(b.shared.doc.clientID)).toMatchObject({ user: { name: 'member' } }),
    )
    // b can't speak for a's client id from the other process either.
    const forged = new Awareness(new Y.Doc())
    forged.clientID = a.shared.doc.clientID
    // A newer clock than a's, so only the ownership check stops it.
    for (let i = 0; i < 5; i++) forged.setLocalState({ selection: ['forged'] })
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(e, encodeAwarenessUpdate(forged, [forged.clientID]))
    // Never shown to anyone, not even for a moment (a's browser would put its own state back at once).
    const seen: unknown[] = []
    const watch = (who: { awareness: Awareness }) =>
      who.awareness.on('change', () => seen.push(who.awareness.getStates().get(a.shared.doc.clientID)))
    watch(a)
    watch(b)
    b.ws.send(encoding.toUint8Array(e))
    await new Promise((r) => setTimeout(r, 200))
    expect(a.awareness.getStates().get(a.shared.doc.clientID)).toMatchObject({ selection: ['code1'] })
    expect(b.awareness.getStates().get(a.shared.doc.clientID)).toMatchObject({ selection: ['code1'] })
    expect(seen).not.toContainEqual(expect.objectContaining({ selection: ['forged'] }))
    await a.close()
    await vi.waitFor(() => expect(b.awareness.getStates().has(a.shared.doc.clientID)).toBe(false))
    await b.close()
  })

  it('folds a REST save once, with the document open in both processes', async () => {
    const id = await createWorkflow('fold-across', 'return 1')
    const key = `workflow:${id}`
    const a = await connect(adminCookie, key)
    const b = await connect(adminCookie, key, other.url)
    data(
      await admin.mutate('workflows.saveDraft', { id, revision: 2, definition: definition('return "rest"') }),
    )
    await vi.waitFor(() => expect(a.code()).toBe('return "rest"'))
    await vi.waitFor(() => expect(b.code()).toBe('return "rest"'))
    await vi.waitFor(() => expect(a.status()).toEqual({ revision: 3, error: null }))
    await vi.waitFor(() => expect(b.status()).toEqual({ revision: 3, error: null }))
    await new Promise((r) => setTimeout(r, 300))
    expect(a.code()).toBe('return "rest"')
    expect(b.code()).toBe('return "rest"')
    await a.close()
    await b.close()
  })
})

/** M16 review: the store's reads and loads against compactions and other processes, and presence ids freed. */
describe('collab store and rooms', () => {
  const targetOf = async (key: string) => {
    const [user] = await env.db.select().from(users).where(eq(users.email, 'admin@example.com'))
    const session = {
      id: user!.id,
      email: user!.email,
      name: user!.name,
      avatarUrl: null,
      isAdmin: true,
      sessionId: 's',
    }
    return (await resolveTarget(env.db, session, key))!
  }

  it('reads a document under its lock, so a compaction never falls between its two queries', async () => {
    const id = await createWorkflow('read-locked')
    const key = `workflow:${id}`
    const store = new CollabStore(env.db)
    await store.load(await targetOf(key), 'test')
    const { sql, close } = createDb(env.databaseUrl, { max: 1 })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const locked = new Promise<void>((resolve) => {
      void sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`collab:${key}`}))`
        resolve()
        await held
      })
    })
    await locked
    let read = false
    const reading = store.read(key).then((updates) => {
      read = true
      return updates
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(read).toBe(false)
    release()
    expect((await reading).length).toBeGreaterThan(0)
    await close()
  })

  it('announces a draft folded in on load, so rooms open in other processes get it', async () => {
    const id = await createWorkflow('load-announces', 'return 1')
    const key = `workflow:${id}`
    const store = new CollabStore(env.db)
    await store.load(await targetOf(key), 'test')
    const { sql, close } = createDb(env.databaseUrl, { max: 1 })
    const heard: { d: string; u?: number; p?: string }[] = []
    await sql.listen(COLLAB_CHANNEL, (payload) => heard.push(JSON.parse(payload)))
    data(
      await admin.mutate('workflows.saveDraft', { id, revision: 2, definition: definition('return "rest"') }),
    )
    const loaded = await store.load(await targetOf(key), 'loader')
    expect(loaded.revision).toBe(3)
    expect(loaded.draft).toEqual(definition('return "rest"'))
    await vi.waitFor(() => expect(heard).toContainEqual({ d: key, u: expect.any(Number), p: 'loader' }))
    await close()
  })

  it('writes a stored document ahead of its draft once it opens again (a write lost, a process gone)', async () => {
    const id = await createWorkflow('ahead-of-draft', 'return 1')
    const key = `workflow:${id}`
    const store = new CollabStore(env.db)
    const { updates } = await store.load(await targetOf(key), 'test')
    // An edit stored by a process that went before writing it to the draft.
    const doc = new Y.Doc()
    for (const u of updates) Y.applyUpdate(doc, u)
    const shared = new SharedDefinition<WorkflowDefinition>(doc, workflowSpec)
    let edit: Uint8Array | null = null
    doc.on('update', (u: Uint8Array) => {
      edit = u
    })
    shared.set(definition('return "unwritten"'))
    await store.append(key, edit!, 'gone')
    const a = await connect(adminCookie, key)
    expect(a.code()).toBe('return "unwritten"')
    await vi.waitFor(async () => {
      const [stored] = await env.db.select().from(workflows).where(eq(workflows.id, id))
      expect(stored?.draftDefinition).toEqual(definition('return "unwritten"'))
      // (Written after the room's one-second wait for more edits.)
    }, 5000)
    await a.close()
  })

  it('lets a peer claim a presence id again once another process stopped renewing it', async () => {
    const id = await createWorkflow('presence-freed')
    const key = `workflow:${id}`
    const store = new CollabStore(env.db)
    const room = new CollabRoom(await targetOf(key), store, env.app.log, () => {}, 'test')
    // Someone on another process (now gone) spoke for client id 42.
    const elsewhere = new Awareness(new Y.Doc())
    elsewhere.clientID = 42
    // (Twice: a new client id's first clock is 0, which counts as nothing new.)
    elsewhere.setLocalState({ selection: ['code1'] })
    elsewhere.setLocalState({ selection: ['code1'] })
    room.relayedPresence(encodeAwarenessUpdate(elsewhere, [42]))
    // Their tab reconnects here with the same client id.
    const peer: CollabPeer = {
      user: { id: 'u', name: 'back', avatarUrl: null },
      readOnly: false,
      send: () => {},
      close: () => {},
    }
    room.add(peer)
    const claim = () => {
      elsewhere.setLocalState({ selection: ['startTrigger'] })
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(e, encodeAwarenessUpdate(elsewhere, [42]))
      room.receive(peer, encoding.toUint8Array(e))
    }
    claim()
    // Still spoken for elsewhere: refused.
    expect(room.awareness.getStates().get(42)).toMatchObject({ selection: ['code1'] })
    // 30 s without a renewal from there: y-protocols removes it as timed out.
    removeAwarenessStates(room.awareness, [42], 'timeout')
    claim()
    expect(room.awareness.getStates().get(42)).toMatchObject({
      selection: ['startTrigger'],
      user: { name: 'back' },
    })
    room.destroy()
    elsewhere.destroy()
  })
})
