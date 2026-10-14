import { createDb, workflowRuns } from '@ow/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const PG_SECRET = 'Wf-Reader-Secret-5521'
const TOKEN_SECRET = 'Wf-Token-Secret-8830'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let memberCookie: string
let memberGroupId: string
let prodId: string
let resourceId: string
let stopWorker: () => Promise<void>

/** A REST call to the runs API. */
async function rest(cookie: string | undefined, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined && { payload: payload as object }),
  })
  return { status: res.statusCode, body: res.json() }
}

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

async function waitForRun(id: string, cookie = adminCookie) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const { body } = await rest(cookie, 'GET', `/runs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
    if (Date.now() > deadline) throw new Error(`run ${id} still ${body.run.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Creates a workflow and saves `definition` as its draft. */
async function workflowWith(slug: string, blocks: object[], edges: [string, string, string?][]) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = await admin.mutate('workflows.saveDraft', {
    id: created.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges: edges.map(([from, to, port = 'out']) => ({ from, port, to })),
    },
  })
  return { id: created.id as string, slug, revision: data(saved).revision as number }
}

const query = (name: string, sql: string) => ({
  name,
  type: 'resourceQuery',
  config: { resource: 'warehouse', query: { sql } },
})
const code = (name: string, src: string) => ({ name, type: 'code', config: { code: src } })

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, memberCookie)

  const sql = postgres(env.databaseUrl, { onnotice: () => {} })
  await sql.unsafe(`
    create table orders (id int primary key, customer text, amount int);
    insert into orders values (1, 'acme', 100), (2, 'globex', 250);
    create role wf_reader login password '${PG_SECRET}';
    grant select on orders to wf_reader;
  `)
  await sql.end()

  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  const url = new URL(env.databaseUrl)
  resourceId = data(
    await admin.mutate('resources.create', { type: 'postgres', name: 'Warehouse', slug: 'warehouse' }),
  ).id
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId,
      environmentId: prodId,
      config: {
        host: url.hostname,
        port: Number(url.port),
        database: url.pathname.slice(1),
        user: 'wf_reader',
        ssl: 'disable',
      },
      secrets: { password: PG_SECRET },
    }),
  )
  const region = data(await admin.mutate('configVars.create', { name: 'REGION' }))
  await admin.mutate('configVars.setValue', {
    configVarId: region.id,
    environmentId: prodId,
    value: 'eu-west',
  })
  const token = data(await admin.mutate('configVars.create', { name: 'TOKEN', isSecret: true }))
  await admin.mutate('configVars.setValue', {
    configVarId: token.id,
    environmentId: prodId,
    value: TOKEN_SECRET,
  })

  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })

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
})
afterAll(async () => {
  await stopWorker?.()
  await env?.stop()
})

describe('workflows API', () => {
  it('creates a workflow with a start trigger and saves drafts with optimistic concurrency', async () => {
    const created = data(await admin.mutate('workflows.create', { slug: 'draft-test', name: 'Draft test' }))
    expect(created).toMatchObject({ slug: 'draft-test', level: 'own', liveReleaseId: null })
    const got = data(await admin.query('workflows.get', { id: created.id }))
    expect(got.draftRevision).toBe(1)
    expect(got.draftDefinition.blocks).toEqual([{ name: 'startTrigger', type: 'startTrigger' }])

    // An invalid-but-well-formed draft saves, with its diagnostics.
    const definition = {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, code('a', 'return b.data')],
      edges: [{ from: 'startTrigger', port: 'out', to: 'a' }],
    }
    const saved = data(await admin.mutate('workflows.saveDraft', { id: created.id, revision: 1, definition }))
    expect(saved.revision).toBe(2)
    expect(saved.diagnostics).toEqual([expect.objectContaining({ code: 'unknown_identifier', block: 'a' })])

    const stale = await admin.mutate('workflows.saveDraft', { id: created.id, revision: 1, definition })
    expect(stale.status).toBe(409)
    const malformed = await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 2,
      definition: { schemaVersion: 1, blocks: [{ name: 'x', type: 'teleport' }], edges: [] },
    })
    expect(malformed.status).toBe(400)

    expect((await admin.mutate('workflows.create', { slug: 'draft-test', name: 'Again' })).status).toBe(409)
    expect((await admin.mutate('workflows.create', { slug: 'Not A Slug', name: 'X' })).status).toBe(400)
  })

  it('needs edit access to all workflows to create one', async () => {
    expect((await member.mutate('workflows.create', { slug: 'nope', name: 'Nope' })).status).toBe(403)
  })
})

describe('runs API', () => {
  it('runs a draft end to end and exposes the run, its blocks, data and logs', async () => {
    const wf = await workflowWith(
      'order-lookup',
      [
        query('order', 'select customer, amount from orders where id = {{ startTrigger.data.id }}'),
        code(
          'shape',
          'console.log("region", configVars.REGION, "token", typeof configVars.TOKEN); return { customer: order.data[0].customer, cents: order.data[0].amount * 100 }',
        ),
        { name: 'reply', type: 'response', config: { status: '201', body: '{{ shape.data }}' } },
      ],
      [
        ['startTrigger', 'order'],
        ['order', 'shape'],
        ['shape', 'reply'],
      ],
    )
    const started = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, { input: { id: 2 } })
    expect(started.status).toBe(202)
    expect(started.body.run).toMatchObject({ status: 'queued', version: 'draft', environment: 'production' })

    const run = await waitForRun(started.body.run.id)
    expect(run).toMatchObject({
      status: 'succeeded',
      input: { data: { id: 2 } },
      response: { status: 201, headers: {}, body: { customer: 'globex', cents: 25000 } },
      error: null,
    })

    const { body: blocks } = await rest(adminCookie, 'GET', `/runs/${run.id}/blocks`)
    expect(
      blocks.blocks.map((b: { key: string; status: string; port: string }) => [b.key, b.status, b.port]),
    ).toEqual([
      ['startTrigger', 'succeeded', 'out'],
      ['order', 'succeeded', 'out'],
      ['shape', 'succeeded', 'out'],
      ['reply', 'succeeded', 'out'],
    ])
    const { body: order } = await rest(adminCookie, 'GET', `/runs/${run.id}/blocks/order`)
    expect(order.block).toMatchObject({ key: 'order', data: [{ customer: 'globex', amount: 250 }] })
    expect(order.block.metadata).toMatchObject({ rowCount: 1, resource: 'warehouse' })

    // Draft runs don't see secret config vars (like the playground).
    let logs = { logs: [] as { message: string }[] }
    for (let i = 0; i < 40 && !logs.logs.length; i++) {
      logs = (await rest(adminCookie, 'GET', `/runs/${run.id}/logs`)).body
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(logs.logs.map((l) => l.message)).toEqual(['region eu-west token undefined'])

    const { body: list } = await rest(adminCookie, 'GET', `/workflows/${wf.slug}/runs`)
    expect(list.runs.map((r: { id: string }) => r.id)).toEqual([run.id])
  })

  it('scrubs secret config var values from logs, whatever their source', async () => {
    const wf = await workflowWith(
      'echo',
      [code('echo', 'console.log("got", startTrigger.data); return 1')],
      [['startTrigger', 'echo']],
    )
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, { input: TOKEN_SECRET })
    const run = await waitForRun(body.run.id)
    let logs: { message: string }[] = []
    for (let i = 0; i < 40 && !logs.length; i++) {
      logs = (await rest(adminCookie, 'GET', `/runs/${run.id}/logs`)).body.logs
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(logs.map((l) => l.message)).toEqual(['got [REDACTED]'])
  })

  it('runs loops and functions that query resources, listing iterations apart from blocks', async () => {
    const created = data(await admin.mutate('workflows.create', { slug: 'loop-orders', name: 'loop-orders' }))
    data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'each',
              type: 'loop',
              config: {
                input: '{{ [1, 2] }}',
                runner: {
                  kind: 'query',
                  resource: 'warehouse',
                  query: { sql: 'select amount from orders where id = {{ value }}' },
                },
              },
            },
            { name: 'named', type: 'function', config: { function: 'customer', params: { id: '{{ 2 }}' } } },
          ],
          edges: [
            { from: 'startTrigger', port: 'out', to: 'each' },
            { from: 'startTrigger', port: 'out', to: 'named' },
          ],
          functions: [
            {
              name: 'customer',
              params: [{ name: 'id' }],
              blocks: [query('q', 'select customer from orders where id = {{ params.id }}')],
              edges: [],
            },
          ],
        },
      }),
    )
    const started = await rest(adminCookie, 'POST', '/workflows/loop-orders/runs', {})
    const run = await waitForRun(started.body.run.id)
    expect(run.status).toBe('succeeded')
    const { body } = await rest(adminCookie, 'GET', `/runs/${run.id}/blocks`)
    expect(body.blocks.map((b: { key: string }) => b.key).sort()).toEqual(['each', 'named', 'startTrigger'])
    expect((await rest(adminCookie, 'GET', `/runs/${run.id}/blocks/each`)).body.block.data).toEqual([
      [{ amount: 100 }],
      [{ amount: 250 }],
    ])
    expect((await rest(adminCookie, 'GET', `/runs/${run.id}/blocks/named`)).body.block.data).toEqual([
      { customer: 'globex' },
    ])
  })

  it('records a failed run with the failing block', async () => {
    const wf = await workflowWith('broken-query', [query('q', 'select * from nope')], [['startTrigger', 'q']])
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    const run = await waitForRun(body.run.id)
    expect(run).toMatchObject({ status: 'failed', error: { code: 'query', block: 'q' } })
  })

  it('pins a snapshot per draft revision', async () => {
    const wf = await workflowWith('pinning', [code('a', 'return 1')], [['startTrigger', 'a']])
    const first = (await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})).body.run.id
    const second = (await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})).body.run.id
    await admin.mutate('workflows.saveDraft', {
      id: wf.id,
      revision: wf.revision,
      definition: {
        schemaVersion: 1,
        blocks: [{ name: 'startTrigger', type: 'startTrigger' }, code('a', 'return 2')],
        edges: [{ from: 'startTrigger', port: 'out', to: 'a' }],
      },
    })
    const third = (await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})).body.run.id
    const snapshotOf = async (id: string) =>
      (await env.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]!.draftSnapshotId
    expect(await snapshotOf(first)).toBe(await snapshotOf(second))
    expect(await snapshotOf(third)).not.toBe(await snapshotOf(first))
    await waitForRun(third)
    expect((await rest(adminCookie, 'GET', `/runs/${third}/blocks/a`)).body.block.data).toBe(2)
  })

  it('refuses to start runs that would fail anyway', async () => {
    const invalid = await workflowWith(
      'invalid',
      [code('a', 'return b.data'), code('b', 'return 1')],
      [
        ['startTrigger', 'a'],
        ['a', 'b'],
      ],
    )
    const bad = await rest(adminCookie, 'POST', `/workflows/${invalid.slug}/runs`, {})
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'invalid_definition' })
    expect(bad.body.error.details.diagnostics[0]).toMatchObject({ code: 'not_ancestor', block: 'a' })

    const unknown = await workflowWith(
      'unknown-resource',
      [{ name: 'q', type: 'resourceQuery', config: { resource: 'nowhere', query: { sql: 'select 1' } } }],
      [['startTrigger', 'q']],
    )
    expect(
      (await rest(adminCookie, 'POST', `/workflows/${unknown.slug}/runs`, {})).body.error.details.diagnostics,
    ).toEqual([expect.objectContaining({ code: 'unknown_resource' })])

    const query1 = await workflowWith('needs-staging', [query('q', 'select 1')], [['startTrigger', 'q']])
    const staging = await rest(adminCookie, 'POST', `/workflows/${query1.slug}/runs?environment=staging`, {})
    expect(staging.status).toBe(400)
    expect(staging.body.error).toMatchObject({ code: 'resource_not_configured' })

    expect(
      (await rest(adminCookie, 'POST', `/workflows/${query1.slug}/runs`, { version: 'live' })).status,
    ).toBe(409)
    expect(
      (await rest(adminCookie, 'POST', `/workflows/${query1.slug}/runs?environment=mars`, {})).status,
    ).toBe(404)
  })

  it('requires a session', async () => {
    const res = await rest(undefined, 'GET', '/workflows/order-lookup/runs')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: { code: 'unauthorized', message: 'Not signed in' } })
  })
})

describe('runs across workflows', () => {
  it('lists recent runs of the workflows you can see, with a status filter', async () => {
    const mine = await workflowWith('listed-a', [code('a', 'return 1')], [['startTrigger', 'a']])
    const other = await workflowWith('listed-b', [code('a', 'throw new Error("x")')], [['startTrigger', 'a']])
    const ok = (await rest(adminCookie, 'POST', `/workflows/${mine.slug}/runs`, {})).body.run
    const bad = (await rest(adminCookie, 'POST', `/workflows/${other.slug}/runs`, {})).body.run
    await waitForRun(ok.id)
    await waitForRun(bad.id)

    const all = (await rest(adminCookie, 'GET', '/runs?limit=200')).body.runs
    expect(all.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([ok.id, bad.id]))
    expect(all.find((r: { id: string }) => r.id === bad.id).workflow).toEqual({
      id: other.id,
      slug: 'listed-b',
      name: 'listed-b',
    })
    const failed = (await rest(adminCookie, 'GET', '/runs?status=failed&limit=200')).body.runs
    expect(failed.every((r: { status: string }) => r.status === 'failed')).toBe(true)
    expect(failed.map((r: { id: string }) => r.id)).toContain(bad.id)

    // The member sees no workflows, so no runs.
    expect((await rest(memberCookie, 'GET', '/runs')).body).toEqual({ runs: [], next: null })
  })
})

describe('run block', () => {
  it('runs one block, reusing its ancestors from the latest run and skipping what comes after', async () => {
    const wf = await workflowWith(
      'block-runs',
      [
        query('order', 'select customer, amount from orders where id = {{ startTrigger.data.id }}'),
        code('shape', 'return order.data[0].customer.toUpperCase()'),
        code('after', 'return shape.data + "!"'),
      ],
      [
        ['startTrigger', 'order'],
        ['order', 'shape'],
        ['shape', 'after'],
      ],
    )
    const full = (await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, { input: { id: 1 } })).body
      .run
    await waitForRun(full.id)

    const started = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/blocks/shape/runs`, {})
    expect(started.status).toBe(202)
    expect(started.body.run).toMatchObject({ targetBlocks: ['shape'], input: { data: { id: 1 } } })
    const partial = await waitForRun(started.body.run.id)
    expect(partial.status).toBe('succeeded')

    const { body } = await rest(adminCookie, 'GET', `/runs/${partial.id}/blocks`)
    const byKey = Object.fromEntries(body.blocks.map((b: { key: string }) => [b.key, b]))
    expect(Object.keys(byKey).sort()).toEqual(['order', 'shape', 'startTrigger'])
    expect(byKey.order.metadata).toMatchObject({ cachedFrom: full.id })
    expect(byKey.startTrigger.metadata).toMatchObject({ cachedFrom: full.id })
    expect(byKey.shape.metadata.cachedFrom).toBeUndefined()
    expect((await rest(adminCookie, 'GET', `/runs/${partial.id}/blocks/shape`)).body.block.data).toBe('ACME')

    // New input runs every ancestor fresh.
    const fresh = (
      await rest(adminCookie, 'POST', `/workflows/${wf.slug}/blocks/shape/runs`, { input: { id: 2 } })
    ).body.run
    await waitForRun(fresh.id)
    const freshBlocks = (await rest(adminCookie, 'GET', `/runs/${fresh.id}/blocks`)).body.blocks
    expect(freshBlocks.every((b: { metadata: object }) => !('cachedFrom' in b.metadata))).toBe(true)
    expect((await rest(adminCookie, 'GET', `/runs/${fresh.id}/blocks/shape`)).body.block.data).toBe('GLOBEX')

    expect((await rest(adminCookie, 'POST', `/workflows/${wf.slug}/blocks/nope/runs`, {})).status).toBe(404)
    expect(
      (
        await rest(adminCookie, 'POST', `/workflows/${wf.slug}/blocks/shape/runs`, {
          fromRunId: '00000000-0000-7000-8000-000000000000',
        })
      ).status,
    ).toBe(404)
  })
})

/** Reads server-sent events until `end` (or the timeout), returning `[name, data]` pairs. */
async function readEvents(url: string, cookie: string, timeoutMs = 15_000) {
  const res = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(timeoutMs) })
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  // biome-ignore lint/suspicious/noExplicitAny: untyped event payloads, asserted field by field
  const events: [string, any][] = []
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return events
    buffer += value
    let cut = buffer.indexOf('\n\n')
    while (cut !== -1) {
      const chunk = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      cut = buffer.indexOf('\n\n')
      const name = /^event: (.*)$/m.exec(chunk)?.[1]
      const data = /^data: (.*)$/m.exec(chunk)?.[1]
      if (name) events.push([name, JSON.parse(data!)])
    }
  }
}

describe('live run events', () => {
  let base: string
  beforeAll(async () => {
    base = await env.app.listen({ port: 0, host: '127.0.0.1' })
  })

  it('streams a snapshot, then each change, then end', async () => {
    const wf = await workflowWith(
      'live',
      [query('slow', 'select pg_sleep(0.5) is null as slept'), code('after', 'return slow.data[0].slept')],
      [
        ['startTrigger', 'slow'],
        ['slow', 'after'],
      ],
    )
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    const events = await readEvents(`${base}/api/v1/runs/${body.run.id}/events`, adminCookie)

    expect(events[0]![0]).toBe('snapshot')
    expect(events[0]![1].run.id).toBe(body.run.id)
    expect(events.at(-1)).toEqual(['end', {}])
    expect(events.at(-2)).toEqual(['run', { status: 'succeeded' }])
    // Whatever the snapshot missed arrives as events: the final state of every block is known.
    const state = new Map<string, string>(
      events[0]![1].blocks.map((b: { key: string; status: string }) => [b.key, b.status]),
    )
    for (const [name, data] of events) if (name === 'block') state.set(data.key, data.status)
    expect(Object.fromEntries(state)).toEqual({
      startTrigger: 'succeeded',
      slow: 'succeeded',
      after: 'succeeded',
    })
    expect(events).toContainEqual(['block', { key: 'after', status: 'succeeded', attempt: 1, port: 'out' }])
  })

  it('ends straight after the snapshot for a finished run', async () => {
    const wf = await workflowWith('done-already', [code('a', 'return 1')], [['startTrigger', 'a']])
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    await waitForRun(body.run.id)
    const events = await readEvents(`${base}/api/v1/runs/${body.run.id}/events`, adminCookie)
    expect(events.map(([name]) => name)).toEqual(['snapshot', 'end'])
    expect(events[0]![1].run.status).toBe('succeeded')
    expect(events[0]![1].blocks).toHaveLength(2)
  })

  it("doesn't stream runs you can't see", async () => {
    const wf = await workflowWith('secret-live', [code('a', 'return 1')], [['startTrigger', 'a']])
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    expect((await rest(memberCookie, 'GET', `/runs/${body.run.id}/events`)).status).toBe(404)
    expect((await rest(undefined, 'GET', `/runs/${body.run.id}/events`)).status).toBe(401)
  })
})

describe('run permissions', () => {
  it('hides workflows and runs from users without access', async () => {
    const wf = await workflowWith('private', [code('a', 'return 1')], [['startTrigger', 'a']])
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    expect((await rest(memberCookie, 'POST', `/workflows/${wf.slug}/runs`, {})).status).toBe(404)
    expect((await rest(memberCookie, 'GET', `/runs/${body.run.id}`)).status).toBe(404)
    expect((await member.query('workflows.get', { id: wf.id })).status).toBe(404)
    expect(data(await member.query('workflows.list'))).toEqual([])
  })

  it('needs edit on the workflow and use on its resources to run a draft', async () => {
    const wf = await workflowWith(
      'shared',
      [query('q', 'select count(*)::int as n from orders')],
      [['startTrigger', 'q']],
    )
    const grant = (
      objectType: string,
      objectId: string,
      level: string | null,
      environmentId: string | null = null,
    ) =>
      admin.mutate('permissions.set', { objectType, objectId, groupId: memberGroupId, environmentId, level })

    data(await grant('workflow', wf.id, 'use'))
    expect(
      data(await member.query('workflows.list')).map((w: { slug: string; level: string }) => [
        w.slug,
        w.level,
      ]),
    ).toEqual([['shared', 'use']])
    const useOnly = await rest(memberCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    expect(useOnly.status).toBe(403)
    expect(useOnly.body.error.message).toBe('You need edit access to run the draft')
    expect(
      (await member.mutate('workflows.saveDraft', { id: wf.id, revision: wf.revision, definition: {} }))
        .status,
    ).toBe(403)

    data(await grant('workflow', wf.id, 'edit'))
    const noResource = await rest(memberCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    expect(noResource.status).toBe(403)
    expect(noResource.body.error.message).toBe(
      'You need use access to resource "warehouse" in Production to run this draft',
    )

    data(await grant('resource', resourceId, 'use', prodId))
    const ok = await rest(memberCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    expect(ok.status).toBe(202)
    const run = await waitForRun(ok.body.run.id, memberCookie)
    expect(run.status).toBe('succeeded')
    expect((await rest(memberCookie, 'GET', `/runs/${run.id}/blocks/q`)).body.block.data).toEqual([{ n: 2 }])

    // Workflow grants apply to every environment.
    expect((await grant('workflow', wf.id, 'use', prodId)).status).toBe(400)
    // Only owners manage a workflow's access.
    const byMember = await member.mutate('permissions.set', {
      objectType: 'workflow',
      objectId: wf.id,
      groupId: memberGroupId,
      environmentId: null,
      level: 'own',
    })
    expect(byMember.status).toBe(403)
  })

  it('lets owners delete a workflow with its runs', async () => {
    const wf = await workflowWith('doomed', [code('a', 'return 1')], [['startTrigger', 'a']])
    const { body } = await rest(adminCookie, 'POST', `/workflows/${wf.slug}/runs`, {})
    await waitForRun(body.run.id)
    data(await admin.mutate('workflows.delete', { id: wf.id }))
    expect((await rest(adminCookie, 'GET', `/runs/${body.run.id}`)).status).toBe(404)
  })
})
