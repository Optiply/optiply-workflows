import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { connect, createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureJdbcForwarder,
  configureJdbcRunner,
  JdbcForwarder,
  type JdbcRunner,
  jdbcConnector,
  parseResource,
} from '../src'
import { startTestSshServer, type TestSshServer } from '../src/testing'
import { resource } from './helpers'

// M38 step 4a: the JDBC runner's connections through a resource's SSH tunnel, by way of this process's forwarder. The
// "database" is an echo server named `db.internal`, which only the test SSH server resolves.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')

let ssh: TestSshServer
let echo: Server
let dbPort: number
let forwarder: JdbcForwarder
const closed: string[] = []

beforeAll(async () => {
  echo = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  dbPort = (echo.address() as AddressInfo).port
  ssh = await startTestSshServer({
    users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
    hosts: { 'db.internal': '127.0.0.1' },
  })
  forwarder = new JdbcForwarder({ port: 0, bind: '127.0.0.1', advertise: '127.0.0.1' })
  configureJdbcForwarder(forwarder)
  const runner: JdbcRunner = {
    query: async () => ({ data: [], metadata: {} }),
    test: async () => ({ message: 'ok' }),
    closePools: async (key) => {
      closed.push(key)
    },
  }
  configureJdbcRunner(runner)
})
afterAll(async () => {
  configureJdbcForwarder(null)
  configureJdbcRunner(null)
  await ssh?.close()
  await new Promise((r) => echo.close(r))
})

const settings = (over: Record<string, unknown> = {}) => ({
  driver: 'clickhouse',
  host: 'db.internal',
  port: dbPort,
  https: false,
  user: 'u',
  ssh: {
    hops: [
      { id: 'bastion', host: ssh.host, port: ssh.port, username: 'ow', auth: 'key', hostKey: ssh.hostKey },
    ],
  },
  tunnelHosts: [`db.internal:${dbPort}`],
  ...over,
})
const secrets = { password: 'pw', ssh: { bastion: { privateKey: fixture('openssh-ed25519') } } }

/** As the runner does: the hello line, then bytes; resolves with what came back before the end. */
function through(address: string, hello: string, payload = ''): Promise<string> {
  const [host, port] = address.split(':')
  return new Promise((resolve, reject) => {
    const s = connect(Number(port), host, () => s.write(`${hello}\n${payload}`))
    let got = ''
    s.on('data', (d) => {
      got += d.toString()
      if (got.startsWith('OK\n') && got.length >= 3 + payload.length) s.end()
    })
    s.on('close', () => resolve(got))
    s.on('error', reject)
  })
}

describe('the JDBC tunnel forwarder', () => {
  it('lets the runner through the resource’s tunnel to its own hosts, with its secret only', async () => {
    const client = await jdbcConnector.createClient(
      parseResource(jdbcConnector, resource(settings(), secrets)) as never,
    )
    const tunnel = client.connection.tunnel!
    expect(tunnel).toMatchObject({
      forwarder: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      hosts: [`db.internal:${dbPort}`],
      route: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(tunnel.secret).toMatch(/^[0-9a-f]{64}$/)

    expect(
      await through(tunnel.forwarder, `${tunnel.tunnelId} ${tunnel.secret} db.internal ${dbPort}`, 'ping'),
    ).toBe('OK\nping')
    expect(ssh.forwards.at(-1)).toEqual({ host: 'db.internal', port: dbPort, allowed: true })
    // Host names compare case-insensitively, as DNS does.
    expect(
      await through(tunnel.forwarder, `${tunnel.tunnelId} ${tunnel.secret} DB.Internal ${dbPort}`, 'x'),
    ).toBe('OK\nx')

    expect(
      await through(tunnel.forwarder, `${tunnel.tunnelId} ${'0'.repeat(64)} db.internal ${dbPort}`),
    ).toBe('ERR unknown tunnel\n')
    expect(await through(tunnel.forwarder, `nope ${tunnel.secret} db.internal ${dbPort}`)).toBe(
      'ERR unknown tunnel\n',
    )
    expect(
      await through(tunnel.forwarder, `${tunnel.tunnelId} ${tunnel.secret} other.internal 5432`),
    ).toMatch(/^ERR other\.internal:5432 isn't one of this resource's tunnel hosts/)

    await jdbcConnector.destroyClient(client)
    expect(closed.at(-1)).toBe(client.connection.poolKey)
    expect(await through(tunnel.forwarder, `${tunnel.tunnelId} ${tunnel.secret} db.internal ${dbPort}`)).toBe(
      'ERR unknown tunnel\n',
    )
  })

  it('closes a connection that never says hello', async () => {
    const client = await jdbcConnector.createClient(
      parseResource(jdbcConnector, resource(settings(), secrets)) as never,
    )
    const [host, port] = client.connection.tunnel!.forwarder.split(':')
    const ended = await new Promise<string>((resolve) => {
      const s = connect(Number(port), host, () => s.write('x'.repeat(2000)))
      s.on('close', () => resolve('closed'))
      s.on('error', () => {})
    })
    expect(ended).toBe('closed')
    await jdbcConnector.destroyClient(client)
  })

  it('checks the tunnel hosts against the URL', () => {
    const issues = (over: Record<string, unknown>) =>
      jdbcConnector.configSchema
        .safeParse(settings(over))
        .error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    expect(issues({})).toBeUndefined()
    expect(issues({ tunnelHosts: [] })).toEqual(['tunnelHosts: List the host:port the database is at'])
    expect(issues({ tunnelHosts: ['db.internal'] })).toEqual([
      'tunnelHosts.0: "db.internal" isn\'t host:port',
    ])
    expect(issues({ tunnelHosts: ['other.internal:8123'] })).toEqual([
      "tunnelHosts.0: The URL doesn't use other.internal: write it there as it is here",
    ])
  })
})
