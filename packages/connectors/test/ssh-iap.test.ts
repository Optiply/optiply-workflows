import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
