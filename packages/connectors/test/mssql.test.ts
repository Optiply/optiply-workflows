import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  mssqlConnector,
  mssqlEndsTransaction,
  PoolManager,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import { connectionSettings } from '../src/mssql/connector'
import {
  mssqlAvailable,
  startTestMssql,
  startTestSshServer,
  type TestMssql,
  type TestSshServer,
} from '../src/testing'
import { codeEvaluator, resource, scopeEvaluator } from './helpers'

// A real SQL Server 2022: a throwaway Docker container (or MSSQL_TEST_URL). Skipped locally without Docker; CI runs it.
const available = mssqlAvailable()

let server: TestMssql
let pool: PoolManager
let base: Record<string, unknown>

beforeAll(async () => {
  if (!available) return
  server = await startTestMssql()
  base = {
    host: server.host,
    port: server.port,
    database: server.database,
    user: server.user,
    ssl: 'require',
  }
  await server.admin(`
    CREATE TABLE customers (id INT PRIMARY KEY, email NVARCHAR(255) NOT NULL, profile NVARCHAR(MAX) NULL);
    WITH n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 30)
      INSERT INTO customers (id, email) SELECT i, CONCAT('user', i, '@example.com') FROM n;
    CREATE TABLE things (
      id INT IDENTITY PRIMARY KEY, big BIGINT, price DECIMAL(10, 2), flag BIT, day DATE, at DATETIME2(3),
      old DATETIME, zoned DATETIMEOFFSET, t TIME(0), guid UNIQUEIDENTIFIER, note NVARCHAR(MAX), raw VARBINARY(16)
    );
  `)
  pool = new PoolManager({ sweepIntervalMs: 0 })
}, 300_000)
afterAll(async () => {
  await pool?.closeAll()
  await server?.stop()
})

const msResource = (config: Record<string, unknown> = {}, version = '1'): ResolvedResource =>
  resource({ ...base, ...config }, { password: server.password }, version)

const run = (res: ResolvedResource, sql: string, scope: Record<string, unknown> = {}, timeoutMs?: number) =>
  runQuery(pool, mssqlConnector, res, { sql }, { evaluate: scopeEvaluator(scope), timeoutMs })

async function countRows(table = 'customers', where = '1=1'): Promise<number> {
  const rows = await server.admin(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
  return Number(rows[0]!.n)
}

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

/** Requests of other sessions whose SQL contains `marker`, as the server sees them. */
async function running(marker: string): Promise<unknown[]> {
  return server.admin(
    `SELECT r.session_id FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
     WHERE t.text LIKE '%${marker}%' AND t.text NOT LIKE '%dm_exec_requests%' AND r.session_id <> @@SPID`,
  )
}

describe('mssql settings (no server)', () => {
  const settings = (config: Record<string, unknown>, secrets: Record<string, unknown> = {}) =>
    connectionSettings(
      mssqlConnector.configSchema.parse({ host: 'db.example.com', database: 'shop', ...config }),
      mssqlConnector.secretsSchema.parse(secrets),
    )

  it('signs in with a SQL login, NTLM, an Entra user or an Entra service principal', () => {
    expect(settings({ user: 'app' }, { password: 'pw' }).authentication).toEqual({
      type: 'default',
      options: { userName: 'app', password: 'pw' },
    })
    expect(
      settings({ auth: 'ntlm', user: 'svc', domain: 'CORP' }, { password: 'pw' }).authentication,
    ).toEqual({
      type: 'ntlm',
      options: { domain: 'CORP', userName: 'svc', password: 'pw' },
    })
    expect(
      settings({ auth: 'entra-password', user: 'me@corp.com', clientId: 'app-id' }, { password: 'pw' })
        .authentication,
    ).toEqual({
      type: 'azure-active-directory-password',
      options: { userName: 'me@corp.com', password: 'pw', clientId: 'app-id', tenantId: '' },
    })
    expect(
      settings(
        { auth: 'entra-service-principal', clientId: 'app-id', tenantId: 'tenant' },
        { clientSecret: 'secret' },
      ).authentication,
    ).toEqual({
      type: 'azure-active-directory-service-principal-secret',
      options: { clientId: 'app-id', tenantId: 'tenant', clientSecret: 'secret' },
    })
    expect(() => settings({ auth: 'entra-service-principal', clientId: 'a', tenantId: 't' })).toThrow(
      /client secret is required/,
    )
  })

  it('maps TLS modes, named instances and read-only intent', () => {
    expect(settings({ user: 'a' }).options).toMatchObject({
      port: 1433,
      encrypt: true,
      trustServerCertificate: true,
    })
    expect(settings({ user: 'a', ssl: 'verify-full', caCert: 'PEM' }).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false,
      cryptoCredentialsDetails: { ca: 'PEM' },
    })
    expect(settings({ user: 'a', ssl: 'disable' }).options).toMatchObject({ encrypt: false })
    const named = settings({ user: 'a', instanceName: 'SQLEXPRESS', readOnly: true }).options!
    expect(named).toMatchObject({ instanceName: 'SQLEXPRESS', readOnlyIntent: true })
    expect(named).not.toHaveProperty('port')
  })

  it('checks each sign-in has its fields, with field paths', () => {
    const issues = (config: Record<string, unknown>) =>
      mssqlConnector.configSchema
        .safeParse({ host: 'h', database: 'd', ...config })
        .error?.issues.map((i) => i.path.join('.'))
    expect(issues({ user: 'a' })).toBeUndefined()
    expect(issues({})).toEqual(['user'])
    expect(issues({ auth: 'ntlm', user: 'a' })).toEqual(['domain'])
    expect(issues({ auth: 'entra-password', user: 'a' })).toEqual(['clientId'])
    expect(issues({ auth: 'entra-service-principal' })).toEqual(['clientId', 'tenantId'])
    expect(
      issues({
        user: 'a',
        instanceName: 'X',
        ssh: { hops: [{ id: 'h1', host: 'bastion', port: 22, username: 'u', auth: 'password' }] },
      }),
    ).toContain('instanceName')
  })

  it('finds COMMIT and ROLLBACK outside strings, names and comments', () => {
    expect(mssqlEndsTransaction('UPDATE t SET a = 1; COMMIT')).toBe('COMMIT')
    expect(mssqlEndsTransaction('rollback tran')).toBe('ROLLBACK')
    expect(
      mssqlEndsTransaction('SELECT \'commit\', [rollback], "commit" -- commit\n /* /* rollback */ */'),
    ).toBe(undefined)
    expect(mssqlEndsTransaction('SELECT committed, rollbacks FROM t')).toBe(undefined)
  })
})

describe.skipIf(!available)('SQL Server connector', () => {
  describe('queries', () => {
    let res: ResolvedResource
    beforeAll(() => {
      res = msResource()
    })

    it('binds {{ }} values as parameters', async () => {
      const result = await run(
        res,
        'SELECT id, email FROM customers WHERE id = {{ id }} OR email = {{ email }}',
        {
          id: 3,
          email: 'user5@example.com',
        },
      )
      expect(result.data).toEqual([
        { id: 3, email: 'user3@example.com' },
        { id: 5, email: 'user5@example.com' },
      ])
      expect(result.metadata).toMatchObject({
        rowCount: 2,
        fields: [
          { name: 'id', type: 'Int' },
          { name: 'email', type: 'NVarChar' },
        ],
      })
    })

    it('expands arrays into lists, an empty one matching nothing', async () => {
      const ids = await run(
        res,
        'SELECT id FROM customers WHERE id IN ({{ ids }}) AND id > {{ min }} ORDER BY id',
        {
          ids: [1, 2, 3, 4],
          min: 2,
        },
      )
      expect(ids.data).toEqual([{ id: 3 }, { id: 4 }])
      expect((await run(res, 'SELECT id FROM customers WHERE id IN ({{ ids }})', { ids: [] })).data).toEqual(
        [],
      )
    })

    it('binds objects as JSON, booleans as bits and undefined as NULL', async () => {
      const result = await run(
        res,
        'SELECT {{ doc }} AS doc, {{ yes }} AS yes, {{ none }} AS none, {{ big }} AS big',
        {
          doc: { a: [1, 'x'] },
          yes: true,
          none: undefined,
          big: 2 ** 40,
        },
      )
      expect(result.data).toEqual([{ doc: '{"a":[1,"x"]}', yes: true, none: null, big: 2 ** 40 }])
    })

    it('reports affected rows for writes', async () => {
      const insert = await run(res, "INSERT INTO things (note) VALUES ('a'), ('b')")
      expect(insert).toEqual({ data: [], metadata: { rowCount: 2, affectedRows: 2, fields: [] } })
      const update = await run(res, "UPDATE things SET note = 'c' WHERE note IN ('a', 'b')")
      expect(update.metadata).toMatchObject({ affectedRows: 2 })
      // A write followed by a SELECT: the rows are the result.
      const both = await run(res, "DELETE FROM things WHERE note = 'c'; SELECT COUNT(*) AS n FROM things")
      expect(both.data).toEqual([{ n: 0 }])
    })

    it('returns SQL Server types as JSON-friendly values', async () => {
      await run(
        res,
        `INSERT INTO things (big, price, flag, day, at, old, zoned, t, guid, note, raw) VALUES (
          9007199254740993, 12.34, 1, '2026-10-14', '2026-10-14 09:30:00.125', '2026-10-14 09:30:00',
          '2026-10-14 09:30:00 +02:00', '09:30:00', 'C56A4180-65AA-42EC-A945-5FD21DEC0538', N'olá', 0x0102)`,
      )
      const result = await run(
        res,
        'SELECT big, price, flag, day, at, old, zoned, t, guid, note, raw, 5 AS small FROM things',
      )
      expect(result.data).toEqual([
        {
          big: '9007199254740993',
          price: 12.34,
          flag: true,
          day: '2026-10-14',
          at: '2026-10-14 09:30:00.125',
          old: '2026-10-14 09:30:00',
          zoned: '2026-10-14T07:30:00.000Z',
          t: '09:30:00',
          guid: 'C56A4180-65AA-42EC-A945-5FD21DEC0538',
          note: 'olá',
          raw: Buffer.from([1, 2]),
          small: 5,
        },
      ])
      expect((await run(res, 'SELECT CAST(42 AS BIGINT) AS b')).data).toEqual([{ b: 42 }])
      await run(res, 'DELETE FROM things')
    })

    it('names unnamed columns and returns the first of several result sets', async () => {
      const result = await run(res, 'SELECT COUNT(*), MAX(id) AS top_id FROM customers; SELECT 1 AS other')
      expect(result.data).toEqual([{ column1: 30, top_id: 30 }])
    })

    it('reports SQL errors with their SQL Server number', async () => {
      const err = await failure(run(res, 'SELECT * FROM nope'))
      expect(err.code).toBe('query')
      expect(err.message).toMatch(/Invalid object name 'nope'/)
      expect(err.details).toMatchObject({ number: 208 })
    })

    it('reports {{ }} errors as expression errors', async () => {
      expect((await failure(run(res, 'SELECT {{ missing.x }}'))).code).toBe('expression')
    })

    it('rejects {{ }} inside string literals and @p1-like names before running anything', async () => {
      expect((await failure(run(res, "SELECT '{{ x }}'", { x: 1 }))).code).toBe('invalid_query')
      expect((await failure(run(res, 'DECLARE @p1 INT = 1; SELECT @p1'))).code).toBe('invalid_query')
    })

    it('keeps T-SQL variables and temp tables working', async () => {
      const result = await run(
        res,
        'DECLARE @n INT = {{ n }}; CREATE TABLE #t (v INT); INSERT #t VALUES (@n), (@n + 1); SELECT SUM(v) AS s FROM #t',
        { n: 10 },
      )
      expect(result.data).toEqual([{ s: 21 }])
    })
  })

  describe('injection', () => {
    it.each(["'; DROP TABLE customers; --", "x' OR '1'='1", ']; DROP TABLE customers; --', "N''"])(
      'a hostile value is only ever a value: %s',
      async (payload) => {
        const result = await runQuery(
          pool,
          mssqlConnector,
          msResource(),
          { sql: 'SELECT COUNT(*) AS n FROM customers WHERE email = {{ email }}' },
          { evaluate: codeEvaluator({ email: payload }), untrustedValues: true },
        )
        expect(result.data).toEqual([{ n: 0 }])
        expect(await countRows()).toBe(30)
      },
    )
  })

  describe('sql.column and sql.where', () => {
    it('sort by a listed column and filter with values bound', async () => {
      // The `sql` helpers run in the sandbox; here each {{ }} answers with what they'd return.
      const runWith = (sql: string, values: Record<string, unknown>) =>
        runQuery(pool, mssqlConnector, msResource(), { sql }, { evaluate: codeEvaluator(values) })
      const sorted = await runWith(
        "SELECT TOP 2 id FROM customers WHERE id IN ({{ ids }}) AND {{ sql.where(f, ['email', 'id']) }} ORDER BY {{ sql.column(s, ['id', 'email']) }} {{ sql.direction(d) }}",
        {
          ids: [2, 20, 28, 29, 30],
          "sql.where(f, ['email', 'id'])": [{ column: 'email', op: 'contains', value: 'USER2' }],
          "sql.column(s, ['id', 'email'])": 'id',
          'sql.direction(d)': 'desc',
        },
      )
      expect(sorted.data).toEqual([{ id: 29 }, { id: 28 }])
      const all = await runWith("SELECT COUNT(*) AS n FROM customers WHERE {{ sql.where(f, ['id']) }}", {
        "sql.where(f, ['id'])": [],
      })
      expect(all.data).toEqual([{ n: 30 }])
      for (const hostile of ['id; DROP TABLE customers', '[id]', 'email']) {
        const refused = await failure(
          runWith("SELECT id FROM customers ORDER BY {{ sql.column(s, ['id']) }}", {
            "sql.column(s, ['id'])": hostile,
          }),
        )
        expect(refused.code).toBe('expression')
      }
      expect(await countRows()).toBe(30)
    })
  })

  describe('guards', () => {
    it('read-only resources roll every change back and fail queries that changed rows', async () => {
      const ro = msResource({ readOnly: true })
      expect((await run(ro, 'SELECT COUNT(*) AS n FROM customers')).data).toEqual([{ n: 30 }])
      const update = await failure(run(ro, "UPDATE customers SET email = 'x' WHERE id = 1"))
      expect(update.message).toMatch(/read-only: the query changed 1 row, and the change was rolled back/)
      // Schema changes are rolled back too (they report no rows, so they don't fail).
      await run(ro, 'CREATE TABLE sneaky (id INT)')
      expect(await server.admin("SELECT name FROM sys.tables WHERE name = 'sneaky'")).toEqual([])
      expect((await failure(run(ro, 'DELETE FROM customers; COMMIT'))).code).toBe('invalid_query')
      // Dynamic SQL that commits is caught afterwards.
      const dynamic = await failure(run(ro, "EXEC('COMMIT'); SELECT 1 AS one"))
      expect(dynamic.message).toMatch(/ended its transaction itself/)
      // An error that rolls the transaction back itself is reported as it is.
      const aborted = await failure(run(ro, 'SET XACT_ABORT ON; SELECT 1 / 0 AS boom'))
      expect(aborted.message).toMatch(/Divide by zero/)
      expect(aborted.details).toMatchObject({ number: 8134 })
      expect(await countRows('customers', "email = 'x'")).toBe(0)
      expect(await countRows()).toBe(30)
    })

    it('rolls back a transaction a query leaves open (SQL Server also fails it: 266)', async () => {
      const open = await failure(
        run(msResource(), "BEGIN TRAN; UPDATE customers SET email = 'open' WHERE id = 1"),
      )
      expect(open.details).toMatchObject({ number: 266 })
      expect(await countRows('customers', "email = 'open'")).toBe(0)
      // Balanced transactions are fine.
      await run(msResource(), "BEGIN TRAN; UPDATE customers SET profile = 'p' WHERE id = 1; COMMIT")
      expect(await countRows('customers', "profile = 'p'")).toBe(1)
    })

    it('fails queries that return more than maxRows, but not writes that touch more', async () => {
      const small = msResource({ maxRows: 10, poolSize: 1 })
      expect((await run(small, 'SELECT TOP 10 id FROM customers')).metadata.rowCount).toBe(10)
      expect((await failure(run(small, 'SELECT id FROM customers'))).code).toBe('too_large')
      // The single-connection pool still works.
      expect((await run(small, 'UPDATE customers SET profile = NULL')).metadata.affectedRows).toBe(30)
    })

    it('enforces the statement timeout and the run timeout, cancelling the query on the server', async () => {
      const strict = msResource({ statementTimeoutMs: 500 })
      expect((await failure(run(strict, "WAITFOR DELAY '00:00:10'; SELECT 'stmt_timeout' AS x"))).code).toBe(
        'timeout',
      )
      expect(
        (await failure(run(msResource(), "WAITFOR DELAY '00:00:10'; SELECT 'run_timeout' AS x", {}, 500)))
          .code,
      ).toBe('timeout')
      await expect.poll(() => running('_timeout'), { timeout: 5000 }).toEqual([])
      // A query's own timeout overrides the resource's statement timeout.
      expect((await run(strict, "WAITFOR DELAY '00:00:01'; SELECT 1 AS slept", {}, 5000)).data).toEqual([
        { slept: 1 },
      ])
    })

    it('cancels on abort: the query stops on the server, and the connection is used again', async () => {
      const res = msResource({ poolSize: 1 })
      const before = (await run(res, 'SELECT @@SPID AS spid')).data as { spid: number }[]
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 500)
      const started = Date.now()
      const err = await failure(
        runQuery(
          pool,
          mssqlConnector,
          res,
          { sql: "WAITFOR DELAY '00:00:30'; SELECT 1 AS cancelled_marker" },
          { evaluate: scopeEvaluator({}), signal: controller.signal },
        ),
      )
      expect(err.code).toBe('aborted')
      expect(Date.now() - started).toBeLessThan(5000)
      await expect.poll(() => running('cancelled_marker'), { timeout: 5000 }).toEqual([])
      expect((await run(res, 'SELECT @@SPID AS spid')).data).toEqual(before)
    })
  })

  describe('testResource', () => {
    it('reports the server version, or a connection error without the password', async () => {
      const ok = await testResource(mssqlConnector, msResource())
      expect(ok).toMatchObject({ ok: true, message: expect.stringMatching(/^Microsoft SQL Server 2022/) })

      const bad = await testResource(
        mssqlConnector,
        resource({ ...base, port: 1 }, { password: server.password }),
        {
          timeoutMs: 5000,
        },
      )
      expect(bad).toMatchObject({ ok: false, error: { code: 'connection' } })
      expect(JSON.stringify(bad)).not.toContain(server.password)

      const wrong = await testResource(mssqlConnector, resource(base, { password: 'definitely-wrong-pw' }))
      expect(wrong).toMatchObject({
        ok: false,
        error: { code: 'connection', message: expect.stringMatching(/Login failed/) },
      })
    })

    it('encrypts with ssl "require", and "verify-full" rejects an untrusted certificate', async () => {
      // Seen by sa, for the resource's own (pooled, still open) connection.
      const encrypted = async (ssl: string) => {
        const [{ spid }] = (await run(msResource({ ssl }), 'SELECT @@SPID AS spid')).data as {
          spid: number
        }[] as [{ spid: number }]
        const rows = await server.admin(
          `SELECT encrypt_option AS e FROM sys.dm_exec_connections WHERE session_id = ${spid}`,
        )
        return rows[0]?.e
      }
      expect(await encrypted('require')).toBe('TRUE')
      expect(await encrypted('disable')).toBe('FALSE')
      // The container's certificate is self-signed.
      const verify = await testResource(mssqlConnector, msResource({ ssl: 'verify-full' }))
      expect(verify).toMatchObject({ ok: false, error: { code: 'connection' } })
    })

    it('rejects invalid configuration with field paths', async () => {
      const bad = await testResource(mssqlConnector, resource({ host: '' }, {}))
      expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
    })
  })
})

describe.skipIf(!available)('SQL Server through an SSH tunnel', () => {
  // `db.internal` only resolves on the test SSH server: a query that works went through the tunnel.
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
  let ssh: TestSshServer
  beforeAll(async () => {
    ssh = await startTestSshServer({
      users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
      hosts: { 'db.internal': server.host },
    })
  })
  afterAll(async () => {
    await ssh?.close()
  })

  const tunnelled = (version: string, config: Record<string, unknown> = {}) =>
    resource(
      {
        ...base,
        host: 'db.internal',
        ssl: 'disable',
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
        ...config,
      },
      { password: server.password, ssh: { bastion: { privateKey: fixture('openssh-ed25519') } } },
      version,
    )

  it('runs queries through it, over TLS too', async () => {
    expect((await run(tunnelled('ssh'), 'SELECT 1 + 1 AS two')).data).toEqual([{ two: 2 }])
    expect(ssh.forwards.at(-1)).toEqual({ host: 'db.internal', port: server.port, allowed: true })
    const [{ spid }] = (await run(tunnelled('ssh-tls', { ssl: 'require' }), 'SELECT @@SPID AS spid'))
      .data as [{ spid: number }]
    expect(
      await server.admin(
        `SELECT encrypt_option AS e FROM sys.dm_exec_connections WHERE session_id = ${spid}`,
      ),
    ).toEqual([{ e: 'TRUE' }])
    expect(await testResource(mssqlConnector, tunnelled('ssh-test'))).toMatchObject({ ok: true })
  })

  it('cancels a query that runs too long, through the tunnel', async () => {
    const res = tunnelled('ssh-cancel', { poolSize: 1 })
    expect((await failure(run(res, "WAITFOR DELAY '00:00:30'; SELECT 1 AS ssh_marker", {}, 500))).code).toBe(
      'timeout',
    )
    await expect.poll(() => running('ssh[_]marker'), { timeout: 5000 }).toEqual([])
    expect((await run(res, 'SELECT 3 AS three')).data).toEqual([{ three: 3 }])
  })
})
