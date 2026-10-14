import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeFetcher, type CodeFetchRequest, ConnectorError } from '../src'

let server: Server
let port: number
let origin: string
/** Allows 127.0.0.1, as development and tests do. */
let local: CodeFetcher
/** The production default: private networks refused. */
let guarded: CodeFetcher

const get = (url: string, extra: Partial<CodeFetchRequest> = {}): CodeFetchRequest => ({
  url,
  method: 'GET',
  headers: [],
  body: null,
  ...extra,
})
const never = new AbortController().signal

async function failure(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeDefined()
  return err as Error & { code?: string }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let body = ''
    for await (const chunk of req) body += chunk
    switch (url.pathname) {
      case '/echo':
        res.writeHead(200, { 'content-type': 'application/json', 'x-reply': 'yes' })
        return res.end(JSON.stringify({ method: req.method, headers: req.headers, body, query: url.search }))
      case '/missing':
        res.writeHead(404, { 'content-type': 'text/plain' })
        return res.end('not here')
      case '/to-echo':
        res.writeHead(303, { location: '/echo?from=redirect' })
        return res.end()
      case '/to-other-origin':
        res.writeHead(307, { location: `http://localhost:${port}/echo` })
        return res.end()
      case '/to-file':
        res.writeHead(302, { location: 'file:///etc/passwd' })
        return res.end()
      case '/loop':
        res.writeHead(302, { location: '/loop' })
        return res.end()
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end('x'.repeat(2 * 1024 * 1024))
      case '/slow':
        setTimeout(() => res.end('late'), 5_000)
        return
    }
    res.writeHead(500)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
  local = new CodeFetcher({ allowPrivateNetwork: true, maxResponseBytes: 1024 * 1024 })
  guarded = new CodeFetcher()
})

afterAll(async () => {
  await local.close()
  await guarded.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

describe('CodeFetcher', () => {
  it('sends the method, headers and body, and returns status, headers and text', async () => {
    const res = await local.fetch(
      get(`${origin}/echo?q=1`, {
        method: 'post',
        headers: [
          ['Content-Type', 'application/json'],
          ['Host', 'evil.test'],
          ['X-Id', '7'],
        ],
        body: '{"a":1}',
      }),
      never,
    )
    expect(res).toMatchObject({ status: 200, statusText: 'OK', url: `${origin}/echo?q=1`, redirected: false })
    expect(res.headers).toContainEqual(['x-reply', 'yes'])
    const echo = JSON.parse(res.body)
    expect(echo).toMatchObject({ method: 'POST', body: '{"a":1}', query: '?q=1' })
    // The client sets Host itself.
    expect(echo.headers).toMatchObject({ 'x-id': '7', host: `127.0.0.1:${port}` })
  })

  it('returns non-2xx answers as responses', async () => {
    const res = await local.fetch(get(`${origin}/missing`), never)
    expect(res).toMatchObject({ status: 404, body: 'not here' })
  })

  it('follows redirects, turning a 303 into a GET', async () => {
    const res = await local.fetch(get(`${origin}/to-echo`, { method: 'POST', body: 'x' }), never)
    expect(res).toMatchObject({ status: 200, redirected: true, url: `${origin}/echo?from=redirect` })
    expect(JSON.parse(res.body)).toMatchObject({ method: 'GET', body: '' })
  })

  it('drops credentials when a redirect leaves the origin', async () => {
    const headers: [string, string][] = [
      ['Authorization', 'Bearer secret'],
      ['Cookie', 'a=1'],
      ['X-Keep', 'yes'],
    ]
    const res = await local.fetch(get(`${origin}/to-other-origin`, { headers }), never)
    const echo = JSON.parse(res.body)
    expect(echo.headers.authorization).toBeUndefined()
    expect(echo.headers.cookie).toBeUndefined()
    expect(echo.headers['x-keep']).toBe('yes')
  })

  it('checks every redirect hop and stops redirect loops', async () => {
    const file = await failure(local.fetch(get(`${origin}/to-file`), never))
    expect(file).toBeInstanceOf(ConnectorError)
    expect(file.message).toBe('Only http and https URLs are allowed (got file:)')
    const loop = await failure(local.fetch(get(`${origin}/loop`), never))
    expect(loop.message).toBe('Too many redirects (more than 5)')
  })

  it('refuses private, loopback and metadata addresses by default', async () => {
    for (const url of [
      `${origin}/echo`,
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://10.0.0.1/',
    ]) {
      const err = await failure(guarded.fetch(get(url), never))
      expect(err, url).toMatchObject({ code: 'blocked' })
    }
    // A hostname is checked on the addresses it resolves to.
    const named = await failure(guarded.fetch(get(`http://localhost:${port}/echo`), never))
    expect(named).toMatchObject({ code: 'blocked' })
    expect(named.message).toContain('resolves to a private address')
  })

  it('refuses bad URLs, methods and bodies', async () => {
    expect(await failure(local.fetch(get('/relative'), never))).toMatchObject({ code: 'invalid_query' })
    expect(await failure(local.fetch(get(`${origin}/echo`, { method: 'TRACE' }), never))).toMatchObject({
      code: 'invalid_query',
    })
    expect(await failure(local.fetch(get(`${origin}/echo`, { body: 'x' }), never))).toMatchObject({
      message: "GET requests can't have a body",
    })
  })

  it('caps the response size', async () => {
    const err = await failure(local.fetch(get(`${origin}/big`), never))
    expect(err).toMatchObject({ code: 'too_large' })
  })

  it('stops the request when the signal aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    const err = await failure(local.fetch(get(`${origin}/slow`), controller.signal))
    expect(err.name).toBe('AbortError')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
