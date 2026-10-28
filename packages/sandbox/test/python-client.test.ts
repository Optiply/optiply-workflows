/** PythonExecutorClient against a fake executor: what it sends, and how it reads failures. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PythonExecutorClient, SandboxError } from '../src'

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void
let handler: Handler = () => {}
const seen: Record<string, unknown>[] = []
let url = ''
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (c) => {
    raw += c
  })
  req.on('end', () => {
    const body = JSON.parse(raw) as Record<string, unknown>
    seen.push({ path: req.url, auth: req.headers.authorization, ...body })
    handler(body, res)
  })
})
const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

// A short check timeout only where the fake never answers: elsewhere a busy CI runner can take longer than that to
// get the fake's immediate answer back (it did: "didn't answer within 0.3 s").
const client = (checkTimeoutMs = 30_000) =>
  new PythonExecutorClient({ url, token: 't'.repeat(16), checkTimeoutMs })
const failure = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(SandboxError)
  return err as SandboxError
}

it("asks the executor to stop before the run's timeout, and reports the run's own", async () => {
  handler = (_, res) =>
    json(res, {
      ok: false,
      error: { kind: 'timeout', message: 'x' },
      logs: [{ level: 'log', message: 'step 1' }],
    })
  const logs: unknown[][] = []
  const err = await failure(
    client().run('while True: pass', {}, { timeoutMs: 2000, onLog: (_, args) => logs.push(args) }),
  )
  expect(seen.at(-1)).toMatchObject({ path: '/run', auth: `Bearer ${'t'.repeat(16)}`, timeoutMs: 1500 })
  expect(err).toMatchObject({ kind: 'timeout', message: "The Python code didn't finish within 2000 ms" })
  // The prints made before the timeout arrive.
  expect(logs).toEqual([['step 1']])
})

it("never reads a failed check as 'no problems'", async () => {
  handler = (_, res) =>
    json(res, {
      ok: false,
      error: { kind: 'internal', message: "The executor couldn't start a jail: x" },
      logs: [],
    })
  expect(await failure(client().check([{ id: 'a', code: 'x' }]))).toMatchObject({
    kind: 'unavailable',
    message: "The Python executor couldn't check the code: The executor couldn't start a jail: x",
  })
})

it("gives up on a check that doesn't answer, and says so", async () => {
  handler = () => {} // never answers
  expect(await failure(client(300).check([{ id: 'a', code: 'x' }]))).toMatchObject({
    kind: 'unavailable',
    message: "The Python executor didn't answer within 0.3 s",
  })
})

it('reads busy and refusals as unavailable, and returns the problems of a check', async () => {
  handler = (_, res) => json(res, { error: { message: 'busy' } }, 503)
  expect((await failure(client().run('x', {}, { timeoutMs: 1000 }))).kind).toBe('unavailable')
  handler = (_, res) => json(res, { error: { message: 'A valid bearer token is required' } }, 401)
  expect((await failure(client().check([{ id: 'a', code: 'x' }]))).message).toContain('(401)')
  handler = (_, res) =>
    json(res, { ok: true, problems: [{ id: 'a', message: 'SyntaxError', line: 1, column: 2 }], logs: [] })
  expect(await client().check([{ id: 'a', code: 'x' }])).toEqual([
    { id: 'a', message: 'SyntaxError', line: 1, column: 2 },
  ])
})

const ndjson = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  return (item: unknown) => res.write(`${JSON.stringify(item)}\n`)
}

it('asks for a stream and logs each line as it arrives, before the outcome', async () => {
  let finish = () => {}
  handler = (_, res) => {
    const send = ndjson(res)
    send({ log: { level: 'log', message: 'one' } })
    send({ log: { level: 'error', message: 'two' } })
    finish = () => {
      send({ outcome: { ok: true, result: 3 } })
      res.end()
    }
  }
  const logs: [string, unknown[]][] = []
  const running = client().run('x', {}, { timeoutMs: 5000, onLog: (level, args) => logs.push([level, args]) })
  await expect.poll(() => logs.length).toBe(2)
  expect(seen.at(-1)).toMatchObject({ path: '/run', stream: true })
  finish()
  expect(await running).toBe(3)
  expect(logs).toEqual([
    ['log', ['one']],
    ['error', ['two']],
  ])
})

it('reads a stream that ends without its outcome as unavailable, keeping what was logged', async () => {
  handler = (_, res) => {
    ndjson(res)({ log: { level: 'log', message: 'started' } })
    setTimeout(() => res.destroy(), 50)
  }
  const logs: unknown[][] = []
  const err = await failure(client().run('x', {}, { timeoutMs: 5000, onLog: (_, args) => logs.push(args) }))
  expect(err.kind).toBe('unavailable')
  expect(err.message).toContain('The Python executor stopped answering')
  expect(logs).toEqual([['started']])
})

it('hangs up mid-stream when the work is aborted', async () => {
  let closed = false
  handler = (_, res) => {
    ndjson(res)({ log: { level: 'log', message: 'started' } })
    res.on('close', () => {
      closed = true
    })
  }
  const abort = new AbortController()
  const logs: unknown[][] = []
  const running = client().run(
    'x',
    {},
    { timeoutMs: 5000, signal: abort.signal, onLog: (_, a) => logs.push(a) },
  )
  await expect.poll(() => logs.length).toBe(1)
  abort.abort(new Error('cancelled'))
  await expect(running).rejects.toThrow('cancelled')
  await expect.poll(() => closed).toBe(true)
})
