import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// Session 33: duplicating a workflow (its draft, every trigger off) and deleting one (refused while another calls it).

let env: TestEnv
let admin: ReturnType<typeof trpc>

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

async function workflow(slug: string, blocks: object[], triggers?: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: `Workflow ${slug}` }))
  data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
        edges: [],
        ...(triggers && { triggers }),
      },
    }),
  )
  return created.id as string
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@example.com'))
})

afterAll(async () => {
  await env?.stop()
})

describe('duplicating a workflow', () => {
  it('copies the draft under a new slug and name, with every trigger turned off', async () => {
    const id = await workflow('nightly', [{ name: 'hello', type: 'code', config: { code: 'return 1' } }], {
      schedules: [{ name: 'night', enabled: true, cron: '0 2 * * *' }],
    })
    await admin.mutate('workflows.update', { id, description: 'Runs at night', maxConcurrentRuns: 2 })
    const copy = data(
      await admin.mutate('workflows.duplicate', { id, slug: 'nightly-copy', name: 'Nightly (copy)' }),
    )
    expect(copy).toMatchObject({ slug: 'nightly-copy', name: 'Nightly (copy)' })
    const got = data(await admin.query('workflows.get', { id: copy.id }))
    expect(got.draftDefinition.blocks.map((b: { name: string }) => b.name)).toEqual(['startTrigger', 'hello'])
    expect(got.draftDefinition.triggers.schedules).toEqual([
      { name: 'night', enabled: false, cron: '0 2 * * *' },
    ])
    expect(got).toMatchObject({ description: 'Runs at night', maxConcurrentRuns: 2, liveRelease: null })

    const taken = await admin.mutate('workflows.duplicate', { id, slug: 'nightly-copy', name: 'Again' })
    expect(taken.body.error?.message).toBe('A workflow with that slug already exists')
  })
})

describe('deleting a workflow', () => {
  it('is refused while another workflow calls it, and works once nothing does', async () => {
    const child = await workflow('child', [])
    const parent = await workflow('parent', [
      { name: 'call', type: 'workflow', config: { workflow: 'child' } },
    ])
    const refused = await admin.mutate('workflows.delete', { id: child })
    expect(refused.status).toBe(409)
    expect(refused.body.error?.message).toContain('Workflow parent')

    data(await admin.mutate('workflows.delete', { id: parent }))
    data(await admin.mutate('workflows.delete', { id: child }))
    const list = data(await admin.query('workflows.list'))
    expect(list.map((w: { slug: string }) => w.slug)).not.toContain('child')
  })
})
