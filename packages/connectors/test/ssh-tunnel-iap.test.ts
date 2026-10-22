import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serverIdentity } from '../src/google-auth'
import { configureIap, tunnelFor } from '../src/ssh/client'
import { normalizeSsh, type SshSecrets, sshConfigSchema } from '../src/ssh/settings'
import {
  startTestIapServer,
  startTestSshServer,
  type TestIapServer,
  type TestSshServer,
} from '../src/ssh/testing'
import { sshTunnelStats } from '../src/ssh/tunnel'
import { ConnectorError } from '../src/types'
import { FakeGoogle } from './google-fake'

// The first SSH server reached through Google IAP (M18): a fake Google issues the tokens, the fake IAP endpoint takes
// them and connects to the test SSH server (the "VM"), which forwards to an echo server (the "database").
const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
const google = new FakeGoogle()
let iap: TestIapServer
let ssh: TestSshServer
let echo: Server
let echoPort: number

beforeAll(async () => {
  await google.start()
  echo = createServer((socket) => socket.on('data', (d) => socket.write(`echo: ${d}`)))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = (echo.address() as { port: number }).port
  ssh = await startTestSshServer({
    users: [{ username: 'keyed', publicKey: fixture('openssh-ed25519.pub') }],
  })
  iap = await startTestIapServer({
    tokens: [],
    // Whatever the fake Google issued: a service account's (`sa-`) or the metadata server's (`md-`).
    accept: (token) => /^(sa|md)-\d+$/.test(token),
    instances: { 'proj/europe-west1-c/bastion': '127.0.0.1' },
  })
  configureIap({ url: iap.url, tokenUrl: google.tokenUrl })
})

afterEach(() => configureIap({ url: iap.url, tokenUrl: google.tokenUrl }))

afterAll(async () => {
  configureIap({})
  await iap.close()
  await ssh.close()
  await new Promise((r) => echo.close(r))
  await google.stop()
})

const viaIap = (over: Record<string, unknown> = {}) => ({
  id: 'bastion',
  reach: 'iap',
  iap: { project: 'proj', zone: 'europe-west1-c', instance: 'bastion', ...over },
  port: ssh.port,
  username: 'keyed',
  hostKey: ssh.hostKey,
})

const secrets = (over: Record<string, string> = {}): { ssh: SshSecrets } => ({
  ssh: { bastion: { privateKey: fixture('openssh-ed25519'), iapKey: google.keyJson, ...over } },
})

function roundTrip(stream: Duplex, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stream.once('data', (d: Buffer) => resolve(d.toString()))
    stream.once('error', reject)
    stream.write(line)
  })
}

describe('settings', () => {
  it('takes the VM name as the host, and keeps the IAP key only where it is used', () => {
    const config = sshConfigSchema.parse({ hops: [viaIap()] })
    expect(config.hops[0]).toMatchObject({
      host: 'bastion',
      reach: 'iap',
      iap: { interface: 'nic0', identity: 'key' },
    })
    expect(normalizeSsh(config, secrets().ssh).secrets?.bastion?.iapKey).toBe(google.keyJson)
    const asServer = sshConfigSchema.parse({ hops: [viaIap({ identity: 'server' })] })
    expect(normalizeSsh(asServer, secrets().ssh).secrets?.bastion).not.toHaveProperty('iapKey')
  })

  it('reaches only the first server through IAP, and needs the VM named', () => {
    const second = sshConfigSchema.safeParse({ hops: [viaIap(), { ...viaIap(), id: 'jump' }] })
    expect(second.error?.issues[0]).toMatchObject({ path: ['hops', 1, 'reach'] })
    const unnamed = sshConfigSchema.safeParse({ hops: [{ ...viaIap(), iap: undefined, host: 'x' }] })
    expect(unnamed.error?.issues[0]).toMatchObject({ path: ['hops', 0, 'iap'] })
  })
})

describe('a tunnel through IAP', () => {
  it('signs in with the service account key and reaches the database', async () => {
    const tunnel = tunnelFor({ ssh: sshConfigSchema.parse({ hops: [viaIap()] }) }, secrets())!
    const stream = await tunnel.open('127.0.0.1', echoPort)
    expect(await roundTrip(stream, 'hi')).toBe('echo: hi')
    expect(iap.connects.at(-1)).toMatchObject({ project: 'proj', instance: 'bastion', port: ssh.port })
    stream.destroy()
    await tunnel.close()
  })

  it('goes on to a jump host after the IAP hop', async () => {
    const jump = { id: 'inner', host: '127.0.0.1', port: ssh.port, username: 'keyed', hostKey: ssh.hostKey }
    const tunnel = tunnelFor(
      { ssh: sshConfigSchema.parse({ hops: [viaIap(), jump] }) },
      { ssh: { ...secrets().ssh, inner: { privateKey: fixture('openssh-ed25519') } } },
    )!
    const stream = await tunnel.open('127.0.0.1', echoPort)
    expect(await roundTrip(stream, 'deep')).toBe('echo: deep')
    stream.destroy()
    await tunnel.close()
  })

  it('carries on through a dropped IAP WebSocket', async () => {
    const tunnel = tunnelFor({ ssh: sshConfigSchema.parse({ hops: [viaIap()] }) }, secrets())!
    const stream = await tunnel.open('127.0.0.1', echoPort)
    expect(await roundTrip(stream, 'one')).toBe('echo: one')
    const before = sshTunnelStats.iapResumes
    iap.dropAll()
    expect(await roundTrip(stream, 'two')).toBe('echo: two')
    expect(sshTunnelStats.iapResumes).toBe(before + 1)
    stream.destroy()
    await tunnel.close()
  })

  it("uses the server's own identity only where the instance allows it", () => {
    const config = { ssh: sshConfigSchema.parse({ hops: [viaIap({ identity: 'server' })] }) }
    let refused: unknown
    try {
      tunnelFor(config, secrets())
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(ConnectorError)
    expect((refused as ConnectorError).code).toBe('invalid_config')
    expect((refused as Error).message).toContain("doesn't let resources use its own Google identity")
  })

  it("signs in as the server's own identity", async () => {
    configureIap({
      url: iap.url,
      serverIdentity: serverIdentity({
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        env: { GCE_METADATA_HOST: google.metadataHost },
      }),
    })
    const tunnel = tunnelFor(
      { ssh: sshConfigSchema.parse({ hops: [viaIap({ identity: 'server' })] }) },
      secrets(),
    )!
    const steps = await tunnel.probe()
    expect(steps.map((s) => [s.via ?? 'ssh', s.ok])).toEqual([
      ['iap', true],
      ['ssh', true],
    ])
    expect(steps[0]?.identity).toBe('vm@fake-project.iam.gserviceaccount.com')
    await tunnel.close()
  })
})

describe('Test connection through IAP', () => {
  it('reports the IAP step, then the SSH server', async () => {
    const tunnel = tunnelFor({ ssh: sshConfigSchema.parse({ hops: [viaIap()] }) }, secrets())!
    const steps = await tunnel.probe()
    expect(steps).toMatchObject([
      {
        via: 'iap',
        host: 'bastion',
        port: ssh.port,
        ok: true,
        identity: 'tunnel@fake-project.iam.gserviceaccount.com',
      },
      { hop: 'bastion', host: 'bastion', ok: true, hostKey: { status: 'trusted' } },
    ])
    await tunnel.close()
  })

  it('stops at the IAP step with what went wrong', async () => {
    const unknown = tunnelFor(
      { ssh: sshConfigSchema.parse({ hops: [viaIap({ instance: 'nope' })] }) },
      secrets(),
    )!
    const steps = await unknown.probe()
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ via: 'iap', ok: false, error: { code: 'iap_target' } })
    // A key Google doesn't know.
    const other = new FakeGoogle()
    const refused = tunnelFor(
      { ssh: sshConfigSchema.parse({ hops: [viaIap()] }) },
      secrets({ iapKey: other.keyJson }),
    )!
    const [step] = await refused.probe()
    expect(step).toMatchObject({ via: 'iap', ok: false, error: { code: 'iap_auth' } })
    expect(step?.error?.message).toContain('Google IAP: Google refused the service account key')
  })

  it('needs a key that is one', () => {
    expect(() =>
      tunnelFor(
        { ssh: sshConfigSchema.parse({ hops: [viaIap()] }) },
        secrets({ iapKey: '{"private_key":"k3y"}' }),
      ),
    ).toThrow(/SSH server bastion: The service account key is missing fields/)
  })
})
