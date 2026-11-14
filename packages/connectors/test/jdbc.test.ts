import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureJdbcDrivers,
  configureJdbcRunner,
  JdbcRunnerClient,
  jdbcConnection,
  jdbcConnector,
  jdbcUrl,
  PoolManager,
  parseResource,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import { JDBC_PROCESS } from '../src/jdbc/connector'
import { codeEvaluator, resource, scopeEvaluator } from './helpers'

// M38 step 3a: the JDBC connector against a fake runner (the runner itself is tested with real databases in
// apps/jdbc-runner).

const TOKEN = 'fake-runner-token-0123456789'

interface Seen {
  method: string
  path: string
  body: unknown
}

let server: Server
let url: string
const seen: Seen[] = []
const jars = new Set<string>()
const cancelled = new Set<string>()
let pool: PoolManager

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks)
    const path = req.url ?? ''
    const body: unknown =
      raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : raw.length
    seen.push({ method: req.method!, path, body })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('{"error":"unauthorized"}')
      return
    }
    if (req.method === 'PUT' && path.startsWith('/drivers/')) {
      jars.add(path.slice('/drivers/'.length))
      res.writeHead(200).end('{}')
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end('{"closed":1}')
      return
    }
    if (path === '/cancel') {
      cancelled.add((body as { queryId: string }).queryId)
      res.writeHead(200).end('{"cancelled":true}')
      return
    }
    const q = body as { queryId: string; sql: string; connection: { driver: string; driverSha?: string } }
    if (q.connection.driver === 'uploaded' && !jars.has(q.connection.driverSha ?? '')) {
      res.writeHead(409).end(JSON.stringify({ error: 'unknown_driver', sha: q.connection.driverSha }))
      return
    }
    if (path === '/test') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'Oracle Database 23ai' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const line = (l: unknown) => res.write(`${JSON.stringify(l)}\n`)
    if (q.sql.includes('FAIL')) {
      line({
        type: 'error',
        kind: 'query',
        message: 'ORA-00942: table or view does not exist',
        sqlState: '42000',
        vendorCode: 942,
      })
    } else if (q.sql.includes('WRITE')) {
      line({ type: 'end', affectedRows: 3 })
    } else if (q.sql.includes('SLOW')) {
      for (let i = 0; i < 100 && !cancelled.has(q.queryId); i++) await new Promise((r) => setTimeout(r, 50))
      line({ type: 'error', kind: 'aborted', message: 'The query was cancelled' })
    } else {
      line({ type: 'fields', fields: [{ name: 'ID', type: 'NUMBER' }] })
      line({ type: 'rows', rows: [{ ID: 1 }, { ID: 2 }] })
      line({ type: 'rows', rows: [{ ID: 3 }] })
      line({ type: 'end', affectedRows: 0 })
    }
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  configureJdbcRunner(new JdbcRunnerClient({ url, token: TOKEN }))
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool.closeAll()
  configureJdbcRunner(null)
  configureJdbcDrivers(null)
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  seen.length = 0
})

const oracle = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = { password: 'ora-pw' },
) =>
  resource(
    { driver: 'oracle', host: 'db.internal', serviceName: 'ORCLPDB1', user: 'app', ...config },
    secrets,
  )

const queries = () => seen.filter((s) => s.path === '/query').map((s) => s.body as Record<string, unknown>)

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected a failure')
}

describe('JDBC settings', () => {
  const parse = (c: Record<string, unknown>) => jdbcConnector.configSchema.parse(c)

  it('makes each driver’s URL from its fields, or takes one as written', () => {
    expect(jdbcUrl(parse({ driver: 'oracle', host: 'db', serviceName: 'PDB1', user: 'u' }))).toBe(
      'jdbc:oracle:thin:@//db:1521/PDB1',
    )
    expect(
      jdbcUrl(
        parse({ driver: 'oracle', host: 'db', port: 1522, oracleConnect: 'sid', sid: 'ORCL', user: 'u' }),
      ),
    ).toBe('jdbc:oracle:thin:@db:1522:ORCL')
    expect(
      jdbcUrl(
        parse({ driver: 'oracle', oracleConnect: 'tns', tnsAlias: 'mydb_high', wallet: true, user: 'u' }),
      ),
    ).toBe('jdbc:oracle:thin:@mydb_high')
    expect(
      jdbcUrl(
        parse({
          driver: 'snowflake',
          account: 'acme-prod',
          warehouse: 'WH',
          database: 'SHOP',
          schema: 'PUBLIC',
          role: 'READER',
          user: 'u',
        }),
      ),
    ).toBe(
      'jdbc:snowflake://acme-prod.snowflakecomputing.com/?warehouse=WH&db=SHOP&schema=PUBLIC&role=READER',
    )
    expect(
      jdbcUrl(parse({ driver: 'snowflake', account: 'xy123.eu-west-1.snowflakecomputing.com', user: 'u' })),
    ).toBe('jdbc:snowflake://xy123.eu-west-1.snowflakecomputing.com/')
    expect(jdbcUrl(parse({ driver: 'clickhouse', host: 'ch.example', database: 'events', user: 'u' }))).toBe(
      'jdbc:clickhouse:https://ch.example:8443/events',
    )
    expect(jdbcUrl(parse({ driver: 'clickhouse', host: 'ch', https: false, user: 'u' }))).toBe(
      'jdbc:clickhouse:http://ch:8123/default',
    )
    expect(
      jdbcUrl(parse({ driver: 'oracle', mode: 'url', url: ' jdbc:oracle:thin:@//x:1/y ', user: 'u' })),
    ).toBe('jdbc:oracle:thin:@//x:1/y')
  })

  it('checks each driver’s fields and sign-ins, with field paths', () => {
    const issues = (c: Record<string, unknown>) =>
      jdbcConnector.configSchema.safeParse(c).error?.issues.map((i) => i.path.join('.'))
    expect(issues({ driver: 'oracle', host: 'db', user: 'u' })).toEqual(['serviceName'])
    expect(issues({ driver: 'oracle', mode: 'url', url: 'jdbc:snowflake://x', user: 'u' })).toEqual(['url'])
    expect(issues({ driver: 'oracle', host: 'h', serviceName: 's', user: 'u', auth: 'keyPair' })).toEqual([
      'auth',
    ])
    expect(issues({ driver: 'oracle', oracleConnect: 'tns', tnsAlias: 'a', user: 'u' })).toEqual(['tnsAlias'])
    expect(issues({ driver: 'snowflake', user: 'u' })).toEqual(['account'])
    expect(issues({ driver: 'snowflake', account: 'a', auth: 'oauth' })).toEqual(['oauthClientId'])
    expect(issues({ driver: 'uploaded', url: 'jdbc:db2://h/x', user: 'u' })).toEqual(['driverId'])
    expect(issues({ driver: 'clickhouse', host: 'h' })).toEqual(['user'])
    expect(issues({ driver: 'clickhouse', host: 'h', user: 'u', wallet: true })).toEqual(['wallet'])
  })

  it('signs in with a password, a Snowflake key pair or an Oracle wallet; properties merged', () => {
    const c = (config: Record<string, unknown>) => jdbcConnector.configSchema.parse(config)
    expect(
      jdbcConnection(
        c({ driver: 'clickhouse', host: 'h', user: 'u', properties: { socket_timeout: '30000' } }),
        { password: 'pw', properties: { api_key: 'k' } },
        'rc:1',
      ),
    ).toMatchObject({
      poolKey: 'rc:1',
      driver: 'clickhouse',
      properties: { socket_timeout: '30000', api_key: 'k', user: 'u', password: 'pw' },
      readOnly: false,
      poolSize: 5,
    })
    const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n-----END ENCRYPTED PRIVATE KEY-----'
    const kp = jdbcConnection(
      c({ driver: 'snowflake', account: 'a', user: 'svc', auth: 'keyPair' }),
      { privateKey: pem, privateKeyPassphrase: 'phrase' },
      'rc:2',
    )
    expect(kp.properties).toEqual({
      user: 'svc',
      private_key_base64: Buffer.from(pem).toString('base64'),
      private_key_pwd: 'phrase',
      authenticator: 'snowflake_jwt',
    })
    expect(() =>
      jdbcConnection(c({ driver: 'snowflake', account: 'a', user: 'svc', auth: 'keyPair' }), {}, 'rc:3'),
    ).toThrow(/private key is missing/)
    const wallet = jdbcConnection(
      c({ driver: 'oracle', oracleConnect: 'tns', tnsAlias: 'db_high', wallet: true, user: 'admin' }),
      { password: 'pw', wallet: 'UEsDBA==', walletPassword: 'wpw' },
      'rc:4',
    )
    expect(wallet.wallet).toEqual({ zip: 'UEsDBA==', password: 'wpw' })
    const oauth = jdbcConnection(
      c({ driver: 'snowflake', account: 'a', auth: 'oauth', oauthClientId: 'cid' }),
      {},
      'rc:5',
    )
    expect(oauth).toMatchObject({ tokenProperty: 'token', properties: { authenticator: 'oauth' } })
  })
})

describe('the JDBC connector', () => {
  it('sends the query in the driver’s dialect, arrays expanded, values as they are; reads the lines', async () => {
    const res = oracle()
    const result = await runQuery(
      pool,
      jdbcConnector,
      res,
      {
        sql: 'SELECT id FROM orders WHERE id IN ({{ ids }}) AND paid = {{ paid }} AND note = {{ doc }} AND at > {{ since }}',
      },
      {
        evaluate: scopeEvaluator({
          ids: [1, 2],
          paid: true,
          doc: { a: 1 },
          since: new Date('2026-10-14T09:30:00Z'),
        }),
      },
    )
    expect(result).toEqual({
      data: [{ ID: 1 }, { ID: 2 }, { ID: 3 }],
      metadata: { rowCount: 3, fields: [{ name: 'ID', type: 'NUMBER' }] },
    })
    const [q] = queries()
    expect(q).toMatchObject({
      sql: 'SELECT id FROM orders WHERE id IN (?, ?) AND paid = ? AND note = ? AND at > ?',
      params: [1, 2, true, '{"a":1}', { $timestamp: '2026-10-14T09:30:00.000Z' }],
      maxRows: 1_000_000,
      timeoutMs: 120_000,
      connection: {
        driver: 'oracle',
        url: 'jdbc:oracle:thin:@//db.internal:1521/ORCLPDB1',
        properties: { user: 'app', password: 'ora-pw' },
        readOnly: false,
      },
    })
    expect(typeof q!.queryId).toBe('string')
  })

  it('runs what only its driver’s dialect reads (Snowflake’s $$ and //, ClickHouse’s backslashes)', async () => {
    const sf = resource({ driver: 'snowflake', account: 'acme', user: 'u' }, { password: 'p' })
    await runQuery(
      pool,
      jdbcConnector,
      sf,
      { sql: "SELECT $$it's$$, {{ x }} // don't" },
      { evaluate: scopeEvaluator({ x: 1 }) },
    )
    const ch = resource({ driver: 'clickhouse', host: 'ch', user: 'u' }, { password: 'p' })
    await runQuery(
      pool,
      jdbcConnector,
      ch,
      { sql: String.raw`SELECT 'a\'b', {{ x }}` },
      { evaluate: scopeEvaluator({ x: 2 }) },
    )
    expect(queries().map((q) => [q.sql, q.params])).toEqual([
      ["SELECT $$it's$$, ? // don't", [1]],
      [String.raw`SELECT 'a\'b', ?`, [2]],
    ])
  })

  it('writes sql.where in the driver’s own SQL', async () => {
    await runQuery(
      pool,
      jdbcConnector,
      oracle(),
      { sql: "SELECT * FROM t WHERE {{ sql.where(f, ['name']) }}" },
      {
        evaluate: codeEvaluator({
          "sql.where(f, ['name'])": [{ column: 'name', op: 'contains', value: 'x' }],
        }),
      },
    )
    expect(queries()[0]).toMatchObject({
      sql: 'SELECT * FROM t WHERE (INSTR(LOWER(CAST("NAME" AS VARCHAR2(4000))), LOWER(?)) > 0)',
      params: ['x'],
    })
  })

  it('reports writes, and errors with their SQL state and code', async () => {
    expect(
      await runQuery(pool, jdbcConnector, oracle(), { sql: 'WRITE' }, { evaluate: scopeEvaluator({}) }),
    ).toEqual({
      data: [],
      metadata: { rowCount: 3, affectedRows: 3, fields: [] },
    })
    const err = await failure(
      runQuery(pool, jdbcConnector, oracle(), { sql: 'FAIL' }, { evaluate: scopeEvaluator({}) }),
    )
    expect(err).toMatchObject({ code: 'query', message: expect.stringMatching(/ORA-00942/) })
    expect(err.details).toMatchObject({ sqlState: '42000', vendorCode: 942 })
  })

  it('cancels on the runner when the run is cancelled', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const err = await failure(
      runQuery(
        pool,
        jdbcConnector,
        oracle(),
        { sql: 'SLOW' },
        { evaluate: scopeEvaluator({}), signal: controller.signal },
      ),
    )
    expect(err.code).toBe('aborted')
    const [q] = queries()
    await expect.poll(() => cancelled.has(q!.queryId as string)).toBe(true)
  })

  it('uploads an uploaded driver’s jar when the runner asks, then runs', async () => {
    const jar = new Uint8Array([0x50, 0x4b, 3, 4])
    let reads = 0
    configureJdbcDrivers(async (id) =>
      id === 'drv-1'
        ? {
            sha256: 'a'.repeat(64),
            className: 'com.ibm.db2.jcc.DB2Driver',
            jar: async () => {
              reads++
              return jar
            },
          }
        : null,
    )
    const db2 = resource(
      { driver: 'uploaded', driverId: 'drv-1', url: 'jdbc:db2://db2:50000/SHOP', user: 'u' },
      { password: 'p' },
    )
    const result = await runQuery(
      pool,
      jdbcConnector,
      db2,
      { sql: 'SELECT 1 FROM sysibm.sysdummy1' },
      { evaluate: scopeEvaluator({}) },
    )
    expect(result.metadata.rowCount).toBe(3)
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /query',
      `PUT /drivers/${'a'.repeat(64)}`,
      'POST /query',
    ])
    expect(seen[1]!.body).toBe(4)
    expect(queries()[1]).toMatchObject({
      connection: { driverSha: 'a'.repeat(64), driverClass: 'com.ibm.db2.jcc.DB2Driver' },
    })
    expect(reads).toBe(1)

    const gone = resource({ driver: 'uploaded', driverId: 'drv-gone', url: 'jdbc:db2://x', user: 'u' })
    expect(
      (
        await failure(
          runQuery(pool, jdbcConnector, gone, { sql: 'SELECT 1' }, { evaluate: scopeEvaluator({}) }),
        )
      ).code,
    ).toBe('invalid_config')
  })

  it('signs in to Snowflake with the runner’s token for whoever runs it, or asks to connect', async () => {
    const sf = resource({ driver: 'snowflake', account: 'acme', auth: 'oauth', oauthClientId: 'cid' })
    await runQuery(
      pool,
      jdbcConnector,
      sf,
      { sql: 'SELECT 1' },
      { evaluate: scopeEvaluator({}), credentials: { accessToken: async () => 'sf-access-token' } },
    )
    expect(queries()[0]).toMatchObject({
      connection: {
        tokenProperty: 'token',
        token: 'sf-access-token',
        properties: { authenticator: 'oauth' },
      },
    })
    // Each token has its own pool: one person's Snowflake session never runs another's query.
    await runQuery(
      pool,
      jdbcConnector,
      sf,
      { sql: 'SELECT 1' },
      { evaluate: scopeEvaluator({}), credentials: { accessToken: async () => 'someone-elses-token' } },
    )
    const [first, second] = queries().map((q) => (q.connection as { poolKey: string }).poolKey)
    expect(first).toMatch(new RegExp(`^${sf.id}:${sf.version}:[0-9a-f]{8}:[0-9a-f]{16}$`))
    expect(second).not.toBe(first)
    expect(
      (
        await failure(
          runQuery(pool, jdbcConnector, sf, { sql: 'SELECT 1' }, { evaluate: scopeEvaluator({}) }),
        )
      ).code,
    ).toBe('auth_required')
  })

  it('gives the OAuth sign-in Snowflake’s own URLs, the role as its scope', () => {
    const http = jdbcConnector.httpConfig!(
      jdbcConnector.configSchema.parse({
        driver: 'snowflake',
        account: 'acme-prod',
        role: 'ANALYST',
        auth: 'oauth',
        oauthClientId: 'client-1',
      }),
    )
    expect(http.auth).toMatchObject({
      type: 'oauth2AuthorizationCode',
      authorizeUrl: 'https://acme-prod.snowflakecomputing.com/oauth/authorize',
      tokenUrl: 'https://acme-prod.snowflakecomputing.com/oauth/token-request',
      revokeUrl: 'https://acme-prod.snowflakecomputing.com/oauth/revoke',
      clientId: 'client-1',
      scope: 'refresh_token session:role:ANALYST',
      clientAuth: 'basic',
      tokens: 'perUser',
    })
    expect(
      jdbcConnector.httpConfig!(
        jdbcConnector.configSchema.parse({ driver: 'snowflake', account: 'a', user: 'u' }),
      ).auth,
    ).toEqual({ type: 'none' })
  })

  it('tests the connection through the runner, and closes its pools when the client goes', async () => {
    const res: ResolvedResource = oracle({}, { password: 'pw' })
    expect(await testResource(jdbcConnector, res)).toMatchObject({
      ok: true,
      message: 'Oracle Database 23ai',
    })
    const client = await jdbcConnector.createClient(parseResource(jdbcConnector, res) as never)
    await jdbcConnector.destroyClient(client)
    expect(seen.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/pools?key=${encodeURIComponent(`${res.id}:${res.version}:${JDBC_PROCESS}`)}`,
    })
  })

  it('says when there’s no runner, or it refuses the token', async () => {
    configureJdbcRunner(null)
    try {
      const none = await failure(
        runQuery(pool, jdbcConnector, oracle(), { sql: 'SELECT 1' }, { evaluate: scopeEvaluator({}) }),
      )
      expect(none.message).toMatch(/no JDBC runner/)
    } finally {
      configureJdbcRunner(new JdbcRunnerClient({ url, token: 'wrong-token-0123456789' }))
    }
    try {
      const refused = await failure(
        runQuery(pool, jdbcConnector, oracle(), { sql: 'SELECT 1' }, { evaluate: scopeEvaluator({}) }),
      )
      expect(refused.message).toMatch(/JDBC_RUNNER_TOKEN/)
    } finally {
      configureJdbcRunner(new JdbcRunnerClient({ url, token: TOKEN }))
    }
  })
})
