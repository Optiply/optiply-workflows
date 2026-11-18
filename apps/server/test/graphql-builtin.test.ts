import { startTestGraphql, type TestGraphql } from '@ow/connectors/testing'
import { createDb, GRAPHQL_RESOURCE_SLUG, REST_API_RESOURCE_SLUG } from '@ow/db'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// The built-in GraphQL resource (session 57): there on every instance, Use for All Users, any public endpoint (here
// the test endpoint, a private host the instance allows by name), auth per query; its schema per query's endpoint.

const TOKEN = 'Gql-Builtin-Token-5521'

let env: TestEnv
let gql: TestGraphql
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

async function configVar(name: string, isSecret: boolean, value: string) {
  data(await admin.mutate('configVars.create', { name, isSecret }))
  const vars = data(await admin.query('configVars.list'))
  const created = vars.find((v: { name: string }) => v.name === name)
  data(await admin.mutate('configVars.setValue', { configVarId: created.id, environmentId: prodId, value }))
}

beforeAll(async () => {
  gql = await startTestGraphql({ token: TOKEN })
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
  await gql?.stop()
})

describe('the built-in GraphQL resource', () => {
  it('is there for everyone beside REST API, and only the platform makes or changes it', async () => {
    const listed = data(await member.query('resources.list')).resources
    const builtIn = listed.find((r: { slug: string }) => r.slug === GRAPHQL_RESOURCE_SLUG)
    expect(builtIn).toMatchObject({ name: 'GraphQL', type: 'graphqlapi', systemKind: 'graphql' })
    expect(listed.find((r: { slug: string }) => r.slug === REST_API_RESOURCE_SLUG)).toBeTruthy()
    builtInId = builtIn.id

    const ran = data(
      await member.mutate('resources.run', {
        resourceId: builtInId,
        environmentId: prodId,
        query: {
          url: gql.url,
          auth: { type: 'bearer', token: '{{ token }}' },
          query: 'query One($id: ID!) { order(id: $id) { id customer } }',
          variables: '{"id": "{{ id }}"}',
        },
        scope: { token: TOKEN, id: '1' },
      }),
    )
    expect(ran).toMatchObject({ ok: true, data: { order: { id: '1', customer: 'acme' } } })
    expect(JSON.stringify(ran)).not.toContain(TOKEN)

    const types = data(await admin.query('resources.types')).map((t: { type: string }) => t.type)
    expect(types).toContain('graphql')
    expect(types).not.toContain('graphqlapi')
    const second = await admin.mutate('resources.create', { type: 'graphqlapi', name: 'Mine', slug: 'mine' })
    expect(second.body.error?.message).toContain(`built in: use ${GRAPHQL_RESOURCE_SLUG}`)
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

  it('reads a query’s endpoint’s schema with its auth, never with a secret config var', async () => {
    await configVar('GQL_PUBLIC_TOKEN', false, TOKEN)
    await configVar('GQL_SECRET_TOKEN', true, TOKEN)
    const schema = (token: string, refresh = false) =>
      member.query('resources.graphqlApiSchema', {
        resourceId: builtInId,
        environmentId: prodId,
        query: { url: gql.url, auth: { type: 'bearer', token }, headers: [] },
        refresh,
      })
    const ok = data(await schema('{{ configVars.GQL_PUBLIC_TOKEN }}'))
    expect(ok.ok).toBe(true)
    expect(ok.schema.__schema.types.map((t: { name: string }) => t.name)).toContain('Order')
    const asked = gql.requests.length
    data(await schema('{{ configVars.GQL_PUBLIC_TOKEN }}'))
    expect(gql.requests.length).toBe(asked) // kept for a while
    data(await schema('{{ configVars.GQL_PUBLIC_TOKEN }}', true))
    expect(gql.requests.length).toBe(asked + 1)

    // A secret config var isn't filled in here (the editor could send it anywhere): the endpoint refuses.
    const secret = data(await schema('{{ configVars.GQL_SECRET_TOKEN }}'))
    expect(secret).toMatchObject({ ok: false, error: { message: expect.stringContaining('Unauthorized') } })
    expect(JSON.stringify(secret)).not.toContain(TOKEN)

    const restApi = data(await member.query('resources.list')).resources.find(
      (r: { slug: string }) => r.slug === REST_API_RESOURCE_SLUG,
    )
    const wrongType = await member.query('resources.graphqlApiSchema', {
      resourceId: restApi.id,
      environmentId: prodId,
      query: { url: gql.url, auth: { type: 'none' }, headers: [] },
    })
    expect(wrongType.body.error?.message).toContain('Only the built-in GraphQL resource')
  })

  it('runs in a released workflow with a secret config var as its token, which stays out of the run', async () => {
    const created = data(await admin.mutate('workflows.create', { slug: 'gql-builtin', name: 'gql-builtin' }))
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
                resource: GRAPHQL_RESOURCE_SLUG,
                query: {
                  url: gql.url,
                  auth: { type: 'bearer', token: '{{ configVars.GQL_SECRET_TOKEN }}' },
                  query: 'query($c: String) { orders(customer: $c) { id amount } }',
                  variables: '{"c": {{ startTrigger.data.customer }}}',
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
    data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
    const started = await rest('POST', '/workflows/gql-builtin/runs', {
      version: 'live',
      input: { customer: 'acme' },
    })
    expect(started.status).toBe(202)
    const run = await waitForRun(started.body.run.id)
    expect(run.status).toBe('succeeded')
    expect(run.response.body).toEqual({ orders: [{ id: '1', amount: 1200 }] })
    expect(JSON.stringify(run)).not.toContain(TOKEN)
  })
})
