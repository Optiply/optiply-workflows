import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectorError, configureRestApi, PoolManager, restApiConnector, runQuery } from '../src'
import { resource, scopeEvaluator } from './helpers'

let server: Server
let origin: string
let pool: PoolManager

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    if (url.pathname === '/away') {
      res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/echo` })
      return res.end()
    }
    if (url.pathname === '/fail') {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'missing' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        body,
        // What arrived, without echoing it (the connector redacts its own credentials from results).
        bearerOk: req.headers.authorization === 'Bearer tok-123',
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  pool = new PoolManager()
})

afterAll(async () => {
  await pool.closeAll()
  await new Promise((resolve) => server.close(resolve))
  configureRestApi({ privateHosts: [] })
})

const builtIn = (version: string) => resource({}, {}, version)

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the request to fail')
}

describe('the built-in REST API resource', () => {
  it('refuses private addresses unless the instance allows the host by name', async () => {
    configureRestApi({ privateHosts: [] })
    const blocked = await failure(
      runQuery(
        pool,
        restApiConnector,
        builtIn('a'),
        { url: `${origin}/echo` },
        { evaluate: scopeEvaluator({}) },
      ),
    )
    expect(blocked.code).toBe('blocked')
    expect(blocked.message).toContain('private address')

    configureRestApi({ privateHosts: ['127.0.0.1'] })
    const ok = await runQuery(
      pool,
      restApiConnector,
      builtIn('b'),
      { url: `${origin}/echo` },
      { evaluate: scopeEvaluator({}) },
    )
    expect((ok.data as { path: string }).path).toBe('/echo')
    // localhost isn't on the list: a redirect there is refused when it resolves, like any private host.
    const redirected = await failure(
      runQuery(
        pool,
        restApiConnector,
        builtIn('b'),
        { url: `${origin}/away` },
        { evaluate: scopeEvaluator({}) },
      ),
    )
    expect(redirected.code).toBe('blocked')
    expect(redirected.message).toContain('localhost resolves to a private address')
  })

  it('sends any method, parameters, headers, a JSON body and per-request auth', async () => {
    configureRestApi({ privateHosts: ['127.0.0.1'] })
    const res = builtIn('c')
    const run = (query: unknown, scope: Record<string, unknown> = {}) =>
      runQuery(pool, restApiConnector, res, query, { evaluate: scopeEvaluator(scope) })

    const posted = (await run(
      {
        method: 'POST',
        url: `${origin}/orders/{{ id }}`,
        params: [{ key: 'expand', value: '{{ expand }}' }],
        headers: [{ key: 'x-trace', value: 't1' }],
        body: { type: 'json', json: '{"qty": {{ qty }}}' },
        auth: { type: 'bearer', token: '{{ configVars.TOKEN }}' },
      },
      { id: 7, expand: 'lines', qty: 3, configVars: { TOKEN: 'tok-123' } },
    )) as {
      data: { method: string; path: string; query: string; headers: Record<string, string>; body: string }
    }
    expect(posted.data.method).toBe('POST')
    expect(posted.data.path).toBe('/orders/7')
    expect(posted.data.query).toBe('?expand=lines')
    expect(posted.data).toMatchObject({ bearerOk: true })
    expect(posted.data.headers.authorization).toBe('Bearer [REDACTED]')
    expect(posted.data.headers['x-trace']).toBe('t1')
    expect(JSON.parse(posted.data.body)).toEqual({ qty: 3 })

    const basic = (await run({
      url: `${origin}/b`,
      auth: { type: 'basic', username: 'u', password: 'p' },
    })) as {
      data: { headers: Record<string, string> }
    }
    expect(basic.data.headers.authorization).toBe('Basic [REDACTED]')

    const keyed = (await run({
      url: `${origin}/k`,
      auth: { type: 'apiKey', in: 'query', name: 'api_key', value: 'k1' },
    })) as { data: { query: string } }
    expect(keyed.data.query).toBe('?api_key=k1')

    const header = (await run({
      url: `${origin}/k`,
      auth: { type: 'apiKey', in: 'header', name: 'x-api-key', value: 'k2' },
    })) as { data: { headers: Record<string, string> } }
    expect(header.data.headers['x-api-key']).toBe('k2')
  })

  it('answers HTTP errors as REST does, and wants a full URL', async () => {
    configureRestApi({ privateHosts: ['127.0.0.1'] })
    const res = builtIn('d')
    const http = await failure(
      runQuery(pool, restApiConnector, res, { url: `${origin}/fail` }, { evaluate: scopeEvaluator({}) }),
    )
    expect(http.code).toBe('http')
    expect(http.details).toMatchObject({ status: 404 })

    const relative = await failure(
      runQuery(pool, restApiConnector, res, { url: '/orders' }, { evaluate: scopeEvaluator({}) }),
    )
    expect(relative.code).toBe('invalid_query')
    const ftp = await failure(
      runQuery(pool, restApiConnector, res, { url: 'ftp://example.com/x' }, { evaluate: scopeEvaluator({}) }),
    )
    expect(ftp.code).toBe('invalid_query')
  })

  it("keeps an app viewer's values out of the host", async () => {
    configureRestApi({ privateHosts: ['127.0.0.1'] })
    const res = builtIn('e')
    const viewer = (url: string, scope: Record<string, unknown>) =>
      runQuery(
        pool,
        restApiConnector,
        res,
        { url },
        { evaluate: scopeEvaluator(scope), untrustedValues: true },
      )

    // The whole URL, or a host finished by a value, is refused before anything is sent.
    for (const url of ['{{ target }}', 'http://{{ host }}/x', `${origin}{{ rest }}`]) {
      const refused = await failure(
        viewer(url, { target: 'http://evil.example', host: 'evil', rest: '.evil' }),
      )
      expect(refused.code).toBe('blocked')
    }
    // Values fill one encoded segment each: they can't climb out of it.
    const ok = (await viewer(`${origin}/files/{{ name }}`, { name: '../admin?x=1' })) as {
      data: { path: string; query: string }
    }
    expect(ok.data.path).toBe('/files/..%2Fadmin%3Fx%3D1')
    expect(ok.data.query).toBe('')
  })

  it('keeps its own credentials out of what comes back, an API key in the URL included', async () => {
    configureRestApi({ privateHosts: ['127.0.0.1'] })
    const out = await runQuery(
      pool,
      restApiConnector,
      builtIn('f'),
      { url: `${origin}/k`, auth: { type: 'apiKey', in: 'query', name: 'api_key', value: '{{ key }}' } },
      { evaluate: scopeEvaluator({ key: 'Secret-Key-77' }) },
    )
    expect(JSON.stringify(out)).not.toContain('Secret-Key-77')
    expect(String(out.metadata.url)).toContain('api_key=')
    const failed = await failure(
      runQuery(
        pool,
        restApiConnector,
        builtIn('f'),
        { url: `${origin}/fail`, auth: { type: 'bearer', token: 'Bearer-Secret-88' } },
        { evaluate: scopeEvaluator({}) },
      ),
    )
    expect(JSON.stringify({ message: failed.message, details: failed.details })).not.toContain(
      'Bearer-Secret-88',
    )
  })

  it('flags template errors and a GET with a body', () => {
    const query = restApiConnector.querySchema.parse({
      url: 'https://x.example/{{ a',
      body: { type: 'json', json: '{}' },
    })
    expect(restApiConnector.validateQuery(query).map((e) => e.message)).toEqual([
      expect.stringContaining('}}'),
      "GET requests can't have a body",
    ])
  })
})
