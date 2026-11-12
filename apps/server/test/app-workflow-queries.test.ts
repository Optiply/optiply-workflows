import { workflowRuns } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * Apps' "Run workflow" queries (M36): the workflow's live release runs as the person using the app, its Response
 * block's body is the query's data; async gives the run's id. Publishing vouches for the workflow.
 */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let prodId: string
let memberGroupId: string

type Res = {
  status: number
  body: { result?: { data: unknown }; error?: { message: string; data?: { code?: string } } }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}
const failure = (res: Res) => res.body.error

/** A published workflow answering `{ doubled: n * 2 }` (or failing when `fail`). */
async function workflow(slug: string, opts: { fail?: boolean; publish?: boolean } = {}) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          {
            name: 'double',
            type: 'code',
            config: {
              code: opts.fail ? 'throw new Error("nope")' : 'return { doubled: startTrigger.data.n * 2 }',
            },
          },
          { name: 'reply', type: 'response', config: { body: '{{ double.data }}' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'double' },
          { from: 'double', port: 'out', to: 'reply' },
        ],
      },
    }),
  )
  if (opts.publish !== false) {
    data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
  }
  return created.id as string
}

const runQuery = (
  client: ReturnType<typeof trpc>,
  appId: string,
  query: string,
  values = {},
  releaseId: string | null = null,
) => client.mutate('apps.runQuery', { appId, releaseId, query, environmentId: prodId, values })

const wfQuery = (name: string, slug: string, extra: object = {}) => ({
  name,
  kind: 'workflow',
  workflow: slug,
  input: '{"n": {{ amount.value }}}',
  run: 'manual',
  ...extra,
})

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Users' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
  await workflow('doubler')
  await workflow('broken', { fail: true })
  await workflow('drafty', { publish: false })
})

afterAll(async () => {
  await env?.stop()
})

describe('apps: workflow queries', () => {
  let appId: string
  let releaseId: string

  it('runs the live release and answers with its Response body, or its run id (async)', async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'runs-workflows', name: 'Runs workflows' }))
    appId = app.id
    const saved = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [{ name: 'amount', type: 'numberInput', props: { defaultValue: 21 } }],
          queries: [
            wfQuery('double', 'doubler'),
            wfQuery('later', 'doubler', { mode: 'async' }),
            wfQuery('fails', 'broken'),
          ],
          layout: { amount: { x: 0, y: 0, w: 4, h: 3 } },
        },
      }),
    )
    const sync = data(await runQuery(admin, app.id, 'double', { ' amount.value ': 21 }))
    expect(sync).toMatchObject({
      ok: true,
      data: { doubled: 42 },
      metadata: { workflow: 'doubler', responseStatus: 200 },
    })
    const [run] = await env.db.select().from(workflowRuns).where(eq(workflowRuns.id, sync.metadata.runId))
    expect(run).toMatchObject({ triggerType: 'app', input: { data: { n: 21 } } })

    const async = data(await runQuery(admin, app.id, 'later', { ' amount.value ': 1 }))
    expect(async).toMatchObject({ ok: true, data: { runId: expect.any(String) } })

    const failed = data(await runQuery(admin, app.id, 'fails', { ' amount.value ': 1 }))
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: 'query',
        message: expect.stringContaining('nope'),
        details: { reason: 'workflow_failed' },
      },
    })

    releaseId = data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: saved.revision })).id
    const live = data(await runQuery(admin, app.id, 'double', { ' amount.value ': 5 }, releaseId))
    expect(live).toMatchObject({ ok: true, data: { doubled: 10 } })
  })

  it('lets Use on the app run the live release, and asks for Use on the workflow to run the draft', async () => {
    await admin.mutate('permissions.set', {
      objectType: 'app',
      objectId: appId,
      groupId: memberGroupId,
      environmentId: null,
      level: 'edit',
    })
    const live = data(await runQuery(member, appId, 'double', { ' amount.value ': 2 }, releaseId))
    expect(live).toMatchObject({ ok: true, data: { doubled: 4 } })
    expect(failure(await runQuery(member, appId, 'double', { ' amount.value ': 2 }))).toMatchObject({
      message: expect.stringContaining('use access to workflow "doubler"'),
    })
  })

  it("refuses to publish an app running a workflow that isn't published", async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'runs-drafts', name: 'Runs drafts' }))
    const saved = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [wfQuery('q', 'drafty', { input: '{}' })],
          layout: {},
        },
      }),
    )
    expect(
      failure(await admin.mutate('apps.publish', { appId: app.id, draftRevision: saved.revision })),
    ).toMatchObject({
      message: expect.stringContaining(`Workflow "drafty" isn't published`),
    })
    const draft = data(await runQuery(admin, app.id, 'q'))
    expect(draft).toMatchObject({ ok: false, error: { details: { reason: 'not_published' } } })
  })
})
