import { createHash } from 'node:crypto'
import { createDb } from '@ow/db'
import {
  clickhouse,
  jdbcRunnerAvailable,
  startTestClickHouse,
  startTestJdbcRunner,
  type TestClickHouse,
  type TestJdbcRunner,
  testNetwork,
} from '@ow/jdbc-runner/testing'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M38 done-when: JDBC resources through the whole stack, every piece real: the app (api and a worker), the JDBC
// runner's image, ClickHouse; and an uploaded driver (H2's jar, from Maven Central) sent to the runner on first use.
// Needs Docker; CI runs it.

const available = jdbcRunnerAvailable()
const H2_JAR = 'https://repo1.maven.org/maven2/com/h2database/h2/2.5.252/h2-2.5.252.jar'
const H2_SHA256 = '90b11dc413da82070ef15fc943282c1408e6ffd34fa68998335fea8603b5ff20'

let env: TestEnv
let network: ReturnType<typeof testNetwork>
let runner: TestJdbcRunner
let ch: TestClickHouse
let admin: ReturnType<typeof trpc>
let adminCookie: string
let prodId: string
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
  network = testNetwork()
  ;[runner, ch] = await Promise.all([
    startTestJdbcRunner({ network: network.name }),
    startTestClickHouse(network.name),
  ])
  await clickhouse(
    ch,
    'CREATE TABLE orders (id UInt32, customer String, amount Decimal(10, 2)) ENGINE = MergeTree ORDER BY id',
  )
  await clickhouse(
    ch,
    "INSERT INTO orders VALUES (1, 'acme', 100.00), (2, 'globex', 250.50), (3, 'initech', 75.25)",
  )
  env = await startTestApp({ JDBC_RUNNER_URL: runner.url, JDBC_RUNNER_TOKEN: runner.token })
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
}, 900_000)
afterAll(async () => {
  await stopWorker?.()
  await env?.stop()
  await runner?.stop()
  await ch?.stop()
  network?.remove()
})

describe.skipIf(!available)('JDBC resources (M38 done-when)', () => {
  let resourceId: string

  it('a ClickHouse resource: offered, saved with a write-only password, tested', async () => {
    expect(data(await admin.query('resources.types'))).toContainEqual({
      type: 'jdbc',
      label: 'JDBC',
      group: 'Databases',
    })
    resourceId = data(
      await admin.mutate('resources.create', { type: 'jdbc', name: 'Events', slug: 'events' }),
    ).id
    const saved = data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prodId,
        config: {
          driver: 'clickhouse',
          host: ch.host,
          port: ch.port,
          https: false,
          database: ch.database,
          user: ch.user,
        },
        secrets: { password: ch.password },
      }),
    )
    expect(saved.secrets).toEqual({ password: { set: true } })
    expect(saved.config).toMatchObject({
      mode: 'fields',
      auth: 'password',
      readOnly: false,
      maxRows: 1_000_000,
    })
    const test = data(await admin.mutate('resources.test', { resourceId, environmentId: prodId }))
    expect(test).toMatchObject({ ok: true, message: expect.stringMatching(/^ClickHouse 26\.8/) })
  })

  it('runs playground queries, expanding arrays', async () => {
    const run = data(
      await admin.mutate('resources.run', {
        resourceId,
        environmentId: prodId,
        query: { sql: 'SELECT id, customer, amount FROM orders WHERE id IN ({{ ids }}) ORDER BY id' },
        scope: { ids: [1, 3] },
      }),
    )
    expect(run).toMatchObject({
      ok: true,
      data: [
        { id: 1, customer: 'acme', amount: 100 },
        { id: 3, customer: 'initech', amount: 75.25 },
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
                resource: 'events',
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
    const deadline = Date.now() + 30_000
    do {
      await new Promise((r) => setTimeout(r, 100))
      run = (await rest('GET', `/runs/${started.body.run.id}`)).body.run
    } while (!['succeeded', 'failed'].includes(run.status) && Date.now() < deadline)
    expect(run).toMatchObject({ status: 'succeeded', response: { status: 200, body: ['acme', 'globex'] } })
  })

  it('refuses writes on a read-only ClickHouse resource (its server’s own readonly)', async () => {
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prodId,
        config: {
          driver: 'clickhouse',
          host: ch.host,
          port: ch.port,
          https: false,
          database: ch.database,
          user: ch.user,
          readOnly: true,
        },
      }),
    )
    const write = data(
      await admin.mutate('resources.run', {
        resourceId,
        environmentId: prodId,
        query: { sql: "INSERT INTO orders VALUES (9, 'sneaky', 1)" },
        scope: {},
      }),
    )
    expect(write).toMatchObject({
      ok: false,
      error: { code: 'query', message: expect.stringMatching(/read-only/) },
    })
    expect((await clickhouse(ch, 'SELECT count() FROM orders')).trim()).toBe('3')
  })

  it('an uploaded driver: sent to the runner on first use, loaded on its own', async () => {
    const jar = Buffer.from(await (await fetch(H2_JAR)).arrayBuffer())
    expect(createHash('sha256').update(jar).digest('hex')).toBe(H2_SHA256)
    const uploaded = await env.app.inject({
      method: 'POST',
      url: `/api/v1/jdbc-drivers?${new URLSearchParams({ name: 'H2', className: 'org.h2.Driver', fileName: 'h2.jar' })}`,
      headers: { cookie: adminCookie, 'content-type': 'application/java-archive' },
      payload: jar,
    })
    expect(uploaded.statusCode).toBe(200)
    const h2 = data(
      await admin.mutate('resources.create', { type: 'jdbc', name: 'Scratch', slug: 'scratch' }),
    ).id
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: h2,
        environmentId: prodId,
        config: { driver: 'uploaded', driverId: uploaded.json().id, url: 'jdbc:h2:mem:scratch', user: 'sa' },
        secrets: { password: '' },
      }),
    )
    const run = data(
      await admin.mutate('resources.run', {
        resourceId: h2,
        environmentId: prodId,
        query: { sql: 'SELECT {{ a }} + 1 AS answer' },
        scope: { a: 41 },
      }),
    )
    expect(run, JSON.stringify(run)).toMatchObject({ ok: true, data: [{ ANSWER: 42 }] })
  })

  it('never returns the password', () => {
    expect(responses.length).toBeGreaterThan(5)
    for (const body of responses) expect(body).not.toContain(ch.password)
  })
})
