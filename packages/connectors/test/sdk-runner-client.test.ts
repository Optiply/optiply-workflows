import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectorError, configureSdkRunner, SdkRunnerClient, type SdkRunRequest, sdkRunner } from '../src'

// The SDK runner's client (M37): the streamed protocol against a fake runner (the real one's tests are in
// apps/code-executor/test/sdk-runner.test.ts).

let server: Server
let url: string
let behaviour: 'stream' | 'busy' | 'refuse' | 'die' = 'stream'
const seen: { auth?: string; body: Record<string, unknown> }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
      if (behaviour === 'busy') {
        res.writeHead(503, { 'content-type': 'application/json' })
        return res.end('{"error":{"message":"busy"}}')
      }
      if (behaviour === 'refuse') {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end('{"error":{"message":"language is python or javascript"}}')
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ log: { level: 'log', message: 'making the client' } })}\n`)
      res.write(`${JSON.stringify({ log: { level: 'warn', message: 'Blocked: x' } })}\n`)
      if (behaviour === 'die') return res.destroy()
      res.end(
        `${JSON.stringify({ outcome: { ok: true, result: { id: 1 }, blocked: [], connections: 1 } })}\n`,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
afterAll(async () => {
  configureSdkRunner(null)
  await new Promise((resolve) => server.close(resolve))
})

const request: SdkRunRequest = {
  language: 'python',
  mode: 'call',
  setup: 'def client(): ...',
  method: 'items.list',
  context: { token: 't', baseUrl: null, options: {}, secrets: {} },
  allowedHosts: ['api.acme.com'],
  allowPrivate: false,
  timeoutMs: 10_000,
}

describe('SdkRunnerClient', () => {
  it('streams the call, its prints to onLog as they come, then the outcome; asks to stop before the timeout', async () => {
    behaviour = 'stream'
    const client = new SdkRunnerClient({ url, token: 'runner-token-123456' })
    const logs: string[] = []
    const outcome = await client.run(request, {
      signal: new AbortController().signal,
      onLog: (level, message) => logs.push(`${level}: ${message}`),
    })
    expect(outcome).toEqual({ ok: true, result: { id: 1 }, blocked: [], connections: 1 })
    expect(logs).toEqual(['log: making the client', 'warn: Blocked: x'])
    expect(seen.at(-1)).toMatchObject({
      auth: 'Bearer runner-token-123456',
      body: { stream: true, timeoutMs: 9500, method: 'items.list' },
    })
  })

  it('says when the runner is busy, refuses the call, goes away, or isn’t configured', async () => {
    const client = new SdkRunnerClient({ url, token: 'runner-token-123456' })
    const fail = async () => {
      try {
        await client.run(request, { signal: new AbortController().signal })
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError)
        return err as ConnectorError
      }
      throw new Error('Expected a failure')
    }
    behaviour = 'busy'
    expect((await fail()).message).toBe('The SDK runner is busy; try again')
    behaviour = 'refuse'
    expect((await fail()).message).toContain('refused the call (400): language is python or javascript')
    behaviour = 'die'
    expect((await fail()).code).toBe('sdk_unavailable')
    configureSdkRunner(null)
    expect(() => sdkRunner()).toThrow(/no SDK runner/)
  })
})
