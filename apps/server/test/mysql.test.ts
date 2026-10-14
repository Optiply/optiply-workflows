import { mysqlAvailable, startTestMysql, type TestMysql } from '@ow/connectors/testing'
import { createDb } from '@ow/db'
import mysql from 'mysql2/promise'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// A MySQL resource through the whole stack: settings with an encrypted password, Test connection, the query
// playground and a workflow run on a worker. Needs Docker (or MYSQL_TEST_URL); CI runs it.
const available = mysqlAvailable()

let env: TestEnv
let server: TestMysql
let admin: ReturnType<typeof trpc>
let adminCookie: string
let prodId: string
let resourceId: string
let stopWorker: () => Promise<void>
const responses: string[] = []

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

async function rest(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: adminCookie },
    ...(payload !== undefined && { payload: payload as object }),
  })
  responses.push(res.body)
  return { status: res.statusCode, body: res.json() }
}

beforeAll(async () => {
  if (!available) return
  ;[env, server] = await Promise.all([startTestApp(), startTestMysql()])
  const root = await mysql.createConnection({
    host: server.host,
    port: server.port,
    user: 'root',
    password: server.rootPassword,
    database: server.database,
    multipleStatements: true,
  })
  await root.query(`
    CREATE TABLE orders (id INT PRIMARY KEY, customer VARCHAR(50), amount DECIMAL(10, 2), placed DATETIME);
    INSERT INTO orders VALUES (1, 'acme', 100.00, '2026-10-01 09:00:00'), (2, 'globex', 250.50, '2026-10-02 10:30:00'),
      (3, 'initech', 75.25, '2026-10-03 11:45:00');
  `)
  await root.end()

  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie, { record: responses })
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id

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
}, 240_000)
afterAll(async () => {
  await stopWorker?.()
  await env?.stop()
  await server?.stop()
})

describe.skipIf(!available)('MySQL resources', () => {
  it('is offered as a type, saves settings with a write-only password and tests the connection', async () => {
    expect(data(await admin.query('resources.types'))).toContainEqual({ type: 'mysql', label: 'MySQL' })
    resourceId = data(
      await admin.mutate('resources.create', { type: 'mysql', name: 'Shop', slug: 'shop' }),
    ).id
    const saved = data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prodId,
        config: { host: server.host, port: server.port, database: server.database, user: server.user },
        secrets: { password: server.password },
      }),
    )
    expect(saved.secrets).toEqual({ password: { set: true } })
    // Defaults applied by the connector's schema.
    expect(saved.config).toMatchObject({ ssl: 'require', maxRows: 10_000, readOnly: false, poolSize: 5 })

    const test = data(await admin.mutate('resources.test', { resourceId, environmentId: prodId }))
    expect(test).toMatchObject({ ok: true, message: expect.stringMatching(/^MySQL 8\.4/) })
  })

  it('runs playground queries, expanding arrays', async () => {
    const run = data(
      await admin.mutate('resources.run', {
        resourceId,
        environmentId: prodId,
        query: { sql: 'SELECT id, customer, amount, placed FROM orders WHERE id IN ({{ ids }}) ORDER BY id' },
        scope: { ids: [1, 3] },
      }),
    )
    expect(run).toMatchObject({
      ok: true,
      data: [
        { id: 1, customer: 'acme', amount: '100.00', placed: '2026-10-01 09:00:00' },
        { id: 3, customer: 'initech', amount: '75.25', placed: '2026-10-03 11:45:00' },
      ],
      metadata: { rowCount: 2 },
    })
  })

  it('runs in a workflow on a worker', async () => {
    const created = data(await admin.mutate('workflows.create', { slug: 'big-orders', name: 'Big orders' }))
    data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'orders',
              type: 'resourceQuery',
              config: {
                resource: 'shop',
                query: {
                  sql: 'SELECT customer FROM orders WHERE amount > {{ startTrigger.data.min }} ORDER BY id',
                },
              },
            },
            {
              name: 'reply',
              type: 'response',
              config: { status: '200', body: '{{ orders.data.map(o => o.customer) }}' },
            },
          ],
          edges: [
            { from: 'startTrigger', port: 'out', to: 'orders' },
            { from: 'orders', port: 'out', to: 'reply' },
          ],
        },
      }),
    )
    const started = await rest('POST', '/workflows/big-orders/runs', { input: { min: 80 } })
    expect(started.status).toBe(202)
    let run: { status: string; response?: unknown }
    const deadline = Date.now() + 20_000
    do {
      await new Promise((r) => setTimeout(r, 50))
      run = (await rest('GET', `/runs/${started.body.run.id}`)).body.run
    } while (!['succeeded', 'failed'].includes(run.status) && Date.now() < deadline)
    expect(run).toMatchObject({ status: 'succeeded', response: { status: 200, body: ['acme', 'globex'] } })
  })

  it('never returns the password', () => {
    expect(responses.length).toBeGreaterThan(5)
    for (const body of responses) expect(body).not.toContain(server.password)
  })
})
