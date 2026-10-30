import { startTestGraphql, type TestGraphql } from '@ow/connectors/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M27's resource types through the API: settings checked on save, queries from the playground, what the editors read.

let env: TestEnv
let gql: TestGraphql
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let prodId: string
const seen: string[] = []

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

async function resourceOf(type: string, slug: string, config: unknown, secrets: unknown) {
  const created = data(await admin.mutate('resources.create', { type, name: slug, slug }))
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: created.id,
      environmentId: prodId,
      config,
      secrets,
    }),
  )
  return created.id as string
}

beforeAll(async () => {
  gql = await startTestGraphql({ token: 'Gql-Secret-7731' })
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  await createLocalUser(env.db, 'member@example.com')
  admin = trpc(env.app, await login(env.app, 'admin@example.com'), { record: seen })
  member = trpc(env.app, await login(env.app, 'member@example.com'))
  prodId = data(await admin.query('environments.list')).find(
    (e: { slug: string }) => e.slug === 'production',
  ).id
})

afterAll(async () => {
  await env?.stop()
  await gql?.stop()
})

describe('GraphQL resources', () => {
  let id: string

  it('run queries from the playground and hand the editor the schema, to those with Use', async () => {
    id = await resourceOf(
      'graphql',
      'shop_gql',
      { baseUrl: gql.url, allowPrivateNetwork: true, auth: { type: 'bearer' } },
      { bearerToken: gql.token },
    )
    const ran = data(
      await admin.mutate('resources.run', {
        resourceId: id,
        environmentId: prodId,
        query: {
          query: 'query($c: String) { orders(customer: $c) { id amount } }',
          variables: '{"c": {{ who }}}',
        },
        scope: { who: 'acme' },
      }),
    )
    expect(ran).toMatchObject({ ok: true, data: { orders: [{ id: '1', amount: 1200 }] } })

    const failed = data(
      await admin.mutate('resources.run', {
        resourceId: id,
        environmentId: prodId,
        query: { query: '{ order(id: "13") { id risk } }' },
      }),
    )
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'query', message: 'Risk service unavailable (at order.risk)' },
    })

    const schema = data(
      await admin.query('resources.graphqlSchema', { resourceId: id, environmentId: prodId }),
    )
    expect(schema.ok).toBe(true)
    expect(schema.schema.__schema.queryType).toMatchObject({ name: 'Query' })
    // Cached: a second read doesn't ask the endpoint again.
    const before = gql.requests.length
    data(await admin.query('resources.graphqlSchema', { resourceId: id, environmentId: prodId }))
    expect(gql.requests.length).toBe(before)

    const refused = await member.query('resources.graphqlSchema', { resourceId: id, environmentId: prodId })
    expect(refused.status).toBeGreaterThanOrEqual(400)
  })

  it('answer a schema the endpoint won’t give as an error, and test the connection', async () => {
    const tested = data(await admin.mutate('resources.test', { resourceId: id, environmentId: prodId }))
    expect(tested).toMatchObject({ ok: true, message: 'GraphQL, 10 types' })
    gql.setIntrospection(false)
    try {
      const off = data(
        await admin.query('resources.graphqlSchema', {
          resourceId: id,
          environmentId: prodId,
          refresh: true,
        }),
      )
      expect(off).toMatchObject({ ok: false, error: { code: 'query' } })
    } finally {
      gql.setIntrospection(true)
    }
  })

  it('never send the token back', () => {
    expect(seen.join('\n')).not.toContain(gql.token)
  })
})
