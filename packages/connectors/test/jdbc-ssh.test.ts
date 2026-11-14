import { readFileSync } from 'node:fs'
import {
  clickhouse,
  jdbcRunnerAvailable,
  startTestClickHouse,
  startTestJdbcRunner,
  type TestClickHouse,
  type TestJdbcRunner,
  testNetwork,
} from '@ow/jdbc-runner/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureJdbcForwarder,
  configureJdbcRunner,
  JdbcForwarder,
  JdbcRunnerClient,
  jdbcConnector,
  PoolManager,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import { startTestSshServer, type TestSshServer } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// M38 step 4: a JDBC resource through an SSH tunnel, every piece real: the runner's image, ClickHouse, the test SSH
// server and this process's forwarder. ClickHouse is `ch.internal`, which only the SSH server resolves: a query that
// works went runner → forwarder → SSH → ClickHouse.

const available = jdbcRunnerAvailable()
const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')

let network: ReturnType<typeof testNetwork>
let runner: TestJdbcRunner
let ch: TestClickHouse
let ssh: TestSshServer
let chPort: number
let pool: PoolManager

beforeAll(async () => {
  if (!available) return
  network = testNetwork()
  ;[runner, ch, ssh] = await Promise.all([
    startTestJdbcRunner(),
    startTestClickHouse(network.name),
    startTestSshServer({
      users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
      hosts: { 'ch.internal': '127.0.0.1' },
    }),
  ])
  chPort = Number(new URL(ch.localUrl).port)
  await clickhouse(ch, 'CREATE TABLE events (id UInt32, kind String) ENGINE = MergeTree ORDER BY id')
  await clickhouse(ch, "INSERT INTO events VALUES (1, 'signup'), (2, 'order'), (3, 'order')")
  configureJdbcRunner(new JdbcRunnerClient({ url: runner.url, token: runner.token }))
  // The runner's container reaches this machine as host.docker.internal.
  configureJdbcForwarder(new JdbcForwarder({ port: 0, bind: '0.0.0.0', advertise: 'host.docker.internal' }))
  pool = new PoolManager({ sweepIntervalMs: 0 })
}, 900_000)
afterAll(async () => {
  await pool?.closeAll()
  configureJdbcRunner(null)
  configureJdbcForwarder(null)
  await ssh?.close()
  await runner?.stop()
  await ch?.stop()
  network?.remove()
})

const tunnelled = (over: Record<string, unknown> = {}): ResolvedResource =>
  resource(
    {
      driver: 'clickhouse',
      host: 'ch.internal',
      port: chPort,
      https: false,
      database: ch.database,
      user: ch.user,
      ssh: {
        hops: [
          {
            id: 'bastion',
            host: ssh.host,
            port: ssh.port,
            username: 'ow',
            auth: 'key',
            hostKey: ssh.hostKey,
          },
        ],
      },
      tunnelHosts: [`ch.internal:${chPort}`],
      ...over,
    },
    { password: ch.password, ssh: { bastion: { privateKey: fixture('openssh-ed25519') } } },
  )

describe.skipIf(!available)('a JDBC resource through an SSH tunnel', () => {
  it('tests the connection and runs queries through it, by the database’s own name', async () => {
    const res = tunnelled()
    // The first connection warms everything (the SSH handshake, the runner's JVM loading the driver): on a machine busy
    // with the rest of the suite's containers it can take longer than Test connection's 15 s.
    const tested = await testResource(jdbcConnector, res, { timeoutMs: 60_000 })
    expect(tested, JSON.stringify(tested)).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^ClickHouse/),
    })
    const result = await runQuery(
      pool,
      jdbcConnector,
      res,
      { sql: 'SELECT kind, count() AS n FROM events WHERE id IN ({{ ids }}) GROUP BY kind ORDER BY kind' },
      { evaluate: scopeEvaluator({ ids: [1, 2, 3] }) },
    )
    expect(result.data).toEqual([
      { kind: 'order', n: 2 },
      { kind: 'signup', n: 1 },
    ])
    expect(ssh.forwards.at(-1)).toEqual({ host: 'ch.internal', port: chPort, allowed: true })
  })

  it('times out through it, and says when the SSH side can’t open the database', async () => {
    const slow = await runQuery(
      pool,
      jdbcConnector,
      tunnelled(),
      { sql: 'SELECT sleepEachRow(0.5), number FROM numbers(40) SETTINGS max_block_size = 1' },
      { evaluate: scopeEvaluator({}), timeoutMs: 1500 },
    ).catch((e: unknown) => e)
    expect(slow).toBeInstanceOf(ConnectorError)
    expect((slow as ConnectorError).code).toBe('timeout')

    // A name the SSH server can't resolve: the forwarder's reason reaches the user.
    const gone = await testResource(
      jdbcConnector,
      tunnelled({ host: 'nowhere.internal', tunnelHosts: [`nowhere.internal:${chPort}`] }),
    )
    expect(gone).toMatchObject({
      ok: false,
      error: { code: 'connection', message: expect.stringMatching(/SSH tunnel/) },
    })
  })
})
