/** `fetch` in code blocks: the sandbox bridge, the host's CodeFetcher, and aborting requests with the block. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CodeFetcher } from '@ow/connectors'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { code, run, testServices, wf } from './helpers'

const t = testServices()
let server: Server
let origin: string
/** Requests to /slow whose connection closed before the answer was sent, and those still open. */
let abandoned = 0
let open = 0
let local: CodeFetcher
let guarded: CodeFetcher

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/customers/7') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: 7, name: 'Ada' }))
    }
    if (req.url === '/slow') {
      open++
      const timer = setTimeout(() => res.end('late'), 10_000)
      res.on('close', () => {
        open--
        if (!res.writableEnded) abandoned++
        clearTimeout(timer)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  local = new CodeFetcher({ allowPrivateNetwork: true })
  guarded = new CodeFetcher()
})

beforeEach(() => {
  abandoned = 0
  t.reset()
})

afterAll(async () => {
  await local.close()
  await guarded.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await t.close()
})

const fetchingWorkflow = (src: string, settings?: object) =>
  wf([code('call', src, settings)], [['startTrigger', 'call']])

describe('fetch in code blocks', () => {
  it('fetches and parses JSON', async () => {
    const { outcome, data } = await run(
      { ...t.services, fetcher: local },
      fetchingWorkflow(
        `const res = await fetch("${origin}/customers/7")\nreturn { status: res.status, body: await res.json() }`,
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('call')).toEqual({ status: 200, body: { id: 7, name: 'Ada' } })
  })

  it("reports the guard's refusal as a fetch error that code can catch", async () => {
    const { outcome, data } = await run(
      { ...t.services, fetcher: guarded },
      fetchingWorkflow(
        `try { await fetch("${origin}/customers/7") } catch (e) { return e.name + ": " + e.message }`,
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('call')).toBe('TypeError: fetch failed: 127.0.0.1 is a private address')
  })

  it("fails without a fetcher, saying fetch isn't available", async () => {
    const { outcome } = await run(t.services, fetchingWorkflow(`return await fetch("${origin}/customers/7")`))
    expect(outcome.error).toMatchObject({
      block: 'call',
      message: expect.stringContaining("fetch isn't available here"),
    })
  })

  it('aborts an in-flight request when the block times out', async () => {
    const started = Date.now()
    const { outcome } = await run(
      { ...t.services, fetcher: local },
      fetchingWorkflow(`return await (await fetch("${origin}/slow")).text()`, { timeoutMs: 300 }),
    )
    expect(outcome.error).toMatchObject({ code: 'timeout', block: 'call' })
    await expect.poll(() => abandoned, { timeout: 2_000 }).toBe(1)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("aborts a request the code didn't wait for once the block finishes", async () => {
    const { outcome, data } = await run(
      { ...t.services, fetcher: local },
      fetchingWorkflow(`fetch("${origin}/slow").catch(() => {})\nreturn "done"`),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('call')).toBe('done')
    // Aborted before or after it reached the server: either way nothing is left open.
    await new Promise((r) => setTimeout(r, 300))
    await expect.poll(() => open, { timeout: 2_000 }).toBe(0)
  })
})
