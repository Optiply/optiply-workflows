/**
 * The SDK runner (M37, docs/architecture.md §2.41) against its real container: a Python and a JavaScript SDK made by
 * the resource's setup code, called, described and run as snippets; their network only through the proxy (the
 * allowed hosts, no private addresses unless allowed, nothing direct); the limits.
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executorAvailable, startTestSdkRunner, type TestSdkRunner } from '../src/testing'

interface Outcome {
  ok: boolean
  result?: unknown
  error?: { kind: string; message: string; line?: number | null; status?: number; type?: string }
  logs: { level: string; message: string }[]
  blocked: { host: string; reason: string }[]
  connections: number
}

const available = executorAvailable()
let sdk: TestSdkRunner
let api: Server
let host: string
const TOKEN = 'tok-Sdk-Secret-9'

beforeAll(async () => {
  if (!available) return
  // A company API: items in pages, its token checked.
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401)
      return res.end('{"error":"unauthorized"}')
    }
    if (url.pathname === '/items') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const items = Array.from({ length: 3 }, (_, i) => ({
        id: (page - 1) * 3 + i + 1,
        name: `item ${page}.${i}`,
      }))
      return res.end(JSON.stringify({ items, next: page < 4 ? page + 1 : null }))
    }
    res.end(JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams) }))
  })
  await new Promise<void>((resolve) => api.listen(0, '0.0.0.0', resolve))
  host = `host.docker.internal:${(api.address() as AddressInfo).port}`
  sdk = await startTestSdkRunner()
})
afterAll(async () => {
  await sdk?.stop()
  await new Promise((resolve) => api?.close(resolve))
})

const PY_SETUP = `
import json, urllib.request, urllib.parse

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status_code = status

class Items:
    def __init__(self, sdk):
        self.sdk = sdk
    def list(self, page=1):
        """One page of items."""
        return self.sdk.get("/items", page=page)["items"]
    def all(self):
        page = 1
        while page:
            body = self.sdk.get("/items", page=page)
            yield from body["items"]
            page = body["next"]

class Acme:
    def __init__(self, token, base_url):
        self.token, self.base_url = token, base_url
        self.items = Items(self)
    def get(self, path, **query):
        url = self.base_url + path + ("?" + urllib.parse.urlencode(query) if query else "")
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"})
        try:
            return json.loads(urllib.request.urlopen(req, timeout=10).read())
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, f"Acme answered {e.code}") from None
    async def ping(self, word):
        return {"pong": word}

def client(token, base_url, options):
    print("making the client for", options.get("tenant"))
    return Acme(token, base_url)
`

const JS_SETUP = `
class Items {
  #sdk
  constructor(sdk) { this.#sdk = sdk }
  async list({ page = 1 } = {}) { return (await this.#sdk.get('/items?page=' + page)).items }
  async *all() {
    for (let page = 1; page; ) {
      const body = await this.#sdk.get('/items?page=' + page)
      yield* body.items
      page = body.next
    }
  }
}
class Acme {
  constructor({ token, baseUrl }) { this.token = token; this.baseUrl = baseUrl; this.items = new Items(this) }
  async get(path) {
    const res = await fetch(this.baseUrl + path, { headers: { authorization: 'Bearer ' + this.token } })
    if (!res.ok) { const e = new Error('Acme answered ' + res.status); e.status = res.status; throw e }
    return res.json()
  }
  stats() { return { big: 12345678901234567890n, at: new Date(0), bytes: Buffer.from('hi'), tags: new Set(['a']) } }
}
export default ({ token, baseUrl, options }) => {
  console.log('making the client for', options.tenant)
  return new Acme({ token, baseUrl })
}
`

async function call(body: Record<string, unknown>, opts: { stream?: boolean } = {}): Promise<Outcome> {
  const res = await fetch(`${sdk.url}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sdk.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      context: { token: TOKEN, baseUrl: `http://${host}`, options: { tenant: 'optiply' } },
      allowedHosts: [host],
      allowPrivate: true,
      timeoutMs: 20_000,
      ...body,
      ...(opts.stream && { stream: true }),
    }),
  })
  expect(res.status).toBe(200)
  if (!opts.stream) return (await res.json()) as Outcome
  const lines = (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const outcome = lines.at(-1).outcome as Outcome
  return { ...outcome, logs: lines.slice(0, -1).map((l) => l.log) }
}

const python = (body: Record<string, unknown>) => call({ language: 'python', setup: PY_SETUP, ...body })
const node = (body: Record<string, unknown>) => call({ language: 'javascript', setup: JS_SETUP, ...body })

describe.skipIf(!available)('the SDK runner', () => {
  it('says which Python and Node it has', async () => {
    const health = await (await fetch(`${sdk.url}/health`)).json()
    expect(health).toMatchObject({
      ok: true,
      python: expect.stringMatching(/^3\.12\./),
      node: expect.stringMatching(/^v24\./),
    })
  })

  it('Python: calls a method with the token, positional or keyword arguments; pages a generator to the limit', async () => {
    const page = await python({ mode: 'call', method: 'items.list', args: { page: 2 } })
    expect(page).toMatchObject({ ok: true, result: [{ id: 4 }, { id: 5 }, { id: 6 }], connections: 1 })
    expect(page.logs).toEqual([{ level: 'log', message: 'making the client for optiply' }])
    expect((await python({ mode: 'call', method: 'items.list', args: [3] })).result).toEqual([
      { id: 7, name: 'item 3.0' },
      { id: 8, name: 'item 3.1' },
      { id: 9, name: 'item 3.2' },
    ])
    const all = await python({ mode: 'call', method: 'items.all', limit: 7 })
    expect((all.result as { id: number }[]).map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect((await python({ mode: 'call', method: 'ping', args: ['hi'] })).result).toEqual({ pong: 'hi' })
  })

  it('Python: describes the client, runs a snippet, says an SDK error’s status and a missing method', async () => {
    const described = await python({ mode: 'describe' })
    expect(described.result).toMatchObject({
      type: '__ow_setup__.Acme',
      members: expect.arrayContaining([
        { path: 'items.list', kind: 'method', signature: '(page=1)', doc: 'One page of items.' },
        { path: 'get', kind: 'method', signature: '(path, **query)', doc: '' },
      ]),
    })
    const snippet = await python({
      mode: 'code',
      code: 'print(params["n"])\nreturn client.get("/x", n=params["n"])',
      params: { n: 2 },
    })
    expect(snippet).toMatchObject({ ok: true, result: { path: '/x', query: { n: '2' } } })
    expect(snippet.logs.at(-1)).toEqual({ level: 'log', message: '2' })
    const refused = await python({
      mode: 'call',
      method: 'items.list',
      context: { token: 'wrong', baseUrl: `http://${host}`, options: {} },
    })
    expect(refused.error).toMatchObject({
      kind: 'sdk',
      type: 'ApiError',
      status: 401,
      message: 'ApiError: Acme answered 401',
    })
    expect((await python({ mode: 'call', method: 'items.nope' })).error).toMatchObject({
      kind: 'sdk_method',
      message: 'The client has no "items.nope" ("nope" is missing): see Describe',
    })
    expect((await python({ mode: 'call', method: '__class__' })).error?.kind).toBe('sdk_method')
    expect((await python({ mode: 'describe', setup: 'def client(:' })).error?.kind).toBe('setup')
  })

  it('JavaScript: calls, pages an async generator, converts BigInts, dates, bytes and sets; private fields stay out', async () => {
    const page = await node({ mode: 'call', method: 'items.list', args: { page: 2 } })
    expect(page).toMatchObject({ ok: true, result: [{ id: 4 }, { id: 5 }, { id: 6 }] })
    expect(page.logs).toEqual(
      [{ level: 'log', message: 'making the client for optiply\n' }].map((l) => ({
        ...l,
        message: l.message.trim(),
      })),
    )
    const all = await node({ mode: 'call', method: 'items.all', limit: 5 })
    expect((all.result as { id: number }[]).map((i) => i.id)).toEqual([1, 2, 3, 4, 5])
    expect((await node({ mode: 'call', method: 'stats' })).result).toEqual({
      big: '12345678901234567890',
      at: '1970-01-01T00:00:00.000Z',
      bytes: 'aGk=',
      tags: ['a'],
    })
    const described = await node({ mode: 'describe' })
    expect(described.result).toMatchObject({
      type: 'Acme',
      members: expect.arrayContaining([
        { path: 'items.list', kind: 'method', signature: '({ page = 1 } = {})' },
        { path: 'baseUrl', kind: 'value', type: 'string' },
      ]),
    })
    const snippet = await node({
      mode: 'code',
      code: 'return (await client.items.list({ page: params.page })).length',
      params: { page: 1 },
    })
    expect(snippet.result).toBe(3)
    const failed = await node({
      mode: 'call',
      method: 'items.list',
      context: { token: 'wrong', baseUrl: `http://${host}`, options: {} },
    })
    expect(failed.error).toMatchObject({ kind: 'sdk', status: 401, message: 'Error: Acme answered 401' })
    expect((await node({ mode: 'code', code: 'return ((' })).error?.kind).toBe('syntax')
  })

  it('lets only the resource’s hosts through, refuses private addresses unless allowed, and nothing goes direct', async () => {
    const other = await python({
      mode: 'code',
      code: 'import urllib.request\nreturn urllib.request.urlopen("https://example.com", timeout=5).status',
    })
    expect(other.ok).toBe(false)
    expect(other.blocked).toEqual([
      { host: 'example.com:443', reason: "example.com:443 isn't in this resource's allowed hosts" },
    ])
    expect(other.logs).toContainEqual({
      level: 'warn',
      message: "Blocked: example.com:443 isn't in this resource's allowed hosts",
    })
    const privateRefused = await python({ mode: 'call', method: 'items.list', allowPrivate: false })
    expect(privateRefused.blocked[0]?.reason).toMatch(/is on a private network/)
    const wildcard = await python({
      mode: 'call',
      method: 'items.list',
      allowedHosts: [`*.docker.internal:${host.split(':')[1]}`],
    })
    expect(wildcard.ok).toBe(true)
    const direct = await node({
      mode: 'code',
      code: "const net = await import('node:net'); return await new Promise((res) => net.connect(443, '1.1.1.1').on('error', (e) => res(e.code)))",
    })
    expect(direct.result).toBe('ENETUNREACH')
    const dns = await python({
      mode: 'code',
      code: 'import socket\nreturn socket.gethostbyname("example.com")',
    })
    expect(dns.error?.message).toMatch(/name resolution/)
  })

  it('leaves no thread behind a call, and answers one plain-HTTP request per connection (review fixes)', async () => {
    const threads = () =>
      Number(
        execFileSync('docker', ['exec', sdk.container!, 'sh', '-c', 'ls /proc/1/task | wc -l'])
          .toString()
          .trim(),
      )
    const before = threads()
    for (let i = 0; i < 12; i++) await python({ mode: 'call', method: 'ping', args: ['x'] })
    // Each call's proxy thread ends with the call.
    await expect.poll(threads, { timeout: 5_000 }).toBeLessThanOrEqual(before + 3)
    // A keep-alive request through the proxy: the upstream is told to close, so a next request comes on a new
    // connection (and is checked again) instead of going to this host.
    const raw = await python({
      mode: 'code',
      code: [
        'import socket',
        's = socket.create_connection(("127.0.0.1", 3128), timeout=10)',
        `s.sendall(b"GET http://${host}/a HTTP/1.1\\r\\nHost: ${host}\\r\\nAuthorization: Bearer ${TOKEN}\\r\\nConnection: keep-alive\\r\\n\\r\\n")`,
        'data = b""',
        'while True:',
        '    chunk = s.recv(65536)',
        '    if not chunk:',
        '        break',
        '    data += chunk',
        'return data.decode()',
      ].join('\n'),
    })
    expect(raw.ok).toBe(true)
    expect(String(raw.result)).toContain('"path":"/a"')
  })

  it('stops at the timeout and the memory limit; streams logs; refuses bad requests and missing envs', async () => {
    expect((await python({ mode: 'code', code: 'while True: pass', timeoutMs: 1500 })).error?.kind).toBe(
      'timeout',
    )
    const memory = await node({ mode: 'code', code: 'const a = []; for (;;) a.push(new Array(1e6).fill(1))' })
    expect(memory.error).toMatchObject({ kind: 'memory', message: expect.stringContaining('MB of memory') })
    const streamed = await call(
      { language: 'python', setup: PY_SETUP, mode: 'code', code: 'print("one")\nreturn 1' },
      { stream: true },
    )
    expect(streamed).toMatchObject({ ok: true, result: 1 })
    expect(streamed.logs.map((l) => l.message)).toEqual(['making the client for optiply', 'one'])
    const bad = await fetch(`${sdk.url}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sdk.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'ruby', mode: 'call', setup: '' }),
    })
    expect(bad.status).toBe(400)
    const hosts = await fetch(`${sdk.url}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sdk.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'python', mode: 'call', setup: '', allowedHosts: ['http://evil/'] }),
    })
    expect(hosts.status).toBe(400)
    expect((await fetch(`${sdk.url}/run`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await python({ mode: 'describe', envId: 'a'.repeat(32) })).error?.kind).toBe('sdk_install')
  })
})
