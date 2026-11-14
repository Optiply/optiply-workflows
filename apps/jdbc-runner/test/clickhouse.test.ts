import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clickhouse,
  jdbcRunnerAvailable,
  startTestClickHouse,
  startTestJdbcRunner,
  type TestClickHouse,
  type TestJdbcRunner,
  testNetwork,
} from '../src/testing'

// The runner's image with a real ClickHouse (its built-in driver, over HTTP): connect, query, types, the guards.

const available = jdbcRunnerAvailable()
let network: ReturnType<typeof testNetwork>
let runner: TestJdbcRunner
let ch: TestClickHouse

beforeAll(async () => {
  if (!available) return
  network = testNetwork()
  ;[runner, ch] = await Promise.all([
    startTestJdbcRunner({ network: network.name }),
    startTestClickHouse(network.name),
  ])
  await clickhouse(
    ch,
    'CREATE TABLE things (id UInt64, name String, price Decimal(10, 2), at DateTime, day Date, tags Array(String), note Nullable(String)) ENGINE = MergeTree ORDER BY id',
  )
}, 900_000)
afterAll(async () => {
  await runner?.stop()
  await ch?.stop()
  network?.remove()
})

const connection = (over: Record<string, unknown> = {}) => ({
  poolKey: 'clickhouse-test',
  driver: 'clickhouse',
  url: `jdbc:clickhouse://${ch.host}:${ch.port}/${ch.database}`,
  properties: { user: ch.user, password: ch.password },
  ...over,
})

interface Answer {
  fields?: { name: string; type: string }[]
  rows: Record<string, unknown>[]
  end?: { affectedRows: number }
  error?: { kind: string; message: string }
}

async function query(
  sql: string,
  params: unknown[] = [],
  opts: Record<string, unknown> = {},
): Promise<Answer> {
  const res = await fetch(`${runner.url}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({
      queryId: randomUUID(),
      connection: connection(opts.connection as Record<string, unknown>),
      sql,
      params,
      maxRows: opts.maxRows ?? 1000,
      timeoutMs: opts.timeoutMs ?? 30_000,
    }),
  })
  expect(res.status).toBe(200)
  const answer: Answer = { rows: [] }
  for (const line of (await res.text()).split('\n').filter(Boolean)) {
    const l = JSON.parse(line)
    if (l.type === 'fields') answer.fields = l.fields
    else if (l.type === 'rows') answer.rows.push(...l.rows)
    else if (l.type === 'end') answer.end = l
    else if (l.type === 'error') answer.error = l
  }
  return answer
}

describe.skipIf(!available)('the JDBC runner with ClickHouse', () => {
  it('tests the connection, or says why it fails', async () => {
    const test = async (conn: Record<string, unknown>) =>
      (
        await fetch(`${runner.url}/test`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${runner.token}` },
          body: JSON.stringify({ connection: conn, timeoutMs: 20_000 }),
        })
      ).json()
    expect(await test(connection())).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^ClickHouse 26\.8/),
    })
    const wrong = await test(
      connection({ poolKey: 'wrong', properties: { user: ch.user, password: 'nope-nope' } }),
    )
    expect(wrong).toMatchObject({ ok: false, error: { kind: 'connection' } })
    expect(JSON.stringify(wrong)).not.toContain(ch.password)
  })

  it('writes and reads with bound values, as JSON-friendly types', async () => {
    const insert = await query(
      'INSERT INTO things (id, name, price, at, day, tags, note) VALUES (?, ?, ?, ?, ?, ?, ?), (18446744073709551615, ?, 1, now(), today(), [], NULL)',
      [1, "O'Brien", 12.34, '2026-10-14 09:30:00', '2026-10-14', "['a','b']", null, 'max'],
    )
    expect(insert.error).toBeUndefined()
    const read = await query(
      'SELECT id, name, price, at, day, tags, note FROM things WHERE name = ? ORDER BY id',
      ["O'Brien"],
    )
    expect(read.error).toBeUndefined()
    expect(read.rows).toEqual([
      {
        id: 1,
        name: "O'Brien",
        price: 12.34,
        at: '2026-10-14 09:30:00',
        day: '2026-10-14',
        tags: ['a', 'b'],
        note: null,
      },
    ])
    expect(read.fields?.map((f) => f.name)).toEqual(['id', 'name', 'price', 'at', 'day', 'tags', 'note'])
    const big = await query("SELECT id FROM things WHERE name = 'max'")
    expect(big.rows).toEqual([{ id: '18446744073709551615' }])
    expect((await query('SELECT * FROM nope')).error).toMatchObject({ kind: 'query' })
  })

  it('fails results past maxRows, and times out on the server', async () => {
    expect((await query('SELECT number FROM numbers(100)', [], { maxRows: 10 })).error).toMatchObject({
      kind: 'too_large',
    })
    const started = Date.now()
    const slow = await query(
      'SELECT sleepEachRow(0.5), number AS slow_marker FROM numbers(40) SETTINGS max_block_size = 1',
      [],
      {
        timeoutMs: 1500,
      },
    )
    expect(slow.error).toMatchObject({ kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('read-only: ClickHouse itself refuses writes and schema changes, and reads still work', async () => {
    const ro = { connection: { poolKey: 'ro', readOnly: true } }
    const before = (await clickhouse(ch, 'SELECT count() FROM things')).trim()
    expect((await query('SELECT count() AS n FROM things', [], ro)).rows).toEqual([{ n: Number(before) }])
    for (const sql of [
      "INSERT INTO things (id, name) VALUES (99, 'ro')",
      'CREATE TABLE sneaky (id UInt8) ENGINE = Memory',
    ]) {
      expect((await query(sql, [], ro)).error).toMatchObject({
        kind: 'query',
        message: expect.stringMatching(/read-only/),
      })
    }
    expect((await clickhouse(ch, 'SELECT count() FROM things')).trim()).toBe(before)
    expect((await clickhouse(ch, 'EXISTS TABLE sneaky')).trim()).toBe('0')
  })
})
