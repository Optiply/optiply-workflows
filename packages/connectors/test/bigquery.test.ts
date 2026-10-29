import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AnyConnector,
  ConnectorError,
  createBigQueryConnector,
  PoolManager,
  type ResolvedResource,
  runQuery,
  testResource,
} from '../src'
import { FakeBigQuery } from './bigquery-fake'
import { codeEvaluator, resource, scopeEvaluator } from './helpers'

// Against a fake BigQuery API (bigquery-fake.ts) that checks the signed JWT and records every request.
const fake = new FakeBigQuery()
let connector: AnyConnector
let pool: PoolManager

beforeAll(async () => {
  await fake.start()
  connector = createBigQueryConnector(fake.endpoints)
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool?.closeAll()
  await fake.stop()
})
beforeEach(() => {
  fake.requests.length = 0
})

let version = 0
const bqResource = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = {},
): ResolvedResource =>
  resource({ location: 'EU', ...config }, { serviceAccountKey: fake.keyJson, ...secrets }, String(++version))

const run = (
  res: ResolvedResource,
  sql: string,
  scope: Record<string, unknown> = {},
  opts: { timeoutMs?: number; signal?: AbortSignal; labels?: Record<string, string> } = {},
) => runQuery(pool, connector, res, { sql }, { evaluate: scopeEvaluator(scope), ...opts })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

// biome-ignore lint/suspicious/noExplicitAny: request JSON
const insertBody = () => fake.apiCalls('insert').at(-1)!.body as { jobReference: any; configuration: any }

describe('authentication', () => {
  it('signs a JWT for an access token, caches it, and refreshes it after a 401', async () => {
    const res = bqResource()
    const before = fake.tokensIssued
    await run(res, 'SELECT 1')
    await run(res, 'SELECT 1')
    expect(fake.tokensIssued).toBe(before + 1)
    expect(fake.apiCalls().every((r) => r.authorization === `Bearer tok-${before + 1}`)).toBe(true)
    // The key's own token_uri (evil.example.com) is never used: the fake checks the JWT's audience.
    fake.rejectNextToken = true
    await run(res, 'SELECT 1')
    expect(fake.tokensIssued).toBe(before + 2)
  })

  it('rejects a key that is not JSON or not a service account key, without quoting it', async () => {
    for (const serviceAccountKey of [
      'PRIVATE-KEY-TEXT {',
      JSON.stringify({ type: 'service_account', x: 'PRIVATE-KEY-TEXT' }),
    ]) {
      const err = await failure(run(bqResource({}, { serviceAccountKey }), 'SELECT 1'))
      expect(err).toMatchObject({
        code: 'invalid_config',
        details: { issues: [{ path: 'serviceAccountKey' }] },
      })
      expect(JSON.stringify(err)).not.toContain('PRIVATE-KEY-TEXT')
    }
  })

  it('reports a key Google refuses as a connection error', async () => {
    const { privateKey } = await import('node:crypto').then((c) =>
      c.generateKeyPairSync('rsa', { modulusLength: 2048 }),
    )
    const other = JSON.stringify({
      ...JSON.parse(fake.keyJson),
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    const result = await testResource(connector, bqResource({}, { serviceAccountKey: other }))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'connection', message: expect.stringMatching(/refused/) },
    })
  })
})

describe('queries', () => {
  it('sends {{ }} values as typed named parameters, never in the SQL', async () => {
    const when = new Date('2026-10-14T09:30:00Z')
    await run(
      bqResource(),
      'SELECT * FROM shop.orders WHERE id = {{ n }} AND f > {{ f }} AND s = {{ s }} AND b = {{ b }} AND at < {{ when }} AND id IN UNNEST({{ ids }}) AND x = {{ obj }} AND y = {{ nil }} AND z IN UNNEST({{ tags }})',
      {
        n: 3,
        f: 1.5,
        s: "x'; DROP TABLE t; --",
        b: true,
        when,
        ids: [1, 2.5],
        obj: { a: 1 },
        nil: null,
        tags: ['a', 'b'],
      },
    )
    const { query } = insertBody().configuration
    expect(query.query).toBe(
      'SELECT * FROM shop.orders WHERE id = @p1 AND f > @p2 AND s = @p3 AND b = @p4 AND at < @p5 AND id IN UNNEST(@p6) AND x = @p7 AND y = @p8 AND z IN UNNEST(@p9)',
    )
    expect(query).toMatchObject({ useLegacySql: false, parameterMode: 'NAMED' })
    expect(query.queryParameters).toEqual([
      { name: 'p1', parameterType: { type: 'INT64' }, parameterValue: { value: '3' } },
      { name: 'p2', parameterType: { type: 'FLOAT64' }, parameterValue: { value: '1.5' } },
      { name: 'p3', parameterType: { type: 'STRING' }, parameterValue: { value: "x'; DROP TABLE t; --" } },
      { name: 'p4', parameterType: { type: 'BOOL' }, parameterValue: { value: 'true' } },
      {
        name: 'p5',
        parameterType: { type: 'TIMESTAMP' },
        parameterValue: { value: '2026-10-14T09:30:00.000Z' },
      },
      {
        name: 'p6',
        parameterType: { type: 'ARRAY', arrayType: { type: 'FLOAT64' } },
        parameterValue: { arrayValues: [{ value: '1' }, { value: '2.5' }] },
      },
      { name: 'p7', parameterType: { type: 'STRING' }, parameterValue: { value: '{"a":1}' } },
      { name: 'p8', parameterType: { type: 'STRING' }, parameterValue: {} },
      {
        name: 'p9',
        parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: { arrayValues: [{ value: 'a' }, { value: 'b' }] },
      },
    ])
  })

  it('runs jobs with the bytes-billed limit, location, default dataset, labels and its own job id', async () => {
    await run(
      bqResource({
        projectId: 'billing-proj',
        defaultDataset: 'data-proj.shop',
        maximumBytesBilled: 5_000_000,
        labels: { team: 'ops' },
      }),
      'SELECT 1',
      {},
      { labels: { ow_source: 'workflow', ow_run: '0192F-ABC', 'Bad Key!': 'Some Value' } },
    )
    const call = fake.apiCalls('insert').at(-1)!
    expect(call.path).toBe('/bigquery/v2/projects/billing-proj/jobs')
    const body = insertBody()
    expect(body.jobReference).toEqual({
      projectId: 'billing-proj',
      jobId: expect.stringMatching(/^ow_[0-9a-f]{32}$/),
      location: 'EU',
    })
    expect(body.configuration.query).toMatchObject({
      maximumBytesBilled: '5000000',
      defaultDataset: { projectId: 'data-proj', datasetId: 'shop' },
    })
    // Labels made valid: lowercase, [a-z0-9_-]; a key not starting with a letter would be dropped.
    expect(body.configuration.labels).toEqual({
      team: 'ops',
      ow_source: 'workflow',
      ow_run: '0192f-abc',
      bad_key_: 'some_value',
    })
    // Results are read for the same job, in its location, with microsecond timestamps.
    const results = fake.apiCalls('results').at(-1)!
    expect(results.path).toBe(`/bigquery/v2/projects/billing-proj/queries/${body.jobReference.jobId}`)
    expect(results.query.get('location')).toBe('EU')
    expect(results.query.get('formatOptions.useInt64Timestamp')).toBe('true')
  })

  it('converts BigQuery values to JSON-friendly ones', async () => {
    fake.script('SELECT types', {
      schema: {
        fields: [
          { name: 'n', type: 'INTEGER' },
          { name: 'big', type: 'INTEGER' },
          { name: 'f', type: 'FLOAT' },
          { name: 'inf', type: 'FLOAT' },
          { name: 'num', type: 'NUMERIC' },
          { name: 'ok', type: 'BOOLEAN' },
          { name: 's', type: 'STRING' },
          { name: 'bytes', type: 'BYTES' },
          { name: 'ts', type: 'TIMESTAMP' },
          { name: 'day', type: 'DATE' },
          { name: 'dt', type: 'DATETIME' },
          { name: 'doc', type: 'JSON' },
          { name: 'tags', type: 'STRING', mode: 'REPEATED' },
          {
            name: 'addr',
            type: 'RECORD',
            fields: [
              { name: 'city', type: 'STRING' },
              { name: 'zip', type: 'INTEGER' },
            ],
          },
          { name: 'nothing', type: 'STRING' },
        ],
      },
      rows: [
        {
          f: [
            { v: '42' },
            { v: '9007199254740993' },
            { v: '1.5' },
            { v: 'Infinity' },
            { v: '12.50' },
            { v: 'true' },
            { v: 'hi' },
            { v: 'AAE=' },
            { v: '1791969000123456' },
            { v: '2026-10-14' },
            { v: '2026-10-14T09:30:00' },
            { v: '{"a":[1]}' },
            { v: [{ v: 'x' }, { v: 'y' }] },
            { v: { f: [{ v: 'Utrecht' }, { v: '3511' }] } },
            { v: null },
          ],
        },
      ],
    })
    const result = await run(bqResource(), 'SELECT types')
    expect(result.data).toEqual([
      {
        n: 42,
        big: '9007199254740993',
        f: 1.5,
        inf: 'Infinity',
        num: '12.50',
        ok: true,
        s: 'hi',
        bytes: 'AAE=',
        ts: '2026-10-14T09:10:00.123Z',
        day: '2026-10-14',
        dt: '2026-10-14T09:30:00',
        doc: { a: [1] },
        tags: ['x', 'y'],
        addr: { city: 'Utrecht', zip: 3511 },
        nothing: null,
      },
    ])
    expect(result.metadata).toMatchObject({
      rowCount: 1,
      jobId: expect.stringMatching(/^ow_/),
      location: 'EU',
      fields: expect.arrayContaining([{ name: 'tags', type: 'STRING', mode: 'REPEATED' }]),
    })
  })

  it('polls an unfinished job and pages through the results', async () => {
    fake.script('SELECT paged', {
      schema: { fields: [{ name: 'i', type: 'INTEGER' }] },
      rows: Array.from({ length: 25 }, (_, i) => ({ f: [{ v: String(i) }] })),
      pageSize: 10,
      pending: 2,
      bytes: 1234,
    })
    const result = await run(bqResource(), 'SELECT paged')
    expect((result.data as { i: number }[]).map((r) => r.i)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    expect(result.metadata).toMatchObject({ rowCount: 25, totalBytesProcessed: 1234 })
    // Two "not yet", the first page, then two more pages.
    expect(fake.apiCalls('results').map((r) => r.query.get('pageToken'))).toEqual([
      null,
      null,
      null,
      '10',
      '20',
    ])
  })

  it('fails results past maxRows without fetching them all', async () => {
    fake.script('SELECT many', {
      schema: { fields: [{ name: 'i', type: 'INTEGER' }] },
      rows: Array.from({ length: 50 }, (_, i) => ({ f: [{ v: String(i) }] })),
      pageSize: 10,
    })
    const err = await failure(run(bqResource({ maxRows: 20 }), 'SELECT many'))
    expect(err).toMatchObject({ code: 'too_large', message: expect.stringMatching(/50 rows, more than 20/) })
    expect(fake.apiCalls('results')).toHaveLength(1)
  })

  it('reports affected rows for DML', async () => {
    fake.script(/^UPDATE/, { numDmlAffectedRows: 7 })
    const result = await run(bqResource(), 'UPDATE shop.orders SET status = {{ s }} WHERE TRUE', {
      s: 'done',
    })
    expect(result).toMatchObject({ data: [], metadata: { rowCount: 7, affectedRows: 7, fields: [] } })
  })

  it('refuses a query that would bill more than the limit', async () => {
    fake.script('SELECT expensive', { bytes: 50 * 1024 ** 3, rows: [] })
    const err = await failure(run(bqResource(), 'SELECT expensive'))
    expect(err).toMatchObject({
      code: 'query',
      message: expect.stringMatching(/would bill more than the resource's maximum bytes billed/),
      details: { reason: 'bytesBilledLimitExceeded' },
    })
  })

  it("reports BigQuery's query errors with their reason and location", async () => {
    fake.script('SELEC 1', {
      error: {
        reason: 'invalidQuery',
        message: 'Syntax error: Unexpected identifier "SELEC" at [1:1]',
        location: 'query',
      },
    })
    const err = await failure(run(bqResource(), 'SELEC 1'))
    expect(err).toMatchObject({ code: 'query', details: { reason: 'invalidQuery', location: 'query' } })
  })

  it('rejects hand-written parameters and {{ }} in strings before calling BigQuery', async () => {
    expect((await failure(run(bqResource(), 'SELECT * FROM t WHERE id = @id'))).code).toBe('invalid_query')
    expect((await failure(run(bqResource(), "SELECT '{{ x }}'", { x: 1 }))).code).toBe('invalid_query')
    expect(fake.apiCalls()).toEqual([])
  })
})

describe('stopping', () => {
  it('cancels the job when the run is cancelled', async () => {
    fake.script('SELECT slow', { pending: Number.POSITIVE_INFINITY })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    const err = await failure(run(bqResource(), 'SELECT slow', {}, { signal: controller.signal }))
    expect(err.code).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(2000)
    const jobId = insertBody().jobReference.jobId
    await expect.poll(() => fake.jobs.get(jobId)?.cancelled).toBe(true)
    expect(fake.apiCalls('cancel').at(-1)!.query.get('location')).toBe('EU')
  })

  it('cancels the job at the statement timeout and at the run timeout', async () => {
    fake.script('SELECT slow', { pending: Number.POSITIVE_INFINITY })
    const strict = await failure(run(bqResource({ statementTimeoutMs: 300 }), 'SELECT slow'))
    expect(strict).toMatchObject({ code: 'timeout', message: expect.stringMatching(/statement timeout/) })
    const first = insertBody().jobReference.jobId
    await expect.poll(() => fake.jobs.get(first)?.cancelled).toBe(true)

    expect((await failure(run(bqResource(), 'SELECT slow', {}, { timeoutMs: 300 }))).code).toBe('timeout')
    const second = insertBody().jobReference.jobId
    await expect.poll(() => fake.jobs.get(second)?.cancelled).toBe(true)
  })
})

describe('testResource', () => {
  it('dry-runs a query to check the key, project and permission', async () => {
    const ok = await testResource(connector, bqResource())
    expect(ok).toMatchObject({
      ok: true,
      message: `BigQuery project optiply-test as ${fake.clientEmail}`,
    })
    expect(fake.apiCalls('dryRun').at(-1)!.body).toMatchObject({
      query: 'SELECT 1',
      dryRun: true,
      location: 'EU',
    })
  })

  it('needs the service account key', async () => {
    const result = await testResource(connector, resource({}, {}))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', details: { issues: [{ path: 'serviceAccountKey' }] } },
    })
  })

  it('never puts the private key in an error', async () => {
    const res = bqResource({ labels: { 'Not Valid': 'x' } })
    const result = await testResource(connector, res)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
  })
})

describe('sql.column and sql.direction', () => {
  it('put the checked column and direction into the query text; values stay parameters', async () => {
    await runQuery(
      pool,
      connector,
      bqResource(),
      {
        sql: "SELECT * FROM shop.orders WHERE n > {{ n }} ORDER BY {{ sql.column(c, ['o.created_at', 'total']) }} {{ sql.direction(d) }}",
      },
      {
        evaluate: codeEvaluator({
          n: 1,
          "sql.column(c, ['o.created_at', 'total'])": 'o.created_at',
          'sql.direction(d)': 'DESC',
        }),
      },
    ).catch(() => {})
    const { query } = insertBody().configuration
    expect(query.query).toBe('SELECT * FROM shop.orders WHERE n > @p1 ORDER BY `o`.`created_at` DESC')
    expect(query.queryParameters.map((p: { name: string }) => p.name)).toEqual(['p1'])
  })

  it('sql.where (M24): a condition with typed, numbered parameters among the others', async () => {
    await runQuery(
      pool,
      connector,
      bqResource(),
      { sql: "SELECT * FROM shop.orders WHERE {{ sql.where(f, ['day', 'name']) }} AND n > {{ n }}" },
      {
        evaluate: codeEvaluator({
          n: 1,
          "sql.where(f, ['day', 'name'])": [
            { column: 'day', op: 'gte', value: '2026-01-01', type: 'date' },
            { column: 'name', op: 'contains', value: 'ab' },
          ],
        }),
      },
    ).catch(() => {})
    const { query } = insertBody().configuration
    expect(query.query).toBe(
      'SELECT * FROM shop.orders WHERE (`day` >= CAST(@p1 AS DATE)) AND (STRPOS(LOWER(CAST(`name` AS STRING)), LOWER(@p2)) > 0) AND n > @p3',
    )
    expect(query.queryParameters.map((p: { name: string }) => p.name)).toEqual(['p1', 'p2', 'p3'])
    expect(query.queryParameters[0].parameterValue).toEqual({ value: '2026-01-01' })
  })
})
