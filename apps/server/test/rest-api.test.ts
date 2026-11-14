import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDb, REST_API_RESOURCE_SLUG } from '@ow/db'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// The built-in REST API resource (M27): there on every instance, Use for All Users, any public URL (here the test
// server, a private host the instance allows by name), auth per request.

const TOKEN = 'Rest-Api-Token-4417'

let env: TestEnv
let echo: Server
let origin: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let prodId: string
let builtInId: string
let stopWorker: () => Promise<void>

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

async function rest(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: adminCookie },
    ...(payload !== undefined && { payload: payload as object }),
  })
  return { status: res.statusCode, body: res.json() }
}

async function waitForRun(id: string) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const { body } = await rest('GET', `/runs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
    if (Date.now() > deadline) throw new Error(`run ${id} still ${body.run.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  echo = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const url = new URL(req.url ?? '/', 'http://x')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        authorized: req.headers.authorization === `Bearer ${TOKEN}`,
        body: Buffer.concat(chunks).toString(),
      }),
    )
  })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`

  env = await startTestApp({ REST_API_PRIVATE_HOSTS: '127.0.0.1' })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@example.com')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, await login(env.app, 'member@example.com'))
  const envs = data(await admin.query('environments.list'))
  prodId = envs.find((e: { slug: string }) => e.slug === 'production').id

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
  await new Promise((resolve) => echo?.close(resolve))
})

describe('the built-in REST API resource', () => {
  it('is there for everyone, and its settings are the platform’s', async () => {
    const listed = data(await member.query('resources.list')).resources
    const builtIn = listed.find((r: { slug: string }) => r.slug === REST_API_RESOURCE_SLUG)
    expect(builtIn).toMatchObject({ type: 'restapi', systemKind: 'rest' })
    builtInId = builtIn.id

    const ran = data(
      await member.mutate('resources.run', {
        resourceId: builtInId,
        environmentId: prodId,
        query: { method: 'POST', url: `${origin}/hello`, body: { type: 'json', json: '{"n": {{ n }}}' } },
        scope: { n: 2 },
      }),
    )
    expect(ran.data).toMatchObject({ method: 'POST', path: '/hello', body: '{"n":2}' })

    const refused = await admin.mutate('resources.saveConfig', {
      resourceId: builtInId,
      environmentId: prodId,
      config: {},
      secrets: {},
    })
    expect(refused.body.error?.message).toContain('built-in')
    expect((await admin.mutate('resources.delete', { id: builtInId })).body.error?.message).toContain(
      'built-in',
    )
  })

  it('refuses private addresses the instance hasn’t allowed', async () => {
    const res = await member.mutate('resources.run', {
      resourceId: builtInId,
      environmentId: prodId,
      query: { url: 'http://10.0.0.1/internal' },
    })
    expect(data(res)).toMatchObject({
      ok: false,
      error: { code: 'blocked', message: '10.0.0.1 is a private address' },
    })
  })

  it('runs in a workflow with a secret config var as its token, which stays out of the run', async () => {
    data(await admin.mutate('configVars.create', { name: 'API_TOKEN', isSecret: true }))
    const vars = data(await admin.query('configVars.list'))
    const tokenVar = vars.find((v: { name: string }) => v.name === 'API_TOKEN')
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: tokenVar.id,
        environmentId: prodId,
        value: TOKEN,
      }),
    )
    const created = data(await admin.mutate('workflows.create', { slug: 'rest-api', name: 'rest-api' }))
    const saved = data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'call',
              type: 'resourceQuery',
              config: {
                resource: REST_API_RESOURCE_SLUG,
                query: {
                  method: 'GET',
                  url: `${origin}/orders/{{ startTrigger.data.id }}`,
                  auth: { type: 'bearer', token: `{{ configVars.API_TOKEN }}` },
                },
              },
            },
            { name: 'reply', type: 'response', config: { status: '200', body: '{{ call.data }}' } },
          ],
          edges: [
            { from: 'startTrigger', port: 'out', to: 'call' },
            { from: 'call', port: 'out', to: 'reply' },
          ],
        },
      }),
    )
    // Secret config vars reach released runs only (a draft's editor could return one).
    data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
    const started = await rest('POST', '/workflows/rest-api/runs', { version: 'live', input: { id: 9 } })
    expect(started.status).toBe(202)
    const run = await waitForRun(started.body.run.id)
    expect(run.status).toBe('succeeded')
    expect(run.response.body).toMatchObject({ path: '/orders/9', authorized: true })
    expect(JSON.stringify(run)).not.toContain(TOKEN)
  })

  it("keeps an app viewer's values out of the host", async () => {
    const created = data(await admin.mutate('apps.create', { slug: 'rest-api-app', name: 'rest-api-app' }))
    const query = (name: string, url: string) => ({
      name,
      kind: 'resource',
      resource: REST_API_RESOURCE_SLUG,
      query: { method: 'GET', url },
      run: 'manual',
    })
    data(
      await admin.mutate('apps.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [
            query('anywhere', '{{ target.value }}'),
            query('item', `${origin}/items/{{ name.value }}`),
          ],
        },
      }),
    )
    const asAdmin = (name: string, values: Record<string, unknown>) =>
      admin.mutate('apps.runQuery', {
        appId: created.id,
        releaseId: null,
        query: name,
        environmentId: prodId,
        values,
      })
    const refused = await asAdmin('anywhere', { ' target.value ': `${origin}/x` })
    expect(data(refused)).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(data(refused).error.message).toContain('type the URL’s scheme and host out')
    const ok = data(await asAdmin('item', { ' name.value ': '../admin' }))
    expect(ok.data.path).toBe('/items/..%2Fadmin')
  })
})
