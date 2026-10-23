import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { IAP_MAX_FRAME, IapError, type IapOptions, type IapTarget, openIapStream } from '../src/ssh/iap'
import { startTestIapServer, type TestIapServer } from '../src/ssh/testing'

// Against the fake IAP endpoint (ssh/testing.ts), whose "VM" is an echo server on loopback.
let iap: TestIapServer
let echo: Server
let echoPort: number
const target = (over: Partial<IapTarget> = {}): IapTarget => ({
  project: 'proj',
  zone: 'europe-west1-c',
  instance: 'bastion',
  port: echoPort,
  ...over,
})
const options = (over: Partial<IapOptions> = {}): IapOptions => ({
  getToken: async () => 'good-token',
  url: iap.url,
  ...over,
})

beforeAll(async () => {
  echo = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = (echo.address() as { port: number }).port
  iap = await startTestIapServer({
    tokens: ['good-token'],
    instances: { 'proj/europe-west1-c/bastion': '127.0.0.1' },
  })
})

afterAll(async () => {
  await iap.close()
  echo.close()
})

async function failure(promise: Promise<unknown>): Promise<IapError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(IapError)
  return err as IapError
}

/** Reads until `length` bytes came back. */
function readBytes(stream: NodeJS.ReadableStream, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let got = 0
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      got += chunk.length
      if (got >= length) {
        stream.off('data', onData)
        resolve(Buffer.concat(chunks))
      }
    }
    stream.on('data', onData)
    stream.once('error', reject)
  })
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('openIapStream', () => {
  it('connects as gcloud does and carries bytes both ways', async () => {
    const stream = await openIapStream(target(), options())
    expect(stream.sid).toMatch(/^sid-/)
    expect(iap.connects.at(-1)).toEqual({
      project: 'proj',
      zone: 'europe-west1-c',
      instance: 'bastion',
      port: echoPort,
      origin: 'bot:iap-tunneler',
    })
    stream.write('hello')
    expect((await readBytes(stream, 5)).toString()).toBe('hello')
    stream.destroy()
  })

  it('sends a megabyte in frames of at most 16 KiB, and acks what it receives', async () => {
    const stream = await openIapStream(target(), options())
    const data = randomBytes(1024 * 1024)
    const back = readBytes(stream, data.length)
    stream.write(data)
    expect(sha(await back)).toBe(sha(data))
    expect(iap.largestClientFrame).toBe(IAP_MAX_FRAME)
    // Acks go out once more than two frames are unacked: the last one is within that of everything.
    await expect.poll(() => iap.lastClientAck).toBeGreaterThan(data.length - 2 * IAP_MAX_FRAME - 1)
    expect(iap.lastClientAck).toBeLessThanOrEqual(data.length)
    stream.destroy()
  })

  it('ends when the VM side ends, and closes IAP when ours does', async () => {
    const stream = await openIapStream(target(), options())
    const ended = new Promise((r) => stream.once('close', r))
    const opened = iap.open
    stream.resume()
    stream.end()
    await ended
    await expect.poll(() => iap.open).toBe(opened - 1)
    // A VM side that says goodbye and hangs up.
    const bye = createServer((socket) => socket.end('bye'))
    await new Promise<void>((r) => bye.listen(0, '127.0.0.1', r))
    const fromVm = await openIapStream(target({ port: (bye.address() as { port: number }).port }), options())
    const chunks: Buffer[] = []
    fromVm.on('data', (c: Buffer) => chunks.push(c))
    await new Promise((r) => fromVm.once('end', r))
    expect(Buffer.concat(chunks).toString()).toBe('bye')
    bye.close()
  })

  it('refuses a token IAP does not accept as iap_auth', async () => {
    const err = await failure(openIapStream(target(), options({ getToken: async () => 'stale' })))
    expect(err.code).toBe('iap_auth')
    expect(err.message).toContain('HTTP 403: not authorized')
    expect(err.message).toContain('roles/iap.tunnelResourceAccessor')
  })

  it('takes a fresh token once when the handshake refuses a cached one, but not after IAP refused the VM', async () => {
    const asked: boolean[] = []
    const getToken = async (_signal: AbortSignal, force?: boolean) => {
      asked.push(!!force)
      return force ? 'good-token' : 'stale'
    }
    const stream = await openIapStream(target(), options({ getToken }))
    expect(asked).toEqual([false, true])
    stream.destroy()
    // 4033: IAP took the token and refused the target; a new token has the same roles.
    asked.length = 0
    iap.refuseNext(4033, 'not authorized')
    expect(
      (await failure(openIapStream(target(), options({ getToken: async () => 'good-token' })))).code,
    ).toBe('iap_auth')
    const once: boolean[] = []
    iap.refuseNext(4033, 'not authorized')
    await failure(
      openIapStream(
        target(),
        options({
          getToken: async (_s, force) => {
            once.push(!!force)
            return 'good-token'
          },
        }),
      ),
    )
    expect(once).toEqual([false])
  })

  it('fails a write that waits when IAP closes cleanly, rather than holding it forever', async () => {
    const bye = createServer((socket) => socket.end('bye'))
    await new Promise<void>((r) => bye.listen(0, '127.0.0.1', r))
    const stream = await openIapStream(target({ port: (bye.address() as { port: number }).port }), options())
    const closed = new Promise((r) => stream.once('close', r))
    stream.on('error', () => {})
    const late = new Promise<Error | null | undefined>((resolve) =>
      // Written as the stream ends, before it closes its writable side: it would wait for a WebSocket.
      stream.once('end', () => stream.write('late', resolve)),
    )
    stream.resume()
    expect(await late).toBeInstanceOf(Error)
    await closed
    bye.close()
  })

  it('fails on a frame cut short instead of throwing out of the WebSocket', async () => {
    // A hand-made endpoint: connects, then sends an ack frame two bytes short.
    const wss = new WebSocketServer({ port: 0, handleProtocols: (p) => [...p][0] ?? false })
    await new Promise((r) => wss.once('listening', r))
    const sid = Buffer.from('s1')
    const success = Buffer.alloc(6 + sid.length)
    success.writeUInt16BE(0x0001, 0)
    success.writeUInt32BE(sid.length, 2)
    sid.copy(success, 6)
    let mode: 'short-ack' | 'short-sid' = 'short-ack'
    wss.on('connection', (ws) => {
      if (mode === 'short-sid') return ws.send(success.subarray(0, 7))
      ws.send(success)
      setTimeout(() => ws.send(Buffer.from([0x00, 0x07, 0, 0, 0, 0, 0, 0])), 20)
    })
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/v4`
    const stream = await openIapStream(target(), options({ url }))
    const err = await new Promise<Error>((r) => stream.once('error', r))
    expect(err).toBeInstanceOf(IapError)
    expect(err.message).toContain('malformed frame')
    mode = 'short-sid'
    expect((await failure(openIapStream(target(), options({ url })))).message).toContain('malformed frame')
    await new Promise((r) => wss.close(r))
  })

  it('maps the close codes', async () => {
    const unknown = await failure(openIapStream(target({ instance: 'nope' }), options()))
    expect(unknown.code).toBe('iap_target')
    expect(unknown.message).toContain('4047 Failed to lookup instance')
    // A port nothing listens on.
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const port = (closed.address() as { port: number }).port
    await new Promise((r) => closed.close(r))
    const refused = await failure(openIapStream(target({ port }), options()))
    expect(refused.code).toBe('iap_target')
    expect(refused.message).toContain('35.235.240.0/20')
    iap.refuseNext(4033, 'not authorized')
    expect((await failure(openIapStream(target(), options()))).code).toBe('iap_auth')
    iap.refuseNext(4010, 'something else')
    const other = await failure(openIapStream(target(), options()))
    expect(other.code).toBe('iap_connect')
    expect(other.message).toContain('4010 something else')
  })

  it('gives up when IAP never answers', async () => {
    const silent = createServer(() => {})
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    const port = (silent.address() as { port: number }).port
    const started = performance.now()
    const err = await failure(
      openIapStream(target(), options({ url: `ws://127.0.0.1:${port}/v4`, connectTimeoutMs: 300 })),
    )
    expect(err.code).toBe('iap_connect')
    expect(err.message).toContain('in time')
    expect(performance.now() - started).toBeLessThan(2000)
    silent.close()
  })
})

describe('resuming', () => {
  it('resumes a dropped WebSocket in the middle of a transfer, nothing lost or doubled', async () => {
    const stream = await openIapStream(target(), options({ resumeDelayMs: 20 }))
    const data = randomBytes(4 * 1024 * 1024)
    const chunks: Buffer[] = []
    let got = 0
    let dropped = false
    const done = new Promise<void>((resolve) =>
      stream.on('data', (c: Buffer) => {
        chunks.push(c)
        got += c.length
        // Once some has come back, the network goes, with frames in flight both ways.
        if (!dropped && got > 256 * 1024) {
          dropped = true
          iap.dropAll()
        }
        if (got >= data.length) resolve()
      }),
    )
    for (let at = 0; at < data.length; at += 64 * 1024) stream.write(data.subarray(at, at + 64 * 1024))
    await done
    expect(got).toBe(data.length)
    expect(sha(Buffer.concat(chunks))).toBe(sha(data))
    expect(stream.resumes).toBeGreaterThanOrEqual(1)
    expect(iap.reconnects.at(-1)?.sid).toBe(stream.sid)
    stream.destroy()
  })

  it('takes a fresh token when IAP asks to authenticate again (4004)', async () => {
    const forced: boolean[] = []
    const stream = await openIapStream(
      target(),
      options({
        resumeDelayMs: 20,
        getToken: async (_signal, force) => {
          forced.push(force ?? false)
          return 'good-token'
        },
      }),
    )
    const resumed = new Promise((r) => stream.once('resumed', r))
    iap.reauthAll()
    await resumed
    expect(forced).toEqual([false, true])
    stream.write('still here')
    expect((await readBytes(stream, 10)).toString()).toBe('still here')
    stream.destroy()
  })

  it("stops resuming once our side ended, and doesn't reconnect after", async () => {
    const stream = await openIapStream(target(), options({ resumeDelayMs: 50, resumeWithinMs: 10_000 }))
    let failed: Error | undefined
    stream.on('error', (err) => (failed = err))
    const closed = new Promise((r) => stream.once('close', r))
    stream.resume()
    const before = iap.reconnects.length
    // Resuming fails meanwhile (the session is gone), so the stream keeps trying until our side ends.
    iap.forgetSessions()
    iap.dropAll()
    await expect.poll(() => iap.reconnects.length).toBeGreaterThan(before)
    stream.end()
    const started = performance.now()
    await closed
    expect(performance.now() - started).toBeLessThan(2000)
    expect(failed).toBeUndefined()
    const tried = iap.reconnects.length
    await new Promise((r) => setTimeout(r, 300))
    expect(iap.reconnects.length).toBe(tried)
  })

  it('fails when the session can no longer be resumed', async () => {
    const stream = await openIapStream(target(), options({ resumeDelayMs: 20, resumeWithinMs: 400 }))
    const failed = new Promise<Error>((r) => stream.once('error', r))
    stream.resume()
    iap.dropAll()
    iap.forgetSessions()
    const err = await failed
    expect(err).toBeInstanceOf(IapError)
    expect((err as IapError).code).toBe('iap_connect')
    expect(err.message).toContain("couldn't be resumed within")
    expect(err.message).toContain('4010 Invalid session id')
  })
})
