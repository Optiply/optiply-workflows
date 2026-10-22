import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readPrivateKey } from '../src/ssh/keys'
import { startTestSshServer, type TestSshServer } from '../src/ssh/testing'
import { SshError, type SshErrorCode, SshTunnel, type TunnelHop } from '../src/ssh/tunnel'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')

/** A TCP server that answers each line with `echo: <line>`, standing in for a database behind the SSH server. */
let echo: Server
let echoPort: number
let ssh: TestSshServer

beforeAll(async () => {
  echo = createServer((socket) => socket.on('data', (d) => socket.write(`echo: ${d}`)))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = (echo.address() as { port: number }).port
  ssh = await startTestSshServer({
    users: [
      { username: 'keyed', publicKey: fixture('openssh-ed25519.pub') },
      { username: 'putty', publicKey: fixture('openssh-rsa.pub') },
      { username: 'typed', password: 'Ssh-Pa55' },
    ],
    allowForward: (host, port) => host === '127.0.0.1' && port === echoPort,
  })
})
afterAll(async () => {
  await ssh?.close()
  await new Promise((r) => echo?.close(r))
})

const hop = (over: Partial<TunnelHop> = {}): TunnelHop => ({
  id: 'server',
  host: ssh.host,
  port: ssh.port,
  username: 'keyed',
  hostKey: ssh.hostKey,
  credential: { key: readPrivateKey(fixture('openssh-ed25519')) },
  ...over,
})

/** Sends a line through a stream and reads what comes back. */
function roundTrip(stream: Duplex, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stream.once('data', (d: Buffer) => resolve(d.toString()))
    stream.once('error', reject)
    stream.write(line)
  })
}

async function failure(tunnel: SshTunnel, port = echoPort): Promise<SshError> {
  try {
    await tunnel.open('127.0.0.1', port)
  } catch (err) {
    expect(err).toBeInstanceOf(SshError)
    return err as SshError
  } finally {
    await tunnel.close()
  }
  throw new Error('opened')
}

/** M17 step 2a: a tunnel through one SSH server. */
describe('SshTunnel', () => {
  it('signs in with a key and forwards to a host behind the server', async () => {
    const tunnel = new SshTunnel([hop()])
    const stream = await tunnel.open('127.0.0.1', echoPort)
    expect(await roundTrip(stream, 'ping')).toBe('echo: ping')
    expect(ssh.forwards.at(-1)).toEqual({ host: '127.0.0.1', port: echoPort, allowed: true })
    expect(tunnel.seen.get('server')).toEqual(ssh.hostKey)
    stream.end()
    await tunnel.close()
  })

  it('signs in with an encrypted PuTTY key, and with a password', async () => {
    for (const h of [
      hop({
        username: 'putty',
        credential: { key: readPrivateKey(fixture('ppk3-rsa-encrypted.ppk'), 'fixture pass') },
      }),
      hop({ username: 'typed', credential: { password: 'Ssh-Pa55' } }),
    ]) {
      const tunnel = new SshTunnel([h])
      expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), 'hi')).toBe('echo: hi')
      await tunnel.close()
    }
  })

  it('shares one SSH connection between the channels it opens, and ends it on close', async () => {
    // (The previous test's connection may still be closing on the server.)
    await vi.waitFor(() => expect(ssh.clients).toBe(0))
    const tunnel = new SshTunnel([hop()])
    const [a, b] = await Promise.all([tunnel.open('127.0.0.1', echoPort), tunnel.open('127.0.0.1', echoPort)])
    expect(await roundTrip(a, 'a')).toBe('echo: a')
    expect(await roundTrip(b, 'b')).toBe('echo: b')
    expect(ssh.clients).toBe(1)
    await tunnel.close()
    await vi.waitFor(() => expect(ssh.clients).toBe(0))
    await expect(tunnel.open('127.0.0.1', echoPort)).rejects.toThrow(/closed/)
  })

  it("refuses a host key that isn't trusted yet, showing the one presented", async () => {
    const err = await failure(new SshTunnel([hop({ hostKey: undefined })]))
    expect(err.code).toBe<SshErrorCode>('ssh_host_key_unknown')
    expect(err.hostKey).toEqual(ssh.hostKey)
    expect(err.message).toContain(ssh.hostKey.fingerprint)
  })

  it('refuses a host key other than the trusted one, with both fingerprints', async () => {
    const trusted = {
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK',
    }
    const err = await failure(new SshTunnel([hop({ hostKey: trusted })]))
    expect(err.code).toBe<SshErrorCode>('ssh_host_key_changed')
    expect(err.hostKey).toEqual({ ...ssh.hostKey, trusted: trusted.fingerprint })
    expect(err.message).toContain(trusted.fingerprint)
    expect(err.message).toContain(ssh.hostKey.fingerprint)
  })

  it('says when signing in is refused, the server is unreachable, or the forward is refused', async () => {
    const auth = await failure(new SshTunnel([hop({ username: 'typed', credential: { password: 'wrong' } })]))
    expect([auth.code, auth.message]).toEqual([
      'ssh_auth',
      `SSH server ${ssh.host}: signing in as typed was refused`,
    ])
    const otherKey = await failure(
      new SshTunnel([hop({ credential: { key: readPrivateKey(fixture('pem-rsa')) } })]),
    )
    expect(otherKey.code).toBe('ssh_auth')
    // A port nothing listens on.
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const port = (closed.address() as { port: number }).port
    await new Promise((r) => closed.close(r))
    const unreachable = await failure(new SshTunnel([hop({ port })]))
    expect(unreachable.code).toBe('ssh_connect')
    expect(unreachable.message).toContain('ECONNREFUSED')
    const refused = await failure(new SshTunnel([hop()]), echoPort + 1)
    expect(refused.code).toBe('ssh_forward')
    expect(ssh.forwards.at(-1)).toMatchObject({ allowed: false })
  })

  it('connects again on the next open after the connection drops', async () => {
    const tunnel = new SshTunnel([hop()])
    expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), '1')).toBe('echo: 1')
    ssh.dropAll()
    await vi.waitFor(() => expect(ssh.clients).toBe(0))
    expect(await roundTrip(await tunnel.open('127.0.0.1', echoPort), '2')).toBe('echo: 2')
    await tunnel.close()
  })
})
