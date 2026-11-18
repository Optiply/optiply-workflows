import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureRestApi,
  graphqlApiConnector,
  introspectGraphqlApi,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import { startTestGraphql, type TestGraphql } from '../src/graphql-fake'
import { builtInHttpClient } from '../src/restapi'
import { resource, scopeEvaluator } from './helpers'

// The built-in GraphQL resource (session 57): GraphQL's queries with the built-in REST API's URL and auth per request,
// against the shop endpoint of graphql-fake.ts; its schema read per endpoint with the query's own auth.

let gql: TestGraphql
let pool: PoolManager

beforeAll(async () => {
  gql = await startTestGraphql()
  pool = new PoolManager()
  configureRestApi({ privateHosts: ['127.0.0.1'] })
})

afterAll(async () => {
  await pool.closeAll()
  await gql.stop()
  configureRestApi({ privateHosts: [] })
})

const builtIn = (version: string) => resource({}, {}, version)
const bearer = { type: 'bearer' as const, token: '{{ token }}' }

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the request to fail')
}

describe('the built-in GraphQL resource', () => {
  it('posts to the query’s own URL with its own auth, variables and operation', async () => {
    const result = await runQuery(
      pool,
      graphqlApiConnector,
      builtIn('a'),
      {
        url: gql.url,
        auth: bearer,
        query: 'query One($id: ID!) { order(id: $id) { id customer amount } } query All { orders { id } }',
        variables: '{"id": "{{ id }}"}',
        operationName: 'One',
        headers: [{ key: 'x-team', value: 'ops' }],
      },
      { evaluate: scopeEvaluator({ token: gql.token, id: '1' }) },
    )
    expect(result.data).toEqual({ order: { id: '1', customer: 'acme', amount: 1200 } })
    const sent = gql.requests.at(-1)!
    expect(sent).toMatchObject({ operationName: 'One', variables: { id: '1' } })
    expect(sent.headers).toMatchObject({ authorization: `Bearer ${gql.token}`, 'x-team': 'ops' })
    // The request's own credentials never come back.
    expect(JSON.stringify(result)).not.toContain(gql.token)
  })

  it('refuses private addresses unless the instance allows the host', async () => {
    configureRestApi({ privateHosts: [] })
    try {
      const blocked = await failure(
        runQuery(
          pool,
          graphqlApiConnector,
          builtIn('b'),
          { url: gql.url, auth: bearer, query: '{ orders { id } }' },
          { evaluate: scopeEvaluator({ token: gql.token }) },
        ),
      )
      expect(blocked.code).toBe('blocked')
    } finally {
      configureRestApi({ privateHosts: ['127.0.0.1'] })
    }
  })

  it('fails on GraphQL errors with their path and partial data, and on refusals, scrubbing its credentials', async () => {
    const partial = await failure(
      runQuery(
        pool,
        graphqlApiConnector,
        builtIn('c'),
        { url: gql.url, auth: bearer, query: '{ order(id: "13") { id risk } }' },
        { evaluate: scopeEvaluator({ token: gql.token }) },
      ),
    )
    expect(partial.code).toBe('query')
    expect(partial.message).toBe('Risk service unavailable (at order.risk)')
    expect(partial.details).toMatchObject({ data: { order: { id: '13', risk: null } } })

    // An API key in the URL: refused (the endpoint wants a bearer token), and the key isn't in what's reported.
    const key = 'k3y-in-the-url-0001'
    const refused = await failure(
      runQuery(
        pool,
        graphqlApiConnector,
        builtIn('d'),
        {
          url: gql.url,
          auth: { type: 'apiKey', in: 'query', name: 'api_key', value: '{{ key }}' },
          query: '{ orders { id } }',
        },
        { evaluate: scopeEvaluator({ key }) },
      ),
    )
    expect(refused.message).toContain('Unauthorized')
    expect(JSON.stringify({ m: refused.message, d: refused.details })).not.toContain(key)
  })

  it('checks the query, the URL’s and the auth’s templates, and keeps an app viewer’s values off the host', async () => {
    const errors = graphqlApiConnector.validateQuery(
      graphqlApiConnector.querySchema.parse({
        url: 'https://{{ host',
        auth: { type: 'bearer', token: '{{ ok }}' },
        query: '{ order(id: {{ id }}) { id } }',
      }),
    )
    expect(errors.map((e) => e.message)).toEqual([
      'Put values in the variables ($name in the query), not {{ }} in the query',
      expect.stringContaining('}}'),
    ])
    const steered = await failure(
      runQuery(
        pool,
        graphqlApiConnector,
        builtIn('e'),
        { url: '{{ endpoint }}', auth: bearer, query: '{ orders { id } }' },
        { evaluate: scopeEvaluator({ endpoint: gql.url, token: gql.token }), untrustedValues: true },
      ),
    )
    expect(steered.code).toBe('blocked')
  })

  it('reads an endpoint’s schema with the query’s own auth', async () => {
    const client = builtInHttpClient()
    const ctx = { evaluate: scopeEvaluator({ token: gql.token }), signal: AbortSignal.timeout(10_000) }
    const schema = await introspectGraphqlApi(
      client,
      { url: gql.url, auth: bearer, headers: [] },
      ctx as never,
    )
    expect(schema.__schema.types.map((t) => t.name)).toContain('Order')

    const wrong = await failure(
      introspectGraphqlApi(
        client,
        { url: gql.url, auth: { type: 'bearer', token: 'not-the-token-42' }, headers: [] },
        ctx as never,
      ),
    )
    expect(wrong.message).toContain('Unauthorized')
    expect(JSON.stringify({ m: wrong.message, d: wrong.details })).not.toContain('not-the-token-42')
  })

  it('needs no settings: its test says each query gives its URL', async () => {
    expect(await testResource(graphqlApiConnector, builtIn('f'))).toMatchObject({
      ok: true,
      message: 'Ready: each query gives its endpoint’s full URL',
    })
  })
})
