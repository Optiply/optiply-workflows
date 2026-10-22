import { readFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readPrivateKey } from '../src/ssh/keys'
import { startTestSshServer, type TestSshServer } from '../src/ssh/testing'
import { SshError, SshTunnel, sshTunnelStats, type TunnelHop } from '../src/ssh/tunnel'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
const key = readPrivateKey(fixture('openssh-ed25519'))

let echo: Server
let echoPort: number
/** outer → middle → inner → the echo server: each SSH server forwards only to the next. */
let outer: TestSshServer
let middle: TestSshServer
let inner: TestSshServer

beforeAll(async () => {
  echo = createServer((socket) => socket.on('data', (d) => socket.write(`echo: ${d}`)))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = (echo.address() as { port: number }).port
  const users = [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }]
  inner = await startTestSshServer({ users, allowForward: (_, port) => port === echoPort })
  middle = await startTestSshServer({ users, allowForward: (_, port) => port === inner.port })
  outer = await startTestSshServer({ users, allowForward: (_, port) => port === middle.port })
})
afterAll(async () => {
  for (const s of [outer, middle, inner]) await s?.close()
  await new Promise((r) => echo?.close(r))
})

const hopTo = (id: string, server: TestSshServer, over: Partial<TunnelHop> = {}): TunnelHop => ({
  id,
  host: server.host,
  port: server.port,
  username: 'ow',
  hostKey: server.hostKey,
  credential: { key },
  ...over,
})

function roundTrip(stream: Duplex, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stream.once('data', (d: Buffer) => resolve(d.toString()))
    stream.once('error', reject)
    stream.write(line)
  })
}

/**
 * A TCP proxy that can go silent: while `silent`, nothing passes either way and nothing closes, as when a network
 * drops packets. The SSH client only finds out through its keepalives.
 */
async function silenceable(target: number) {
  let silent = false
  const sockets = new Set<Socket>()
  const proxy = createServer((client) => {
    const upstream = connect(target, '127.0.0.1')
    for (const s of [client, upstream]) {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
      s.on('error', () => {})
    }
    client.on('data', (d) => silent || upstream.write(d))
    upstream.on('data', (d) => silent || client.write(d))
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  return {
    port: (proxy.address() as { port: number }).port,
    set silent(value: boolean) {
      silent = value
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        proxy.close(() => r())
      }),
  }
}

/** M17 step 2b: jump hosts, keepalives, and this process's tunnel counts. */
describe('SshTunnel through jump hosts', () => {
  it('reaches the database through two and three SSH servers, each forwarding only to the next', async () => {
    const two = new SshTunnel([hopTo('middle', middle), hopTo('inner', inner)])
    expect(await roundTrip(await two.open('127.0.0.1', echoPort), 'two')).toBe('echo: two')
    expect(middle.forwards.at(-1)).toEqual({ host: '127.0.0.1', port: inner.port, allowed: true })
    await two.close()
    const three = new SshTunnel([hopTo('outer', outer), hopTo('middle', middle), hopTo('inner', inner)])
    expect(await roundTrip(await three.open('127.0.0.1', echoPort), 'three')).toBe('echo: three')
    expect([...three.seen.keys()]).toEqual(['outer', 'middle', 'inner'])
    expect(three.seen.get('middle')).toEqual(middle.hostKey)
    await three.close()
  })

  it('says which server refused: a host key further in, or a forward the jump host refused', async () => {
    const untrusted = new SshTunnel([hopTo('middle', middle), hopTo('inner', inner, { hostKey: undefined })])
    const err = await untrusted.open('127.0.0.1', echoPort).catch((e: SshError) => e)
    expect(err).toBeInstanceOf(SshError)
    expect([(err as SshError).code, (err as SshError).hop.id]).toEqual(['ssh_host_key_unknown', 'inner'])
    expect((err as SshError).hostKey?.fingerprint).toBe(inner.hostKey.fingerprint)
    await untrusted.close()
    // outer may only forward to middle, not straight to inner.
    const skipping = new SshTunnel([hopTo('outer', outer), hopTo('inner', inner)])
    const refused = await skipping.open('127.0.0.1', echoPort).catch((e: SshError) => e)
    expect([(refused as SshError).code, (refused as SshError).hop.id]).toEqual(['ssh_forward', 'outer'])
    await skipping.close()
  })

  it('finds a connection gone silent through its keepalives, and connects again', async () => {
    const proxy = await silenceable(inner.port)
    const tunnel = new SshTunnel([hopTo('inner', inner, { port: proxy.port })], {
      keepaliveMs: 100,
      keepaliveCountMax: 2,
    })
    const open = sshTunnelStats.open
    const reconnects = sshTunnelStats.reconnects
    expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), 'before')).toBe('echo: before')
    expect(sshTunnelStats.open).toBe(open + 1)
    proxy.silent = true
    // No close, no error: only the unanswered keepalives tell.
    await vi.waitFor(() => expect(sshTunnelStats.open).toBe(open), { timeout: 3000 })
    proxy.silent = false
    expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), 'after')).toBe('echo: after')
    expect(sshTunnelStats.reconnects).toBe(reconnects + 1)
    await tunnel.close()
    expect(sshTunnelStats.open).toBe(open)
    await proxy.close()
  })

  it('connects again after the SSH server restarts', async () => {
    const tunnel = new SshTunnel([hopTo('inner', inner)])
    expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), '1')).toBe('echo: 1')
    await inner.restart()
    await vi.waitFor(async () => {
      expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), '2')).toBe('echo: 2')
    })
    await tunnel.close()
  })

  it("doesn't leave a connection behind when closed while still connecting", async () => {
    const open = sshTunnelStats.open
    const tunnel = new SshTunnel([hopTo('middle', middle), hopTo('inner', inner)])
    const opening = tunnel.open('127.0.0.1', echoPort)
    await tunnel.close()
    await expect(opening).rejects.toThrow(/closed/)
    expect(sshTunnelStats.open).toBe(open)
    await vi.waitFor(() => expect(inner.clients + middle.clients).toBe(0))
  })
})
