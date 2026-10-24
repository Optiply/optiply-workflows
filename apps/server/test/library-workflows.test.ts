/**
 * Library queries in workflows (M21 step 2b): Library query blocks run their release with the run's parameters and
 * `current_user` (whoever started the run, inherited by child runs); a draft run needs Use on the library query (not
 * on its resource), and so does releasing; the library query lists the workflows using it and can't be deleted while
 * they do. Queries go to the built-in optiply_db.
 */
import { createDb } from '@ow/db'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let memberCookie: string
let memberGroupId: string
let libraryId: string
let stopWorker: () => Promise<void>

type Res = {
  status: number
  body: { result?: { data: unknown }; error?: { message: string; data?: { code: string } } }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}
const failure = (res: Res) => ({ code: res.body.error?.data?.code, message: res.body.error?.message })

async function rest(cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie },
    ...(payload !== undefined && { payload: payload as object }),
  })
  return { status: res.statusCode, body: res.json() }
}

async function waitForRun(id: string) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const { body } = await rest(adminCookie, 'GET', `/runs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
    if (Date.now() > deadline) throw new Error(`run ${id} still ${body.run.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function run(cookie: string, slug: string, input: unknown = {}) {
  const started = await rest(cookie, 'POST', `/workflows/${slug}/runs?environment=production`, { input })
  if (started.status !== 202) return { refused: started }
  return { run: await waitForRun(started.body.run.id), id: started.body.run.id as string }
}

/** A workflow whose draft is `blocks` after the start trigger, in a line, the last one's data as the response. */
async function workflow(client: ReturnType<typeof trpc>, slug: string, blocks: object[]) {
  const created = data(await client.mutate('workflows.create', { slug, name: slug }))
  const names = ['startTrigger', ...blocks.map((b) => (b as { name: string }).name)]
  const last = names[names.length - 1]
  const saved = data(
    await client.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          ...blocks,
          { name: 'reply', type: 'response', config: { body: `{{ ${last}.data }}` } },
        ],
        edges: [...names, 'reply'].slice(1).map((to, i) => ({ from: names[i] ?? 'reply', port: 'out', to })),
      },
    }),
  )
  return { id: created.id as string, revision: saved.revision as number }
}

const libraryBlock = (name: string, version: string, params: Record<string, string> = {}) => ({
  name,
  type: 'libraryQuery',
  config: { library: 'customer_label', version, params },
})

const grant = (objectType: string, objectId: string | null, level: 'use' | 'edit' | null) =>
  admin.mutate('permissions.set', {
    objectType,
    objectId,
    groupId: memberGroupId,
    environmentId: null,
    level,
  })

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, memberCookie)
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
  // The member may make and edit workflows, and has nothing on optiply_db.
  await grant('workflow', null, 'edit')

  const created = data(await admin.mutate('libraryQueries.create', { slug: 'customer_label', name: 'Label' }))
  libraryId = created.id
  const saved = data(
    await admin.mutate('libraryQueries.saveDraft', {
      id: libraryId,
      revision: 1,
      definition: {
        schemaVersion: 1,
        resource: 'optiply_db',
        query: {
          sql: 'select {{ id }}::int as id, {{ current_user ? current_user.email : null }}::text as who',
        },
        params: [{ name: 'id' }],
      },
    }),
  )
  data(
    await admin.mutate('libraryQueries.publish', {
      libraryQueryId: libraryId,
      draftRevision: saved.revision,
    }),
  )

  const workerDb = createDb(env.databaseUrl, { max: 5 })
  const worker = await startWorker({
    db: workerDb.db,
    sql: workerDb.sql,
    config: env.config,
    log: pino({ level: 'silent' }),
  })
  stopWorker = async () => {
    await worker.stop()
    await workerDb.close()
  }
}, 60_000)
afterAll(async () => {
  await stopWorker?.()
  await env?.stop()
})

describe('Library query blocks', () => {
  it('run the release with the parameters and the person who ran the draft as current_user', async () => {
    await workflow(admin, 'label-one', [
      libraryBlock('library1', '1.0.0', { id: '{{ startTrigger.data.n }}' }),
    ])
    const result = await run(adminCookie, 'label-one', { n: 7 })
    expect(result.run).toMatchObject({
      status: 'succeeded',
      response: { body: [{ id: 7, who: 'admin@optiply.nl' }] },
    })
    const block = await rest(adminCookie, 'GET', `/runs/${result.id}/blocks/library1`)
    expect(block.body.block.metadata).toMatchObject({
      resource: 'optiply_db',
      library: { slug: 'customer_label', version: '1.0.0' },
    })
  })

  it('give a child run the same current_user as its parent', async () => {
    const child = await workflow(admin, 'label-child', [libraryBlock('library1', 'latest', { id: '1' })])
    data(await admin.mutate('releases.publish', { workflowId: child.id, draftRevision: child.revision }))
    await workflow(admin, 'label-parent', [
      { name: 'call', type: 'workflow', config: { workflow: 'label-child' } },
    ])
    // The child's release was vouched for by whoever published it: the member needs nothing on the library query.
    const done = await run(memberCookie, 'label-parent')
    expect(done.run).toMatchObject({
      status: 'succeeded',
      response: { body: [{ id: 1, who: 'member@optiply.nl' }] },
    })
  })

  it('need Use on the library query, not its resource, to run a draft or release', async () => {
    const wf = await workflow(member, 'label-member', [libraryBlock('library1', 'latest', { id: '3' })])
    const refused = await run(memberCookie, 'label-member')
    expect(refused.refused).toMatchObject({ status: 403 })
    expect(refused.refused!.body.error.message).toBe(
      'You need use access to library query "customer_label" to run this draft, which uses it',
    )
    expect(
      failure(await member.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision })),
    ).toEqual({
      code: 'FORBIDDEN',
      message:
        'You need use access to library query "customer_label" to release this workflow, which uses it',
    })

    await grant('library_query', libraryId, 'use')
    const done = await run(memberCookie, 'label-member')
    expect(done.run).toMatchObject({
      status: 'succeeded',
      response: { body: [{ id: 3, who: 'member@optiply.nl' }] },
    })
    data(await member.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision }))
    await grant('library_query', libraryId, null)
  })

  it('refuse a release that does not exist', async () => {
    await workflow(admin, 'label-gone', [libraryBlock('library1', '9.0.0')])
    const result = await run(adminCookie, 'label-gone')
    expect(result.refused).toMatchObject({ status: 400 })
    expect(result.refused!.body.error.message).toBe(
      'The workflow isn\'t valid: Library query "customer_label" has no release 9.0.0',
    )
  })
})

describe('publishing a release that drops a parameter (M21)', () => {
  it('lists those on latest still passing it, and only those', async () => {
    const query = data(await admin.query('libraryQueries.get', { id: libraryId }))
    // Nothing dropped yet.
    expect(data(await admin.query('libraryQueries.publishImpact', { libraryQueryId: libraryId }))).toEqual({
      dropped: [],
      uses: [],
      hidden: 0,
    })
    const saved = data(
      await admin.mutate('libraryQueries.saveDraft', {
        id: libraryId,
        revision: query.draftRevision,
        definition: { ...query.draftDefinition, query: { sql: 'select 1 as id' }, params: [] },
      }),
    )
    const impact = data(await admin.query('libraryQueries.publishImpact', { libraryQueryId: libraryId }))
    expect(impact.dropped).toEqual(['id'])
    // label-one pins 1.0.0 and label-gone names a release that doesn't exist: neither follows latest.
    expect(impact.uses.map((u: { slug: string; passes: string[] }) => [u.slug, u.passes]).sort()).toEqual([
      ['label-child', ['id']],
      ['label-member', ['id']],
    ])
    expect(impact.hidden).toBe(0)
    // Putting it back clears the warning.
    data(
      await admin.mutate('libraryQueries.saveDraft', {
        id: libraryId,
        revision: saved.revision,
        definition: query.draftDefinition,
      }),
    )
    expect(
      data(await admin.query('libraryQueries.publishImpact', { libraryQueryId: libraryId })).uses,
    ).toEqual([])
  })
})

describe('the library query', () => {
  it('tells someone who may not use it so, and nothing more', async () => {
    expect(data(await member.query('libraryQueries.resolve', { slugs: ['customer_label', 'nope'] }))).toEqual(
      {
        customer_label: { liveVersion: null, versions: {}, noUse: true },
      },
    )
  })

  it('lists the workflows using it and refuses to be deleted while they do', async () => {
    const used = data(await admin.query('libraryQueries.usedBy', { libraryQueryId: libraryId }))
    expect(used.workflows.map((w: { slug: string }) => w.slug).sort()).toEqual([
      'label-child',
      'label-gone',
      'label-member',
      'label-one',
    ])
    expect(used.workflows.find((w: { slug: string }) => w.slug === 'label-child').where).toEqual([
      'draft',
      'live',
    ])
    const refused = failure(await admin.mutate('libraryQueries.delete', { id: libraryId }))
    expect(refused.code).toBe('CONFLICT')
    expect(refused.message).toMatch(/^Workflows use this library query: "label-/)
  })
})
