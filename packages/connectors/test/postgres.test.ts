import { startTestDatabase } from '@ow/db/testing'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  PoolManager,
  postgresConnector,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import { resource, scopeEvaluator } from './helpers'

let stopDb: () => Promise<void>
let admin: postgres.Sql
let pool: PoolManager
let base: Record<string, unknown>
let password: string

beforeAll(async () => {
  const pg = await startTestDatabase()
  stopDb = pg.stop
  const url = new URL(pg.url)
  password = decodeURIComponent(url.password)
  base = {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    ssl: 'disable',
  }
  admin = postgres(pg.url, { onnotice: () => {} })
  await admin.unsafe(`
    create table customers (id int primary key, email text not null, profile jsonb);
    insert into customers select g, 'user' || g || '@example.com', null from generate_series(1, 30) g;
  `)
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool?.closeAll()
  await admin?.end()
  await stopDb?.()
})

const pgResource = (config: Record<string, unknown> = {}, version = '1'): ResolvedResource =>
  resource({ ...base, ...config }, { password }, version)

const run = (res: ResolvedResource, sql: string, scope: Record<string, unknown> = {}, timeoutMs?: number) =>
  runQuery(pool, postgresConnector, res, { sql }, { evaluate: scopeEvaluator(scope), timeoutMs })

async function countRows(where = 'true'): Promise<number> {
  const [row] = await admin.unsafe(`select count(*)::int as n from customers where ${where}`)
  return row!.n as number
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

describe('queries', () => {
  let res: ResolvedResource
  beforeAll(() => {
    res = pgResource()
  })

  it('binds {{ }} values as parameters', async () => {
    const result = await run(
      res,
      'select id, email from customers where id = {{ id }} or email = {{ email }} order by id',
      {
        id: 3,
        email: 'user7@example.com',
      },
    )
    expect(result.data).toEqual([
      { id: 3, email: 'user3@example.com' },
      { id: 7, email: 'user7@example.com' },
    ])
    expect(result.metadata).toMatchObject({ rowCount: 2, fields: [{ name: 'id' }, { name: 'email' }] })
  })

  it('binds arrays natively and objects as JSON', async () => {
    const ids = await run(res, 'select count(*)::int as n from customers where id = any({{ ids }})', {
      ids: [1, 2, 3],
    })
    expect(ids.data).toEqual([{ n: 3 }])
    const json = await run(res, "select ({{ obj }}::jsonb)->>'a' as a, {{ obj }}::text as t", {
      obj: { a: 'hi' },
    })
    expect(json.data).toEqual([{ a: 'hi', t: '{"a":"hi"}' }])
    const nil = await run(res, 'select {{ missing }}::text is null as is_null', { missing: undefined })
    expect(nil.data).toEqual([{ is_null: true }])
  })

  it('reports the command and row count for writes', async () => {
    const result = await run(res, 'update customers set profile = {{ p }} where id <= {{ n }}', {
      p: { vip: true },
      n: 4,
    })
    expect(result).toEqual({ data: [], metadata: { command: 'UPDATE', rowCount: 4, fields: [] } })
  })

  it('describes before evaluating, so a SQL error never runs the {{ }} code', async () => {
    const evaluate = scopeEvaluator({ x: 1 })
    const err = await failure(runQuery(pool, postgresConnector, res, { sql: 'selec {{ x }}' }, { evaluate }))
    expect(err.code).toBe('query')
    expect(err.details).toMatchObject({ sqlState: '42601' })
    expect(evaluate.calls).toEqual([])
  })

  it('reports {{ }} errors as expression errors', async () => {
    const err = await failure(run(res, 'select {{ nope }}::int'))
    expect(err).toMatchObject({ code: 'expression', message: expect.stringMatching(/nope is not defined/) })
  })

  it('rejects {{ }} inside string literals before running anything', async () => {
    const err = await failure(run(res, "select * from customers where email = '{{ email }}'", { email: 'x' }))
    expect(err.code).toBe('invalid_query')
    expect(err.details).toMatchObject({ hint: expect.stringMatching(/Remove the quotes/) })
  })
})

describe('injection', () => {
  let res: ResolvedResource
  beforeAll(() => {
    res = pgResource()
  })

  it.each(["'; drop table customers; --", "' or '1'='1", '1 OR 1=1', "user1@example.com' --", '$1'])(
    'a malicious value stays a value: %s',
    async (payload) => {
      const result = await run(res, 'select id from customers where email = {{ input }}', { input: payload })
      expect(result.data).toEqual([])
      expect(await countRows()).toBe(30)
    },
  )

  it('shows $1 (not the value) in pg_stat_activity', async () => {
    const payload = "x'; select pg_sleep(0) --"
    const running = run(res, 'select pg_sleep(0.6), {{ input }}::text as v', { input: payload })
    let seen: string | undefined
    for (let i = 0; i < 40 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 25))
      const rows = await admin`
        select query from pg_stat_activity
        where application_name = 'optiply-workflows' and query like '%pg_sleep(0.6)%' and state = 'active'`
      seen = rows[0]?.query
    }
    await running
    expect(seen).toBe('select pg_sleep(0.6), $1::text as v')
  })

  it('rejects multi-statement strings, so they cannot break out of the transaction', async () => {
    const err = await failure(run(res, 'select 1; delete from customers'))
    expect(err.details).toMatchObject({ sqlState: '42601' })
    const ro = pgResource({ readOnly: true })
    await failure(run(ro, 'commit; delete from customers'))
    expect(await countRows()).toBe(30)
  })
})

describe('guards', () => {
  it('read-only resources cannot write', async () => {
    const ro = pgResource({ readOnly: true })
    expect((await run(ro, 'select count(*)::int as n from customers')).data).toEqual([{ n: 30 }])
    const err = await failure(run(ro, "update customers set email = 'x' where id = 1"))
    expect(err.details).toMatchObject({ sqlState: '25006' })
  })

  it('fails queries that return more than maxRows, but not writes that touch more', async () => {
    const small = pgResource({ maxRows: 10 })
    expect((await run(small, 'select id from customers limit 10')).metadata.rowCount).toBe(10)
    const err = await failure(run(small, 'select id from customers'))
    expect(err.code).toBe('too_large')
    expect((await run(small, 'update customers set profile = null')).metadata.rowCount).toBe(30)
    // An oversized RETURNING rolls the write back.
    await failure(run(small, "update customers set email = email || '.x' returning id"))
    expect(await countRows("email like '%.x'")).toBe(0)
  })

  it('enforces the statement timeout and the run timeout, and cancels on abort', async () => {
    const strict = pgResource({ statementTimeoutMs: 200 })
    expect((await failure(run(strict, 'select pg_sleep(2)'))).code).toBe('timeout')
    expect((await failure(run(pgResource(), 'select pg_sleep(2)', {}, 200))).code).toBe('timeout')

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    const err = await failure(
      runQuery(
        pool,
        postgresConnector,
        pgResource(),
        { sql: 'select pg_sleep(5)' },
        {
          evaluate: scopeEvaluator({}),
          signal: controller.signal,
        },
      ),
    )
    expect(err.code).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('testResource', () => {
  it('reports the server version, or a connection error without the password', async () => {
    const ok = await testResource(postgresConnector, pgResource())
    expect(ok).toMatchObject({ ok: true, message: expect.stringMatching(/^PostgreSQL 18/) })

    const bad = await testResource(postgresConnector, resource({ ...base, port: 1 }, { password }), {
      timeoutMs: 5000,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.code).toBe('connection')
      expect(JSON.stringify(bad.error)).not.toContain(password)
    }

    const wrong = await testResource(postgresConnector, resource(base, { password: 'definitely-wrong-pw' }))
    expect(wrong.ok).toBe(false)
  })

  it('rejects invalid configuration with field paths', async () => {
    const bad = await testResource(postgresConnector, resource({ host: '' }, {}))
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
  })
})
