import { apiKeys, createDb, workflowRuns } from '@ow/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let prodId: string
let stagingId: string
let apiKey: string
let stopWorker: () => Promise<void>

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

const start = { name: 'startTrigger', type: 'startTrigger' }
const code = (name: string, src: string) => ({ name, type: 'code', config: { code: src } })
const query = (name: string, sql: string) => ({
  name,
  type: 'resourceQuery',
  config: { resource: 'shop', query: { sql } },
})
const respond = (config: object) => ({ name: 'reply', type: 'response', config })

/** Creates a workflow with a chain of blocks and publishes it with `triggers`. */
async function published(slug: string, blocks: object[], triggers: object = { webhook: { enabled: true } }) {
  const names = ['startTrigger', ...blocks.map((b) => (b as { name: string }).name)]
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [start, ...blocks],
        edges: names.slice(1).map((to, i) => ({ from: names[i]!, port: 'out', to })),
        triggers,
      },
    }),
  )
  data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
  return created.id as string
}

async function call(
  method: string,
  url: string,
  opts: { key?: string | null; headers?: Record<string, string>; body?: unknown; raw?: string } = {},
) {
  const key = opts.key === undefined ? apiKey : opts.key
  const res = await env.app.inject({
    method: method as 'POST',
    url,
    headers: {
      ...(key ? { 'x-api-key': key } : {}),
      ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      ...opts.headers,
    },
    ...(opts.body !== undefined && { payload: JSON.stringify(opts.body) }),
    ...(opts.raw !== undefined && { payload: opts.raw }),
  })
  let json: unknown
  try {
    json = res.json()
  } catch {
    json = undefined
  }
  return { status: res.statusCode, headers: res.headers, json, text: res.body }
}

async function createKey(input: object = {}) {
  return data(await admin.mutate('apiKeys.create', { name: 'test', ...input }))
}

async function runRow(id: string) {
  return (await env.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]!
}

async function finished(id: string) {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
    const run = await runRow(id)
    if (['succeeded', 'failed'].includes(run.status)) return run
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`run ${id} didn't finish`)
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))

  const sql = postgres(env.databaseUrl, { onnotice: () => {} })
  await sql.unsafe(`
    create table customers (id int primary key, email text not null);
    insert into customers values (1, 'ada@example.com'), (2, 'grace@example.com');
  `)
  await sql.end()
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
  const url = new URL(env.databaseUrl)
  const resource = data(
    await admin.mutate('resources.create', { type: 'postgres', name: 'Shop', slug: 'shop' }),
  )
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: resource.id,
      environmentId: prodId,
      config: {
        host: url.hostname,
        port: Number(url.port),
        database: url.pathname.slice(1),
        user: decodeURIComponent(url.username),
        ssl: 'disable',
      },
      secrets: { password: decodeURIComponent(url.password) },
    }),
  )
  apiKey = (await createKey({ name: 'all' })).key

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

describe('API keys', () => {
  it('shows a key once, lists only its prefix, and is for admins only', async () => {
    const created = await createKey({ name: 'Shopify' })
    expect(created.key).toMatch(/^ow_[\w-]{43}$/)
    expect(created.prefix).toBe(created.key.slice(0, 11))
    const listed = data(await admin.query('apiKeys.list'))
    const row = listed.find((k: { id: string }) => k.id === created.id)
    expect(row).toMatchObject({ name: 'Shopify', prefix: created.prefix, revokedAt: null })
    expect(JSON.stringify(listed)).not.toContain(created.key)
    expect(JSON.stringify(listed)).not.toMatch(/[0-9a-f]{64}/)
    expect((await member.query('apiKeys.list')).status).toBe(403)
    expect((await member.mutate('apiKeys.create', { name: 'x' })).status).toBe(403)
  })
})

describe('sync webhooks', () => {
  it("answers with the Response block's status, headers and body", async () => {
    const workflowId = await published('lookup', [
      query('customer', 'select email from customers where id = {{ startTrigger.data.id }}'),
      respond({
        status: '201',
        headers: [{ key: 'X-Customer', value: '{{ customer.data[0].email }}' }],
        body: '{"email": {{ customer.data[0].email }}}',
      }),
    ])
    const res = await call('POST', '/api/v1/workflows/lookup/webhook', { body: { id: 2 } })
    expect(res.status).toBe(201)
    expect(res.json).toEqual({ email: 'grace@example.com' })
    expect(res.headers['x-customer']).toBe('grace@example.com')
    const run = await runRow(String(res.headers['x-run-id']))
    expect(run).toMatchObject({ workflowId, triggerType: 'webhook', environmentId: prodId })
    expect(run.apiKeyId).not.toBeNull()
    expect(run.triggerId).not.toBeNull()
  })

  it('passes the body, path and query parameters and headers, but never the API key', async () => {
    await published('echo', [respond({ body: '{{ startTrigger }}' })], {
      webhook: { enabled: true, alias: 'echo/:thing', methods: ['POST', 'PUT'] },
    })
    const res = await call('PUT', '/api/v1/hooks/echo/a%20b?page=2&environment=production&tag=x&tag=y', {
      body: { n: 1 },
      headers: { 'x-trace': 't1', cookie: 'ow_session=nope' },
    })
    expect(res.status).toBe(200)
    const echoed = res.json as {
      data: unknown
      pathParams: unknown
      urlParams: unknown
      headers: Record<string, string>
    }
    expect(echoed.data).toEqual({ n: 1 })
    expect(echoed.pathParams).toEqual({ thing: 'a b' })
    expect(echoed.urlParams).toEqual({ page: '2', tag: ['x', 'y'] })
    expect(echoed.headers['x-trace']).toBe('t1')
    expect(echoed.headers).not.toHaveProperty('x-api-key')
    expect(echoed.headers).not.toHaveProperty('cookie')

    // With the key in Authorization, that header is the one left out.
    const bearer = await call('POST', '/api/v1/hooks/echo/z', {
      key: null,
      body: {},
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key-like': 'kept' },
    })
    expect(bearer.status).toBe(200)
    const headers = (bearer.json as { headers: Record<string, string> }).headers
    expect(headers).not.toHaveProperty('authorization')
    expect(headers['x-api-key-like']).toBe('kept')
    expect(JSON.stringify(bearer.json)).not.toContain(apiKey)
  })

  it('reads forms as objects and other bodies as text, and can answer with plain text', async () => {
    await published('forms', [
      respond({
        headers: [{ key: 'Content-Type', value: 'text/plain' }],
        body: '{{ JSON.stringify(startTrigger.data) }}',
      }),
    ])
    const form = await call('POST', '/api/v1/workflows/forms/webhook', {
      raw: 'a=1&b=two',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(form.headers['content-type']).toMatch(/^text\/plain/)
    expect(form.text).toBe('{"a":"1","b":"two"}')
    const text = await call('POST', '/api/v1/workflows/forms/webhook', {
      raw: 'hello',
      headers: { 'content-type': 'text/csv' },
    })
    expect(text.text).toBe('"hello"')
    const empty = await call('POST', '/api/v1/workflows/forms/webhook', {
      headers: { 'content-type': 'application/json' },
    })
    expect(empty.text).toBe('null')
    const bad = await call('POST', '/api/v1/workflows/forms/webhook', {
      raw: '{nope',
      headers: { 'content-type': 'application/json' },
    })
    expect(bad).toMatchObject({ status: 400, json: { error: { code: 'invalid_request' } } })
  })

  it('answers 200 { runId, status } without a Response block, and 500 when the run fails first', async () => {
    await published('quiet', [code('a', 'return 1')])
    const ok = await call('POST', '/api/v1/workflows/quiet/webhook', { body: {} })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ runId: ok.headers['x-run-id'], status: 'succeeded' })

    await published('broken', [code('a', 'throw new Error("no stock")'), respond({ body: '1' })])
    const failed = await call('POST', '/api/v1/workflows/broken/webhook', { body: {} })
    expect(failed.status).toBe(500)
    expect(failed.json).toMatchObject({
      runId: failed.headers['x-run-id'],
      status: 'failed',
      error: { message: expect.stringContaining('no stock') },
    })
  })

  it('answers 202 with the run when the reply takes longer than the sync timeout', async () => {
    await published(
      'slow',
      [
        code('a', 'const t = Date.now(); while (Date.now() - t < 700) {} return 1'),
        respond({ body: '"late"' }),
      ],
      {
        webhook: { enabled: true, syncTimeoutMs: 100 },
      },
    )
    const res = await call('POST', '/api/v1/workflows/slow/webhook', { body: {} })
    expect(res.status).toBe(202)
    expect(res.json).toEqual({ runId: res.headers['x-run-id'], status: 'running' })
    expect(res.headers.location).toBe(`/api/v1/runs/${res.headers['x-run-id']}`)
    expect((await finished(String(res.headers['x-run-id']))).response).toMatchObject({ body: 'late' })
  })

  it('picks the most specific alias and 404s on unknown ones', async () => {
    await published('by-id', [respond({ body: '"by id {{ startTrigger.pathParams.id }}"' })], {
      webhook: { enabled: true, alias: 'items/:id' },
    })
    await published('latest', [respond({ body: '"latest"' })], {
      webhook: { enabled: true, alias: 'items/latest' },
    })
    expect((await call('POST', '/api/v1/hooks/items/7', { body: {} })).json).toBe('by id 7')
    expect((await call('POST', '/api/v1/hooks/items/latest', { body: {} })).json).toBe('latest')
    expect((await call('POST', '/api/v1/hooks/items/7/more', { body: {} })).status).toBe(404)
    expect((await call('POST', '/api/v1/hooks/nothing', { body: {} })).status).toBe(404)
  })
})

describe('async webhooks and idempotency', () => {
  it('answers 202 at once with Prefer: respond-async, and the key can follow the run', async () => {
    await published('later', [code('a', 'return 41 + 1')])
    const res = await call('POST', '/api/v1/workflows/later/webhook', {
      body: {},
      headers: { prefer: 'respond-async' },
    })
    expect(res.status).toBe(202)
    const runId = String(res.headers['x-run-id'])
    await finished(runId)
    const read = await env.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
      headers: { 'x-api-key': apiKey },
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().run).toMatchObject({ id: runId, status: 'succeeded', triggerType: 'webhook' })
    // Keys can only read single runs.
    const list = await env.app.inject({
      method: 'GET',
      url: '/api/v1/runs',
      headers: { 'x-api-key': apiKey },
    })
    expect(list.statusCode).toBe(401)
  })

  it('gives a repeated Idempotency-Key the same run and reply', async () => {
    await published('once', [code('n', 'return Math.random()'), respond({ body: '{{ n.data }}' })])
    const first = await call('POST', '/api/v1/workflows/once/webhook', {
      body: {},
      headers: { 'idempotency-key': 'order-1' },
    })
    const again = await call('POST', '/api/v1/workflows/once/webhook', {
      body: {},
      headers: { 'idempotency-key': 'order-1' },
    })
    expect(again.headers['x-run-id']).toBe(first.headers['x-run-id'])
    expect(again.json).toBe(first.json)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(first.headers['idempotent-replayed']).toBeUndefined()
    const other = await call('POST', '/api/v1/workflows/once/webhook', {
      body: {},
      headers: { 'idempotency-key': 'order-2' },
    })
    expect(other.headers['x-run-id']).not.toBe(first.headers['x-run-id'])
    const run = await runRow(String(first.headers['x-run-id']))
    expect(run.idempotencyKey).toBe('order-1')
  })
})

describe('refusals', () => {
  it('needs an active API key', async () => {
    await published('locked', [code('a', 'return 1')])
    const url = '/api/v1/workflows/locked/webhook'
    expect(await call('POST', url, { key: null, body: {} })).toMatchObject({
      status: 401,
      json: { error: { code: 'unauthorized', message: 'Send an API key in the X-Api-Key header' } },
    })
    expect((await call('POST', url, { key: 'ow_not-a-real-key', body: {} })).status).toBe(401)

    const revoked = await createKey()
    expect((await call('POST', url, { key: revoked.key, body: {} })).status).toBe(200)
    data(await admin.mutate('apiKeys.revoke', { id: revoked.id }))
    expect((await call('POST', url, { key: revoked.key, body: {} })).status).toBe(401)

    const expiring = await createKey({ expiresAt: new Date(Date.now() + 60_000) })
    await env.db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, expiring.id))
    expect((await call('POST', url, { key: expiring.key, body: {} })).status).toBe(401)
  })

  it('keeps a limited key to its workflows and environments', async () => {
    const allowed = await published('scoped-a', [code('a', 'return 1')])
    await published('scoped-b', [code('a', 'return 1')])
    const key = await createKey({ workflowIds: [allowed], environmentIds: [prodId] })
    expect(
      (await call('POST', '/api/v1/workflows/scoped-a/webhook', { key: key.key, body: {} })).status,
    ).toBe(200)
    expect(
      await call('POST', '/api/v1/workflows/scoped-b/webhook', { key: key.key, body: {} }),
    ).toMatchObject({
      status: 403,
      json: { error: { message: `This API key can't start workflow "scoped-b" in Production` } },
    })
    expect(
      (
        await call('POST', '/api/v1/workflows/scoped-a/webhook?environment=staging', {
          key: key.key,
          body: {},
        })
      ).status,
    ).toBe(403)
    const res = await call('POST', '/api/v1/workflows/scoped-b/webhook', { body: {} })
    const read = await env.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${res.headers['x-run-id']}`,
      headers: { 'x-api-key': key.key },
    })
    expect(read.statusCode).toBe(404)
    expect(stagingId).toBeDefined()
  })

  it('refuses unknown environments and resources not configured in the environment', async () => {
    await published('needs-shop', [query('q', 'select 1 as one')])
    expect(
      (await call('POST', '/api/v1/workflows/needs-shop/webhook?environment=qa', { body: {} })).status,
    ).toBe(404)
    expect(
      await call('POST', '/api/v1/workflows/needs-shop/webhook?environment=staging', { body: {} }),
    ).toMatchObject({
      status: 400,
      json: {
        error: { code: 'resource_not_configured', message: `Resource "shop" isn't configured in Staging` },
      },
    })
  })

  it('answers only live, enabled webhooks, with the methods they allow', async () => {
    expect((await call('POST', '/api/v1/workflows/nope/webhook', { body: {} })).status).toBe(404)
    await published('off', [code('a', 'return 1')], { webhook: { enabled: false } })
    expect((await call('POST', '/api/v1/workflows/off/webhook', { body: {} })).status).toBe(404)
    await published('no-hook', [code('a', 'return 1')], {})
    expect((await call('POST', '/api/v1/workflows/no-hook/webhook', { body: {} })).status).toBe(404)

    await published('getter', [respond({ body: '{{ startTrigger.urlParams }}' })], {
      webhook: { enabled: true, methods: ['GET'] },
    })
    const posted = await call('POST', '/api/v1/workflows/getter/webhook', { body: {} })
    expect(posted.status).toBe(405)
    expect(posted.headers.allow).toBe('GET')
    expect((await call('GET', '/api/v1/workflows/getter/webhook?q=1')).json).toEqual({ q: '1' })
  })
})

describe('speed', () => {
  it('answers a sync webhook in under 50 ms at the median (real HTTP, run executed in-process)', async () => {
    await published('fast', [
      code('double', 'return startTrigger.data.n * 2'),
      respond({ body: '{"n": {{ double.data }}}' }),
    ])
    const address = await env.app.listen({ port: 0, host: '127.0.0.1' })
    const hit = async (n: number) => {
      const started = performance.now()
      const res = await fetch(`${address}/api/v1/workflows/fast/webhook`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ n }),
      })
      const body = await res.json()
      const ms = performance.now() - started
      expect(body).toEqual({ n: n * 2 })
      return ms
    }
    for (let i = 0; i < 20; i++) await hit(i)
    const times: number[] = []
    for (let i = 0; i < 200; i++) times.push(await hit(i))
    times.sort((a, b) => a - b)
    const p = (q: number) => times[Math.floor((times.length - 1) * q)]!
    console.info(
      `sync webhook latency over ${times.length} calls: p50 ${p(0.5).toFixed(1)} ms, p90 ${p(0.9).toFixed(1)} ms, p99 ${p(0.99).toFixed(1)} ms`,
    )
    expect(p(0.5)).toBeLessThan(50)
  })
})
