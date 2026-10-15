import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  mysqlConnector,
  PoolManager,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import { mysqlAvailable, startTestMysql, type TestMysql } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// A real MySQL 8.4: a throwaway Docker container (or MYSQL_TEST_URL). Skipped locally without Docker; CI runs it.
const available = mysqlAvailable()

let server: TestMysql
let root: mysql.Connection
let pool: PoolManager
let base: Record<string, unknown>

beforeAll(async () => {
  if (!available) return
  server = await startTestMysql()
  base = {
    host: server.host,
    port: server.port,
    database: server.database,
    user: server.user,
    ssl: 'disable',
  }
  root = await mysql.createConnection({
    host: server.host,
    port: server.port,
    user: 'root',
    password: server.rootPassword,
    database: server.database,
    multipleStatements: true,
  })
  await root.query(`
    CREATE TABLE customers (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL, profile JSON NULL);
    INSERT INTO customers (id, email)
      WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
      SELECT i, CONCAT('user', i, '@example.com') FROM n;
    CREATE TABLE things (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      big BIGINT, price DECIMAL(10, 2), flag BOOLEAN, day DATE, at DATETIME, ts TIMESTAMP NULL, doc JSON, note TEXT
    );
  `)
  pool = new PoolManager({ sweepIntervalMs: 0 })
}, 240_000)
afterAll(async () => {
  await pool?.closeAll()
  await root?.end()
  await server?.stop()
})

const myResource = (config: Record<string, unknown> = {}, version = '1'): ResolvedResource =>
  resource({ ...base, ...config }, { password: server.password }, version)

const run = (res: ResolvedResource, sql: string, scope: Record<string, unknown> = {}, timeoutMs?: number) =>
  runQuery(pool, mysqlConnector, res, { sql }, { evaluate: scopeEvaluator(scope), timeoutMs })

async function countRows(table = 'customers', where = 'TRUE'): Promise<number> {
  const [rows] = await root.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
  return Number((rows as { n: number }[])[0]!.n)
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

/** The statements the test user is running right now, as the server sees them. */
async function running(like: string): Promise<{ info: string; time: number }[]> {
  const [rows] = await root.query(
    "SELECT INFO AS info, TIME AS time FROM information_schema.PROCESSLIST WHERE USER = ? AND INFO LIKE ? AND COMMAND <> 'Sleep'",
    [server.user, like],
  )
  return rows as { info: string; time: number }[]
}

describe.skipIf(!available)('MySQL connector', () => {
  describe('queries', () => {
    let res: ResolvedResource
    beforeAll(() => {
      res = myResource()
    })

    it('binds {{ }} values as parameters', async () => {
      const result = await run(
        res,
        'SELECT id, email FROM customers WHERE id = {{ id }} OR email = {{ email }} ORDER BY id',
        { id: 3, email: 'user7@example.com' },
      )
      expect(result.data).toEqual([
        { id: 3, email: 'user3@example.com' },
        { id: 7, email: 'user7@example.com' },
      ])
      expect(result.metadata).toMatchObject({ rowCount: 2, fields: [{ name: 'id' }, { name: 'email' }] })
    })

    it('expands arrays into lists, an empty one matching nothing', async () => {
      const sql = 'SELECT COUNT(*) AS n FROM customers WHERE id IN ({{ ids }}) AND id > {{ min }}'
      expect((await run(res, sql, { ids: [1, 2, 3, 40], min: 1 })).data).toEqual([{ n: 2 }])
      expect((await run(res, sql, { ids: [], min: 0 })).data).toEqual([{ n: 0 }])
    })

    it('binds objects as JSON, booleans as 0/1 and undefined as NULL', async () => {
      const result = await run(
        res,
        "SELECT JSON_EXTRACT({{ obj }}, '$.a') AS a, {{ yes }} AS yes, {{ missing }} IS NULL AS is_null",
        { obj: { a: 'hi' }, yes: true, missing: undefined },
      )
      // JSON_EXTRACT returns JSON, which comes back parsed.
      expect(result.data).toEqual([{ a: 'hi', yes: 1, is_null: 1 }])
    })

    it('reports affected rows and the insert id for writes', async () => {
      const insert = await run(
        res,
        'INSERT INTO things (big, price, flag, day, at, ts, doc, note) VALUES ({{ big }}, {{ price }}, {{ flag }}, {{ day }}, {{ at }}, {{ ts }}, {{ doc }}, {{ note }})',
        {
          big: '9007199254740993',
          price: '12.50',
          flag: true,
          day: '2026-10-14',
          at: '2026-10-14 09:30:00',
          ts: '2026-10-14 07:30:00',
          doc: { tags: ['a'] },
          note: 'hello',
        },
      )
      expect(insert).toEqual({
        data: [],
        metadata: { rowCount: 1, affectedRows: 1, insertId: 1, fields: [] },
      })
      const update = await run(res, 'UPDATE customers SET profile = {{ p }} WHERE id <= {{ n }}', {
        p: { vip: true },
        n: 4,
      })
      expect(update.metadata).toMatchObject({ rowCount: 4, affectedRows: 4 })
    })

    it('returns MySQL types as JSON-friendly values', async () => {
      const result = await run(
        res,
        'SELECT big, price, flag, day, at, ts, doc, note FROM things WHERE id = 1',
      )
      expect(result.data).toEqual([
        {
          // Past 2^53: a string rather than a rounded number. DECIMAL is always a string.
          big: '9007199254740993',
          price: '12.50',
          flag: 1,
          // DATE and DATETIME exactly as stored; TIMESTAMP is an instant (the session runs in UTC).
          day: '2026-10-14',
          at: '2026-10-14 09:30:00',
          ts: new Date('2026-10-14T07:30:00Z'),
          doc: { tags: ['a'] },
          note: 'hello',
        },
      ])
    })

    it('reports SQL errors with their MySQL code', async () => {
      const err = await failure(run(res, 'SELEC {{ x }}', { x: 1 }))
      expect(err.code).toBe('query')
      expect(err.details).toMatchObject({ code: 'ER_PARSE_ERROR', sqlState: '42000' })
      // The connection is still good afterwards.
      expect((await run(res, 'SELECT 1 AS one')).data).toEqual([{ one: 1 }])
    })

    it('reports {{ }} errors as expression errors', async () => {
      const err = await failure(run(res, 'SELECT {{ nope }}'))
      expect(err).toMatchObject({ code: 'expression', message: expect.stringMatching(/nope is not defined/) })
    })

    it('rejects {{ }} inside string literals and hand-written ? before running anything', async () => {
      const quoted = await failure(
        run(res, 'SELECT * FROM customers WHERE email = "{{ email }}"', { email: 'x' }),
      )
      expect(quoted.code).toBe('invalid_query')
      expect(quoted.details).toMatchObject({ hint: expect.stringMatching(/Remove the quotes/) })
      expect((await failure(run(res, 'SELECT * FROM customers WHERE id = ?'))).code).toBe('invalid_query')
    })
  })

  describe('injection', () => {
    let res: ResolvedResource
    beforeAll(() => {
      res = myResource()
    })

    it.each([
      "'; DROP TABLE customers; -- ",
      "' OR '1'='1",
      '1 OR 1=1',
      "user1@example.com' #",
      "\\'; DELETE FROM customers; #",
      '?',
    ])('a malicious value stays a value: %s', async (payload) => {
      const result = await run(res, 'SELECT id FROM customers WHERE email = {{ input }}', { input: payload })
      expect(result.data).toEqual([])
      expect(await countRows()).toBe(30)
    })

    it('prepares the statement with ? on the server and sends the value separately', async () => {
      const payload = "x'; SELECT SLEEP(0) #"
      const query = run(res, 'SELECT SLEEP(0.6) AS s, {{ input }} AS v', { input: payload })
      let prepared: string | undefined
      for (let i = 0; i < 40 && !prepared; i++) {
        await new Promise((r) => setTimeout(r, 25))
        const [rows] = await root.query(
          "SELECT SQL_TEXT AS text FROM performance_schema.prepared_statements_instances WHERE SQL_TEXT LIKE '%SLEEP(0.6)%'",
        )
        prepared = (rows as { text: string }[])[0]?.text
      }
      expect((await query).data).toEqual([{ s: 0, v: payload }])
      // (The process list would show the value substituted in: MySQL rebuilds the text for display.)
      expect(prepared).toBe('SELECT SLEEP(0.6) AS s, ? AS v')
      // And it's released afterwards rather than cached on the connection.
      const [after] = await root.query(
        "SELECT COUNT(*) AS n FROM performance_schema.prepared_statements_instances WHERE SQL_TEXT LIKE '%SLEEP(0.6)%'",
      )
      expect(Number((after as { n: number }[])[0]!.n)).toBe(0)
    })

    it('rejects multi-statement strings', async () => {
      const err = await failure(run(res, 'SELECT 1; DELETE FROM customers'))
      expect(err.details).toMatchObject({ code: 'ER_PARSE_ERROR' })
      expect(await countRows()).toBe(30)
    })

    it('never reads local files, even when the server allows LOAD DATA LOCAL', async () => {
      await root.query('SET GLOBAL local_infile = 1')
      try {
        await root.query('CREATE TABLE IF NOT EXISTS loaded (line TEXT)')
        const err = await failure(run(res, "LOAD DATA LOCAL INFILE '/etc/hosts' INTO TABLE loaded"))
        expect(err.code).toBe('query')
        expect(await countRows('loaded')).toBe(0)
      } finally {
        await root.query('SET GLOBAL local_infile = 0')
      }
    })
  })

  describe('guards', () => {
    it('read-only resources cannot write or change the schema', async () => {
      const ro = myResource({ readOnly: true })
      expect((await run(ro, 'SELECT COUNT(*) AS n FROM customers')).data).toEqual([{ n: 30 }])
      const update = await failure(run(ro, "UPDATE customers SET email = 'x' WHERE id = 1"))
      expect(update.details).toMatchObject({ code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' })
      await failure(run(ro, 'CREATE TABLE sneaky (id INT)'))
      await failure(run(ro, 'DROP TABLE customers'))
      expect(await countRows()).toBe(30)
      const [tables] = await root.query("SHOW TABLES LIKE 'sneaky'")
      expect(tables).toEqual([])
    })

    it('fails queries that return more than maxRows, but not writes that touch more', async () => {
      const small = myResource({ maxRows: 10, poolSize: 1 })
      expect((await run(small, 'SELECT id FROM customers LIMIT 10')).metadata.rowCount).toBe(10)
      expect((await failure(run(small, 'SELECT id FROM customers'))).code).toBe('too_large')
      // The dropped connection is replaced: the single-connection pool still works.
      expect((await run(small, 'UPDATE customers SET profile = NULL')).metadata.rowCount).toBe(30)
    })

    it('enforces the statement timeout and the run timeout, killing the query', async () => {
      const strict = myResource({ statementTimeoutMs: 300 })
      expect((await failure(run(strict, 'SELECT SLEEP(5)'))).code).toBe('timeout')
      expect((await failure(run(myResource(), 'SELECT SLEEP(5) AS run_timeout', {}, 300))).code).toBe(
        'timeout',
      )
      await expect.poll(() => running('%SLEEP(5)%'), { timeout: 2000 }).toEqual([])
    })

    it('cancels on abort: the query is killed on the server, and its connection is replaced', async () => {
      const res = myResource({ poolSize: 1 })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      const started = Date.now()
      const err = await failure(
        runQuery(
          pool,
          mysqlConnector,
          res,
          { sql: 'SELECT SLEEP(30) AS cancelled' },
          { evaluate: scopeEvaluator({}), signal: controller.signal },
        ),
      )
      expect(err.code).toBe('aborted')
      expect(Date.now() - started).toBeLessThan(2000)
      await expect.poll(() => running('%SLEEP(30)%'), { timeout: 2000 }).toEqual([])
      expect((await run(res, 'SELECT 2 AS two')).data).toEqual([{ two: 2 }])
    })

    it("never hands a killed query's connection to the next query, which a late KILL could hit", async () => {
      const res = myResource({ poolSize: 1, statementTimeoutMs: 300 })
      const before = (await run(res, 'SELECT CONNECTION_ID() AS id')).data as { id: number }[]
      expect((await failure(run(res, 'SELECT SLEEP(5) AS late_kill'))).code).toBe('timeout')
      const after = (await run(res, 'SELECT CONNECTION_ID() AS id')).data as { id: number }[]
      expect(after[0]!.id).not.toBe(before[0]!.id)
    })

    it("stops waiting when the KILL can't be sent, by dropping the connection", async () => {
      // One connection allowed: the query holds it, so the side connection for KILL QUERY is refused.
      await root.query(
        "CREATE USER IF NOT EXISTS 'one_conn'@'%' IDENTIFIED BY 'one-pass' WITH MAX_USER_CONNECTIONS 1",
      )
      await root.query(`GRANT SELECT ON \`${server.database}\`.* TO 'one_conn'@'%'`)
      const res = resource(
        { ...base, user: 'one_conn', poolSize: 1, statementTimeoutMs: 300 },
        { password: 'one-pass' },
      )
      const started = Date.now()
      expect((await failure(run(res, 'SELECT SLEEP(10) AS unkillable'))).code).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(3000)
    })
  })

  describe('testResource', () => {
    it('reports the server version, or a connection error without the password', async () => {
      const ok = await testResource(mysqlConnector, myResource())
      expect(ok).toMatchObject({ ok: true, message: expect.stringMatching(/^MySQL 8\.4/) })

      const bad = await testResource(
        mysqlConnector,
        resource({ ...base, port: 1 }, { password: server.password }),
        {
          timeoutMs: 5000,
        },
      )
      expect(bad).toMatchObject({ ok: false, error: { code: 'connection' } })
      expect(JSON.stringify(bad)).not.toContain(server.password)

      const wrong = await testResource(mysqlConnector, resource(base, { password: 'definitely-wrong-pw' }))
      expect(wrong).toMatchObject({ ok: false, error: { code: 'connection' } })
    })

    it('encrypts with ssl "require", and "verify-full" rejects an untrusted certificate', async () => {
      const cipher =
        "SELECT VARIABLE_VALUE AS cipher FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'"
      expect((await run(myResource({ ssl: 'require' }), cipher)).data).toEqual([
        { cipher: expect.stringMatching(/\w/) },
      ])
      expect((await run(myResource({ ssl: 'disable' }), cipher)).data).toEqual([{ cipher: '' }])

      // The Docker image's certificate is self-signed.
      const verify = await testResource(mysqlConnector, myResource({ ssl: 'verify-full' }))
      expect(verify).toMatchObject({ ok: false, error: { code: 'connection' } })
    })

    it('rejects invalid configuration with field paths', async () => {
      const bad = await testResource(mysqlConnector, resource({ host: '' }, {}))
      expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
    })
  })
})
