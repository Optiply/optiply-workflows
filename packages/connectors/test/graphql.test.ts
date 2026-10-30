import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  graphqlConnector,
  graphqlIntrospect,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import { startTestGraphql, type TestGraphql } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

let gql: TestGraphql
let pool: PoolManager

beforeAll(async () => {
  gql = await startTestGraphql()
  pool = new PoolManager()
})

afterAll(async () => {
  await pool.closeAll()
  await gql.stop()
})

const res = (token = gql.token, version = token) =>
  resource(
    {
      baseUrl: gql.url,
      allowPrivateNetwork: true,
      auth: { type: 'bearer' },
      headers: [{ key: 'x-app', value: 'ow' }],
    },
    { bearerToken: token },
    version,
  )

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

const run = (query: unknown, scope: Record<string, unknown> = {}, r = res()) =>
  runQuery(pool, graphqlConnector, r, query, { evaluate: scopeEvaluator(scope) })

describe('GraphQL resources', () => {
  it('run a query with variables and an operation name, with the resource’s auth and headers', async () => {
    const out = await run(
      {
        query:
          'query One($id: ID!) { order(id: $id) { id customer lines { sku qty } } } query All { orders { id } }',
        variables: '{"id": {{ id }}}',
        operationName: 'One',
        headers: [{ key: 'x-trace', value: '{{ trace }}' }],
      },
      { id: '1', trace: 't-9' },
    )
    expect(out.data).toEqual({ order: { id: '1', customer: 'acme', lines: [{ sku: 'A-1', qty: 2 }] } })
    expect(out.metadata).toMatchObject({ status: 200 })
    const sent = gql.requests.at(-1)!
    expect(sent).toMatchObject({ operationName: 'One', variables: { id: '1' } })
    expect(sent.headers).toMatchObject({ 'x-app': 'ow', 'x-trace': 't-9' })
  })

  it('run mutations, values bound as variables', async () => {
    const out = await run(
      {
        query: 'mutation($input: OrderInput!) { createOrder(input: $input) { customer amount } }',
        variables: '{"input": {"customer": {{ who }}, "amount": {{ cents }}}}',
      },
      { who: 'initech"} } {', cents: 900 },
    )
    expect(out.data).toEqual({ createOrder: { customer: 'initech"} } {', amount: 900 } })
  })

  it('fail with the first GraphQL error and its path, keeping partial data', async () => {
    const err = await failure(run({ query: '{ order(id: "13") { id risk } }' }))
    expect(err.code).toBe('query')
    expect(err.message).toBe('Risk service unavailable (at order.risk)')
    expect(err.details).toMatchObject({ data: { order: { id: '13', risk: null } } })
    expect((err.details as { errors: unknown[] }).errors).toHaveLength(1)

    const invalid = await failure(run({ query: '{ order(id: "1") { nope } }' }))
    expect(invalid.message).toContain('Cannot query field "nope" on type "Order"')
  })

  it('refuse {{ }} in the query text and point at syntax errors', () => {
    const templated = graphqlConnector.querySchema.parse({ query: '{ order(id: "{{ id }}") { id } }' })
    expect(graphqlConnector.validateQuery(templated)[0]?.message).toContain('Put values in the variables')

    const broken = graphqlConnector.querySchema.parse({ query: '{ order(id: "1") { id }' })
    const [error] = graphqlConnector.validateQuery(broken)
    expect(error?.message).toContain('Expected Name, found <EOF>')
    expect(error?.start).toBe(23)
  })

  it('answer a refused token as an HTTP error, and test the connection by introspection', async () => {
    const refused = await failure(run({ query: '{ orders { id } }' }, {}, res('wrong')))
    expect(refused.message).toBe('Unauthorized')

    expect(await testResource(graphqlConnector, res())).toMatchObject({
      ok: true,
      message: 'GraphQL, 10 types',
    })
    gql.setIntrospection(false)
    try {
      expect(await testResource(graphqlConnector, res())).toMatchObject({
        ok: true,
        message: expect.stringContaining('introspection is turned off'),
      })
    } finally {
      gql.setIntrospection(true)
    }
  })

  it('hand the schema to the editor', async () => {
    const r = res()
    const client = graphqlConnector.createClient({
      ...r,
      config: graphqlConnector.configSchema.parse(r.config),
      secrets: graphqlConnector.secretsSchema.parse(r.secrets),
    }) as Parameters<typeof graphqlIntrospect>[0]
    try {
      const schema = await graphqlIntrospect(client, { signal: AbortSignal.timeout(5000) })
      const order = schema.__schema.types.find((t) => t.name === 'Order')
      expect(order).toMatchObject({ kind: 'OBJECT', description: 'An order in the shop' })
    } finally {
      await graphqlConnector.destroyClient(client)
    }
  })
})
