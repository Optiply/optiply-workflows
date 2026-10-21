import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  PoolManager,
  type ResolvedResource,
  restConnector,
  runQuery,
  testResource,
} from '../src'
import { resource, scopeEvaluator } from './helpers'

let server: Server
let port: number
let origin: string
let pool: PoolManager
let tokenVersion = 1
let tokenRequests = 0

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const raw = await readBody(req)
    const body = raw.toString()
    switch (url.pathname) {
      case '/api/raw':
        return json(res, 200, { contentType: req.headers['content-type'], base64: raw.toString('base64') })
      case '/api/echo':
        return json(res, 200, {
          method: req.method,
          path: url.pathname,
          query: url.search,
          headers: req.headers,
          body,
        })
      case '/api/redirect-same':
        res.writeHead(302, { location: '/api/echo?from=redirect' })
        return res.end()
      case '/api/redirect-localhost':
        res.writeHead(307, { location: `http://localhost:${port}/api/echo` })
        return res.end()
      case '/api/loop':
        res.writeHead(302, { location: '/api/loop' })
        return res.end()
      case '/api/fail':
        return json(res, 422, { error: 'nope', reason: 'validation' })
      case '/api/big':
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end('x'.repeat(2 * 1024 * 1024))
      case '/api/binary':
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(Buffer.from([0, 1, 2, 255]))
      case '/api/slow':
        setTimeout(() => json(res, 200, { ok: true }), 2000)
        return
      case '/oauth/token': {
        tokenRequests++
        const form = new URLSearchParams(body)
        if (form.get('client_secret') !== 'cs-secret-value')
          return json(res, 401, { error: 'invalid_client' })
        return json(res, 200, { access_token: `token-v${tokenVersion}`, expires_in: 3600 })
      }
      case '/api/protected':
        if (req.headers.authorization !== `Bearer token-v${tokenVersion}`)
          return json(res, 401, { error: 'expired' })
        return json(res, 200, { ok: true, token: req.headers.authorization })
      default:
        return json(res, 404, { error: 'not found' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool?.closeAll()
  await new Promise((r) => server?.close(r))
})

const restResource = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = {},
): ResolvedResource => resource({ baseUrl: `${origin}/api`, allowPrivateNetwork: true, ...config }, secrets)

const run = (
  res: ResolvedResource,
  query: Record<string, unknown>,
  scope: Record<string, unknown> = {},
  timeoutMs?: number,
) => runQuery(pool, restConnector, res, query, { evaluate: scopeEvaluator(scope), timeoutMs })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the request to fail')
}

// biome-ignore lint/suspicious/noExplicitAny: echo responses are untyped JSON
type Echo = any

describe('requests', () => {
  it('renders the path, params, headers and a JSON body from {{ }}', async () => {
    const res = restResource({
      headers: [{ key: 'x-static', value: 'yes' }],
      params: [{ key: 'v', value: '2' }],
    })
    const result = await run(
      res,
      {
        method: 'POST',
        path: '/echo',
        params: [{ key: 'q', value: 'id {{ id }}' }],
        headers: [{ key: 'x-user', value: '{{ user.name }}' }],
        body: { type: 'json', json: '{"id": {{ id }}, "user": {{ user }}, "note": "hi {{ user.name }}"}' },
      },
      { id: 5, user: { name: 'Ada "A"' } },
    )
    const echo = result.data as Echo
    expect(echo.method).toBe('POST')
    expect(echo.query).toBe('?v=2&q=id+5')
    expect(echo.headers).toMatchObject({
      'x-static': 'yes',
      'x-user': 'Ada "A"',
      'content-type': 'application/json',
    })
    expect(JSON.parse(echo.body)).toEqual({ id: 5, user: { name: 'Ada "A"' }, note: 'hi Ada "A"' })
    expect(result.metadata).toMatchObject({ status: 200, statusText: 'OK' })
  })

  it('sends form and raw bodies', async () => {
    const res = restResource()
    const form = await run(
      res,
      {
        method: 'POST',
        path: 'echo',
        body: {
          type: 'form',
          fields: [
            { key: 'a', value: '{{ x }}' },
            { key: 'b', value: 'c&d' },
          ],
        },
      },
      { x: 1 },
    )
    expect((form.data as Echo).body).toBe('a=1&b=c%26d')
    expect((form.data as Echo).headers['content-type']).toBe('application/x-www-form-urlencoded')
    const raw = await run(
      res,
      {
        method: 'PUT',
        path: 'echo',
        body: { type: 'raw', raw: '<x>{{ x }}</x>', contentType: 'application/xml' },
      },
      { x: 2 },
    )
    expect((raw.data as Echo).body).toBe('<x>2</x>')
  })

  it('sends multipart bodies: text fields, files from base64 and from a webhook file object', async () => {
    const pdf = Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i))
    const upload = {
      filename: 'scan.png',
      contentType: 'image/png',
      size: 3,
      base64: Buffer.from([1, 2, 3]).toString('base64'),
    }
    const result = await run(
      restResource(),
      {
        method: 'POST',
        path: 'raw',
        // A Content-Type of the query's own would lose the boundary: it's dropped.
        headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          type: 'multipart',
          parts: [
            { kind: 'text', key: 'note', value: 'order {{ id }}' },
            {
              kind: 'file',
              key: 'invoice',
              file: '{{ pdf }}',
              filename: 'invoice-{{ id }}.pdf',
              contentType: 'application/pdf',
            },
            { kind: 'file', key: 'scan', file: '{{ upload }}' },
            { kind: 'file', key: 'plain', file: '{{ plain }}' },
            { kind: 'text', key: '', value: 'skipped' },
          ],
        },
      },
      { id: 7, pdf: pdf.toString('base64'), upload, plain: Buffer.from('hi').toString('base64') },
    )
    const echo = result.data as Echo
    expect(echo.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const sent = Buffer.from(echo.base64, 'base64')
    // Read back with an independent parser (undici's; the boundary fetch picks is random, so it's safe there).
    const form = await new Response(sent, { headers: { 'content-type': echo.contentType } }).formData()
    expect([...form.keys()]).toEqual(['note', 'invoice', 'scan', 'plain'])
    expect(form.get('note')).toBe('order 7')
    const invoice = form.get('invoice') as File
    expect([invoice.name, invoice.type]).toEqual(['invoice-7.pdf', 'application/pdf'])
    expect(Buffer.from(await invoice.arrayBuffer()).equals(pdf)).toBe(true)
    const scan = form.get('scan') as File
    expect([scan.name, scan.type, Buffer.from(await scan.arrayBuffer())]).toEqual([
      'scan.png',
      'image/png',
      Buffer.from([1, 2, 3]),
    ])
    const plain = form.get('plain') as File
    expect([plain.name, plain.type, await plain.text()]).toEqual(['plain', 'application/octet-stream', 'hi'])
  })

  it('refuses a file part that is neither base64 nor a file object', async () => {
    for (const value of ['not base64!', 42, { name: 'x' }, null]) {
      const err = await failure(
        run(
          restResource(),
          {
            method: 'POST',
            path: 'raw',
            body: { type: 'multipart', parts: [{ kind: 'file', key: 'f', file: '{{ v }}' }] },
          },
          { v: value },
        ),
      )
      expect(err).toMatchObject({
        code: 'query',
        message: expect.stringMatching(/^File part "f" needs base64 text/),
      })
    }
  })

  it('decodes binary bodies as base64', async () => {
    const result = await run(restResource(), { path: 'binary' })
    expect(result.data).toBe(Buffer.from([0, 1, 2, 255]).toString('base64'))
    expect(result.metadata.encoding).toBe('base64')
  })

  it('turns non-2xx responses into errors with the status and a body preview', async () => {
    const err = await failure(run(restResource(), { path: 'fail' }))
    expect(err).toMatchObject({
      code: 'http',
      message: 'HTTP 422 Unprocessable Entity',
      details: { status: 422 },
    })
    expect(String(err.details?.body)).toContain('validation')
  })

  it('rejects a body on GET', async () => {
    const err = await failure(
      run(restResource(), { method: 'GET', path: 'echo', body: { type: 'raw', raw: 'x' } }),
    )
    expect(err.code).toBe('invalid_query')
  })

  it('caps response size and enforces the timeout', async () => {
    expect((await failure(run(restResource({ maxResponseBytes: 1024 * 1024 }), { path: 'big' }))).code).toBe(
      'too_large',
    )
    expect((await failure(run(restResource(), { path: 'slow' }, {}, 200))).code).toBe('timeout')
  })
})

describe('auth and secrets', () => {
  it('sends API keys, bearer and basic credentials, and scrubs them from the result', async () => {
    const header = await run(
      restResource({ auth: { type: 'apiKey', name: 'x-api-key' } }, { apiKey: 'k-header-secret' }),
      { path: 'echo' },
    )
    expect(JSON.stringify(header)).not.toContain('k-header-secret')
    expect((header.data as Echo).headers['x-api-key']).toBe('[REDACTED]')

    const query = await run(
      restResource({ auth: { type: 'apiKey', in: 'query', name: 'key' } }, { apiKey: 'k-query-secret' }),
      { path: 'echo' },
    )
    expect((query.data as Echo).query).toBe('?key=[REDACTED]')
    expect(String(query.metadata.url)).toContain('key=[REDACTED]')

    const bearer = await run(restResource({ auth: { type: 'bearer' } }, { bearerToken: 'b-token-secret' }), {
      path: 'echo',
    })
    expect((bearer.data as Echo).headers.authorization).toBe('Bearer [REDACTED]')

    const basic = await run(
      restResource({ auth: { type: 'basic', username: 'ada' } }, { password: 'pw-secret' }),
      { path: 'echo' },
    )
    expect((basic.data as Echo).headers.authorization).toBe(
      `Basic ${Buffer.from('ada:pw-secret').toString('base64')}`,
    )

    const secretHeader = await run(restResource({}, { headers: { 'x-token': 'hdr-secret-value' } }), {
      path: 'echo',
    })
    expect((secretHeader.data as Echo).headers['x-token']).toBe('[REDACTED]')
  })

  it('reports a missing credential as a config error', async () => {
    const err = await failure(run(restResource({ auth: { type: 'bearer' } }), { path: 'echo' }))
    expect(err).toMatchObject({ code: 'invalid_config', message: expect.stringMatching(/Bearer token/) })
  })

  it('caches OAuth2 client-credentials tokens and refreshes once on 401', async () => {
    const res = restResource(
      { auth: { type: 'oauth2ClientCredentials', tokenUrl: `${origin}/oauth/token`, clientId: 'cid' } },
      { clientSecret: 'cs-secret-value' },
    )
    tokenRequests = 0
    await run(res, { path: 'protected' })
    await run(res, { path: 'protected' })
    expect(tokenRequests).toBe(1)

    tokenVersion++ // the server revokes the old token
    const result = await run(res, { path: 'protected' })
    expect((result.data as Echo).ok).toBe(true)
    expect(tokenRequests).toBe(2)

    const bad = restResource(
      { auth: { type: 'oauth2ClientCredentials', tokenUrl: `${origin}/oauth/token`, clientId: 'cid' } },
      { clientSecret: 'wrong' },
    )
    expect((await failure(run(bad, { path: 'protected' }))).message).toMatch(
      /OAuth2 token request failed: HTTP 401/,
    )
  })
})

describe('OAuth2 authorization code', () => {
  const codeResource = () =>
    restResource({
      auth: {
        type: 'oauth2AuthorizationCode',
        authorizeUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
      },
    })

  /** Hands out `token-v<n>`: the stored one, or the current one when forced (a refresh). */
  function credentials(stored: number) {
    const calls: { force: boolean }[] = []
    return {
      calls,
      source: {
        async accessToken({ force }: { signal: AbortSignal; force?: boolean }) {
          calls.push({ force: !!force })
          return `token-v${force ? tokenVersion : stored}`
        },
      },
    }
  }

  const runWith = (res: ResolvedResource, query: Record<string, unknown>, source?: unknown) =>
    runQuery(pool, restConnector, res, query, {
      evaluate: scopeEvaluator({}),
      ...(source ? { credentials: source as never } : {}),
    })

  it('sends the connection’s token, refreshing once when the API refuses it', async () => {
    const fresh = credentials(tokenVersion)
    const ok = await runWith(codeResource(), { path: 'protected' }, fresh.source)
    expect((ok.data as Echo).ok).toBe(true)
    expect(fresh.calls).toEqual([{ force: false }])

    const stale = credentials(tokenVersion - 1)
    const retried = await runWith(codeResource(), { path: 'protected' }, stale.source)
    expect((retried.data as Echo).ok).toBe(true)
    expect(stale.calls).toEqual([{ force: false }, { force: true }])
  })

  it('fails with the second 401 rather than looping', async () => {
    const calls: boolean[] = []
    const source = {
      async accessToken({ force }: { force?: boolean }) {
        calls.push(!!force)
        return 'token-never-valid'
      },
    }
    const err = await failure(runWith(codeResource(), { path: 'protected' }, source))
    expect(err).toMatchObject({ code: 'http', details: { status: 401 } })
    expect(calls).toEqual([false, true])
  })

  it('asks for a connection when there is none', async () => {
    const err = await failure(runWith(codeResource(), { path: 'echo' }))
    expect(err).toMatchObject({ code: 'auth_required', message: expect.stringMatching(/Connect an account/) })

    const revoked = {
      async accessToken(): Promise<string> {
        throw new ConnectorError('auth_required', 'Reconnect the account', { reason: 'invalid_grant' })
      },
    }
    expect(await failure(runWith(codeResource(), { path: 'echo' }, revoked))).toMatchObject({
      code: 'auth_required',
      message: 'Reconnect the account',
      details: { reason: 'invalid_grant' },
    })
  })

  it('scrubs the access token from what the API echoes back', async () => {
    const source = { accessToken: async () => 'at-echoed-0123456789' }
    const result = await runWith(codeResource(), { path: 'echo' }, source)
    expect((result.data as Echo).headers.authorization).toBe('Bearer [REDACTED]')
    expect(JSON.stringify(result)).not.toContain('at-echoed-0123456789')
  })

  it('tests the connection with the token', async () => {
    const res = restResource({
      baseUrl: `${origin}/api/protected`,
      auth: {
        type: 'oauth2AuthorizationCode',
        authorizeUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
      },
    })
    const ok = await testResource(restConnector, res, { credentials: credentials(tokenVersion).source })
    expect(ok).toMatchObject({ ok: true, message: 'HTTP 200 OK' })
    const none = await testResource(restConnector, res)
    expect(none).toMatchObject({ ok: false, error: { code: 'auth_required' } })
  })
})

describe('network guard', () => {
  it('blocks private addresses unless the resource allows them', async () => {
    const literal = await failure(run(restResource({ allowPrivateNetwork: false }), { path: 'echo' }))
    expect(literal).toMatchObject({ code: 'blocked', message: '127.0.0.1 is a private address' })

    // A hostname is resolved and checked when the socket connects (DNS rebinding can't sneak past).
    const named = restResource({ baseUrl: `http://localhost:${port}/api`, allowPrivateNetwork: false })
    const err = await failure(run(named, { path: 'echo' }))
    expect(err.code).toBe('blocked')
    expect(err.message).toMatch(/localhost resolves to a private address/)
  })

  it('only reaches the base host and allowed hosts', async () => {
    const res = restResource()
    const err = await failure(run(res, { path: 'http://example.com/steal' }))
    expect(err).toMatchObject({
      code: 'blocked',
      message: expect.stringMatching(/example.com isn't allowed/),
    })
    // Not an http(s) URL, so it's a path under the base URL: it can't leave the base host.
    const local = await failure(run(res, { path: 'file:///etc/passwd' }))
    expect(local).toMatchObject({ code: 'http', details: { status: 404 } })
  })

  it('checks every redirect hop and drops credentials when the origin changes', async () => {
    const auth = { auth: { type: 'bearer' } }
    const secrets = { bearerToken: 'redirect-token' }
    const same = await run(restResource(auth, secrets), { path: 'redirect-same' })
    expect((same.data as Echo).query).toBe('?from=redirect')
    expect((same.data as Echo).headers.authorization).toBe('Bearer [REDACTED]')

    const blocked = await failure(run(restResource(auth, secrets), { path: 'redirect-localhost' }))
    expect(blocked.code).toBe('blocked')

    const allowed = await run(restResource({ ...auth, allowedHosts: ['localhost'] }, secrets), {
      path: 'redirect-localhost',
    })
    expect((allowed.data as Echo).headers.authorization).toBeUndefined()

    expect((await failure(run(restResource(), { path: 'loop' }))).message).toMatch(/Too many redirects/)
  })
})

describe('testResource', () => {
  it('reports the HTTP status of the base URL', async () => {
    expect(await testResource(restConnector, restResource({ baseUrl: `${origin}/api/echo` }))).toMatchObject({
      ok: true,
      message: 'HTTP 200 OK',
    })
    const blocked = await testResource(restConnector, restResource({ allowPrivateNetwork: false }))
    expect(blocked).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })
})
