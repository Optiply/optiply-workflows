/**
 * Workflows query the managed database through the built-in optiply_db resource, like any Postgres resource: each
 * run reaches the tables of its own environment, with the environment's role, under the usual run permissions.
 */
import { createDb, environments, groupMembers, groups, permissions, resources } from '@ow/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let adminCookie: string
let memberCookie: string
let stopWorker: () => Promise<void>
const envIds: Record<string, string> = {}

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

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { body: { result?: { data: unknown } } }) => res.body.result?.data as any

/** A draft workflow: one query on optiply_db, its rows as the response. */
async function queryWorkflow(slug: string, sql: string) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  await admin.mutate('workflows.saveDraft', {
    id: created.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'stock', type: 'resourceQuery', config: { resource: 'optiply_db', query: { sql } } },
        { name: 'reply', type: 'response', config: { status: '200', body: '{{ stock.data }}' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'stock' },
        { from: 'stock', port: 'out', to: 'reply' },
      ],
    },
  })
  return slug
}

async function run(cookie: string, slug: string, environment: string, input: unknown = {}) {
  const started = await rest(cookie, 'POST', `/workflows/${slug}/runs?environment=${environment}`, { input })
  if (started.status !== 202) return { refused: started }
  return { run: await waitForRun(started.body.run.id) }
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const member = await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)
  for (const e of await env.db.select().from(environments)) envIds[e.slug] = e.id

  // The same table in both environments, with different rows.
  for (const [slug, rows] of [
    [
      'production',
      [
        ['apple', 12],
        ['pear', 3],
      ],
    ],
    ['staging', [['test fruit', 99]]],
  ] as const) {
    await admin.mutate('database.createTable', {
      environmentId: envIds[slug],
      name: 'stock',
      columns: [
        { name: 'name', type: 'text', nullable: false },
        { name: 'qty', type: 'integer' },
      ],
    })
    for (const [name, qty] of rows) {
      await admin.mutate('database.insertRow', {
        environmentId: envIds[slug],
        table: 'stock',
        values: { name, qty },
      })
    }
  }

  // The member may use workflows, and the database in production only.
  const [team] = await env.db.insert(groups).values({ name: 'Planners' }).returning()
  await env.db.insert(groupMembers).values({ groupId: team!.id, userId: member.id })
  const [db] = await env.db.select().from(resources).where(eq(resources.systemKind, 'database'))
  await env.db.insert(permissions).values([
    {
      groupId: team!.id,
      objectType: 'resource',
      objectId: db!.id,
      environmentId: envIds.production,
      level: 'use',
    },
    { groupId: team!.id, objectType: 'workflow', objectId: null, environmentId: null, level: 'edit' },
  ])

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

describe('workflows on the managed database', () => {
  it("query the run's own environment", async () => {
    const slug = await queryWorkflow(
      'low-stock',
      'select name, qty from stock where qty >= {{ startTrigger.data.min }} order by qty',
    )
    const production = await run(adminCookie, slug, 'production', { min: 1 })
    expect(production.run).toMatchObject({
      status: 'succeeded',
      response: {
        body: [
          { name: 'pear', qty: 3 },
          { name: 'apple', qty: 12 },
        ],
      },
    })
    const staging = await run(adminCookie, slug, 'staging', { min: 1 })
    expect(staging.run).toMatchObject({
      status: 'succeeded',
      response: { body: [{ name: 'test fruit', qty: 99 }] },
    })
  })

  it('write rows the Database page then shows', async () => {
    const slug = await queryWorkflow(
      'restock',
      'insert into stock (name, qty) values ({{ startTrigger.data.name }}, {{ startTrigger.data.qty }}) returning id, name',
    )
    const result = await run(adminCookie, slug, 'production', { name: 'plum', qty: 7 })
    expect(result.run).toMatchObject({ status: 'succeeded', response: { body: [{ id: '3', name: 'plum' }] } })
    const page = data(
      await admin.query('database.rows', {
        environmentId: envIds.production,
        table: 'stock',
        query: { filters: [{ column: 'name', op: 'eq', value: 'plum' }] },
      }),
    )
    expect(page.rows).toEqual([{ id: '3', name: 'plum', qty: 7 }])
  })

  it("can't reach the platform's own tables, even from a workflow", async () => {
    const slug = await queryWorkflow('snoop', 'select email from public.users')
    const result = await run(adminCookie, slug, 'production')
    expect(result.run).toMatchObject({
      status: 'failed',
      error: { block: 'stock', message: expect.stringMatching(/permission denied for table users/) },
    })
  })

  it('need Use on the database in that environment to run a draft', async () => {
    const slug = await queryWorkflow('member-view', 'select count(*)::int as n from stock')
    const mine = await run(memberCookie, slug, 'production')
    expect(mine.run).toMatchObject({ status: 'succeeded', response: { body: [{ n: 3 }] } })
    const refused = await run(memberCookie, slug, 'staging')
    expect(refused.refused?.status).toBe(403)
    expect(JSON.stringify(refused.refused?.body)).toMatch(/optiply_db/)
  })
})
