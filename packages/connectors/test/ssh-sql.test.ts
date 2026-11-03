import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { TLSSocket } from 'node:tls'
import { startTestDatabase } from '@ow/db/testing'
import mysql from 'mysql2/promise'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ConnectorError,
  mysqlConnector,
  PoolManager,
  parseResource,
  postgresConnector,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import {
  mysqlAvailable,
  startTestMysql,
  startTestSshServer,
  type TestMysql,
  type TestSshServer,
} from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

/**
 * M17 step 3a: Postgres and MySQL through an SSH tunnel. The databases are named `db.internal`, which only the test SSH
 * server resolves: a query that works went through the tunnel.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
const mysqlHere = mysqlAvailable()

let ssh: TestSshServer
let stopPg: () => Promise<void>
let pgAdmin: postgres.Sql
let pgBase: Record<string, unknown>
let pgPassword: string
let my: TestMysql | undefined
let pool: PoolManager

beforeAll(async () => {
  const pg = await startTestDatabase()
  stopPg = pg.stop
  const url = new URL(pg.url)
  pgPassword = decodeURIComponent(url.password)
  pgBase = {
    host: 'db.internal',
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    ssl: 'disable',
  }
  pgAdmin = postgres(pg.url, { onnotice: () => {} })
  await pgAdmin.unsafe(
    'create table customers (id int primary key); insert into customers select generate_series(1, 30)',
  )
  if (mysqlHere) my = await startTestMysql()
  ssh = await startTestSshServer({
    users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
    hosts: { 'db.internal': '127.0.0.1', 'tls.internal': '127.0.0.1' },
  })
  pool = new PoolManager({ sweepIntervalMs: 0 })
}, 240_000)
afterAll(async () => {
  await pool?.closeAll()
  await ssh?.close()
  await pgAdmin?.end()
  await stopPg?.()
  await my?.stop()
})

const tunnel = (over: Record<string, unknown> = {}) => ({
  hops: [
    {
      id: 'bastion',
      host: ssh.host,
      port: ssh.port,
      username: 'ow',
      auth: 'key',
      hostKey: ssh.hostKey,
      ...over,
    },
  ],
})
const keySecrets = { bastion: { privateKey: fixture('openssh-ed25519') } }

const pgResource = (
  ssh: unknown = tunnel(),
  version = '1',
  secrets: unknown = keySecrets,
): ResolvedResource => resource({ ...pgBase, ssh }, { password: pgPassword, ssh: secrets }, version)

const runPg = (res: ResolvedResource, sql: string, timeoutMs?: number) =>
  runQuery(pool, postgresConnector, res, { sql }, { evaluate: scopeEvaluator({}), timeoutMs })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('it worked')
}

describe('Postgres through an SSH tunnel', () => {
  it('runs queries and tests the connection through it', async () => {
    const res = pgResource(tunnel(), 'q')
    const result = await runPg(res, 'select count(*)::int as n from customers')
    expect(result.data).toEqual([{ n: 30 }])
    expect(ssh.forwards.at(-1)).toEqual({ host: 'db.internal', port: pgBase.port, allowed: true })
    const tested = await testResource(postgresConnector, res)
    expect(tested).toMatchObject({ ok: true, message: expect.stringContaining('PostgreSQL') })
    // Without the tunnel, db.internal is nowhere.
    const direct = await failure(runPg(resource(pgBase, { password: pgPassword }, 'direct'), 'select 1'))
    expect(direct.code).toBe('connection')
  })

  it('reports each SSH hop in Test connection, with its host key, before the database', async () => {
    const ok = await testResource(postgresConnector, pgResource(tunnel(), 'steps'))
    expect(ok).toMatchObject({
      ok: true,
      ssh: [
        {
          hop: 'bastion',
          host: ssh.host,
          port: ssh.port,
          ok: true,
          hostKey: { ...ssh.hostKey, status: 'trusted' },
        },
      ],
    })
    const untrusted = await testResource(
      postgresConnector,
      pgResource(tunnel({ hostKey: undefined }), 'steps-2'),
    )
    expect(untrusted).toMatchObject({
      ok: false,
      error: { code: 'connection', details: { ssh: { code: 'ssh_host_key_unknown', hop: 'bastion' } } },
      ssh: [
        {
          hop: 'bastion',
          ok: false,
          hostKey: { ...ssh.hostKey, status: 'untrusted' },
          error: { code: 'ssh_host_key_unknown' },
        },
      ],
    })
    // A key that can't be used fails before any hop is tried.
    const noKey = await testResource(postgresConnector, pgResource(tunnel(), 'steps-3', {}))
    expect(noKey).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
    expect('ssh' in noKey).toBe(false)
  })

  it('shares one SSH connection for the pool, and ends it with the pool client', async () => {
    await pool.closeAll()
    await vi.waitFor(() => expect(ssh.clients).toBe(0))
    const res = pgResource(tunnel(), 'shared')
    await Promise.all([1, 2, 3, 4].map((i) => runPg(res, `select ${i}, pg_sleep(0.1)`)))
    expect(ssh.clients).toBe(1)
    await pool.closeAll()
    await vi.waitFor(() => expect(ssh.clients).toBe(0))
  })

  it('ends a tunnelled client at once (postgres says goodbye only to a socket that looks open)', async () => {
    const client = await postgresConnector.createClient(
      parseResource(postgresConnector, pgResource(tunnel(), 'end')) as never,
    )
    await (client as unknown as { sql: postgres.Sql }).sql`select 1`
    const started = performance.now()
    await postgresConnector.destroyClient(client)
    // Well under postgres's 5 s end timeout, which every pool end used to wait out.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('checks a verify-full certificate against the host, through the tunnel', async () => {
    // A server that answers postgres's SSLRequest and then speaks TLS as `api.internal` (the test CA's certificate).
    const tlsFixture = (name: string) =>
      readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url), 'utf8')
    const fake = createServer((socket) => {
      socket.once('data', () => {
        socket.write('S')
        const secure = new TLSSocket(socket, {
          isServer: true,
          key: tlsFixture('api.internal.key'),
          cert: tlsFixture('api.internal.crt'),
        })
        secure.on('error', () => {})
        // Past the handshake: that's all this server does.
        secure.once('secure', () => secure.destroy())
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
    const port = (fake.address() as { port: number }).port
    const through = (host: string, version: string) =>
      runPg(
        resource(
          { ...pgBase, host, port, ssl: 'verify-full', caCert: tlsFixture('ca.crt'), ssh: tunnel() },
          { password: 'x', ssh: keySecrets },
          version,
        ),
        'select 1',
      )
    // The certificate is api.internal's: under another name it's refused by the check, with that name.
    const wrongName = await failure(through('tls.internal', 'tls-wrong'))
    expect(wrongName.message).toMatch(/Host: tls\.internal\. is not in the cert's altnames/)
    // (Before the fix, the name checked was "localhost", whatever the host.)
    expect(wrongName.message).not.toMatch(/localhost/)
    fake.close()
  })

  it('cancels a query that runs too long, through the tunnel too', async () => {
    const res = pgResource(tunnel(), 'cancel')
    const err = await failure(runPg(res, 'select pg_sleep(30)', 500))
    expect(err.code).toBe('timeout')
    // The cancel request is its own connection, so its own channel; the backend stops sleeping.
    await vi.waitFor(async () => {
      const rows =
        await pgAdmin`select count(*)::int as n from pg_stat_activity where query = 'select pg_sleep(30)' and state = 'active'`
      expect(rows[0]!.n).toBe(0)
    })
  })

  it('refuses an untrusted host key, with the fingerprint, before the database sees anything', async () => {
    const before = ssh.forwards.length
    const err = await failure(runPg(pgResource(tunnel({ hostKey: undefined }), 'untrusted'), 'select 1'))
    expect(err.code).toBe('connection')
    expect(err.details).toMatchObject({
      ssh: {
        code: 'ssh_host_key_unknown',
        hop: 'bastion',
        hostKey: { fingerprint: ssh.hostKey.fingerprint },
      },
    })
    expect(ssh.forwards.length).toBe(before)
  })

  it("says when the key can't be used, before connecting", async () => {
    const locked = { bastion: { privateKey: fixture('openssh-rsa-encrypted'), passphrase: 'wrong' } }
    const err = await failure(runPg(pgResource(tunnel(), 'locked', locked), 'select 1'))
    expect([err.code, err.message]).toEqual([
      'invalid_config',
      `SSH server ${ssh.host}: The passphrase doesn't open this key`,
    ])
  })

  it('carries on after the SSH server restarts', async () => {
    const res = pgResource(tunnel(), 'restart')
    expect((await runPg(res, 'select 1 as one')).data).toEqual([{ one: 1 }])
    await ssh.restart()
    // vi.waitFor's default 1 s wasn't enough on a GitHub runner (2026-11-03): the pool's first try after the restart
    // fails and the tunnel reconnects on the next.
    await vi.waitFor(
      async () => {
        expect((await runPg(res, 'select 2 as two')).data).toEqual([{ two: 2 }])
      },
      { timeout: 15_000, interval: 250 },
    )
  })
})

describe.skipIf(!mysqlHere)('MySQL through an SSH tunnel', () => {
  const myResource = (version: string, config: Record<string, unknown> = {}) =>
    resource(
      {
        host: 'db.internal',
        port: my!.port,
        database: my!.database,
        user: my!.user,
        ssl: 'disable',
        ssh: tunnel(),
        ...config,
      },
      { password: my!.password, ssh: keySecrets },
      version,
    )
  const runMy = (res: ResolvedResource, sql: string, timeoutMs?: number) =>
    runQuery(pool, mysqlConnector, res, { sql }, { evaluate: scopeEvaluator({}), timeoutMs })

  it('runs queries through it, over TLS too', async () => {
    expect((await runMy(myResource('my'), 'SELECT 1 + 1 AS two')).data).toEqual([{ two: 2 }])
    expect(ssh.forwards.at(-1)).toEqual({ host: 'db.internal', port: my!.port, allowed: true })
    const tls = await runMy(myResource('my-tls', { ssl: 'require' }), "SHOW SESSION STATUS LIKE 'Ssl_cipher'")
    expect((tls.data as { Value: string }[])[0]!.Value).not.toBe('')
    expect(await testResource(mysqlConnector, myResource('my-test'))).toMatchObject({ ok: true })
  })

  it("gives the SSH servers their time before MySQL's own connect timeout", async () => {
    const client = await mysqlConnector.createClient(
      parseResource(mysqlConnector, myResource('my-timeout')) as never,
    )
    // 10 s for MySQL, plus 15 s for the one SSH server: a slow bastion fails as the SSH error that says so.
    expect(
      (client as unknown as { connectionOptions: { connectTimeout: number } }).connectionOptions
        .connectTimeout,
    ).toBe(25_000)
    await mysqlConnector.destroyClient(client)
  })

  it('kills a query that runs too long from a side connection through it', async () => {
    const root = await mysql.createConnection({
      host: my!.host,
      port: my!.port,
      user: 'root',
      password: my!.rootPassword,
    })
    const err = await failure(runMy(myResource('my-kill'), 'SELECT SLEEP(30)', 500))
    expect(err.code).toBe('timeout')
    await vi.waitFor(async () => {
      const [rows] = await root.query(
        "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO = 'SELECT SLEEP(30)'",
      )
      expect(Number((rows as { n: number }[])[0]!.n)).toBe(0)
    })
    await root.end()
  })
})
