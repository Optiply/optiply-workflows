import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AnyConnector,
  ConnectorError,
  type CredentialSource,
  createBigQueryConnector,
  describeSqlSchema,
  httpConfigFor,
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

    // The query's own timeout overrides the resource's statement timeout: the run timeout ends it, not the 300 ms.
    const started = Date.now()
    const own = await failure(
      run(bqResource({ statementTimeoutMs: 300 }), 'SELECT slow', {}, { timeoutMs: 800 }),
    )
    expect(own).toMatchObject({ code: 'timeout', message: 'The query timed out after 800 ms' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(750)
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

describe('OAuth sign-in', () => {
  const oauth = (tokens: 'shared' | 'perUser' = 'perUser', config: Record<string, unknown> = {}) =>
    resource(
      {
        location: 'EU',
        projectId: 'optiply-dw',
        auth: { type: 'oauth', clientId: 'cid', tokens },
        ...config,
      },
      { clientSecret: 'shh' },
      String(++version),
    )
  /** A connected account: hands out `first`, then `fresh` when asked to force a new one; records each ask. */
  const account = (first: string, fresh = `${first}-fresh`) => {
    const asks: boolean[] = []
    const credentials: CredentialSource = {
      async accessToken({ force }) {
        asks.push(force === true)
        return force ? fresh : first
      },
    }
    fake.allowToken(first)
    fake.allowToken(fresh)
    return { credentials, asks }
  }

  it("runs jobs with the connected account's token, in the resource's project, and no service account", async () => {
    const before = fake.tokensIssued
    const { credentials } = account('ya29.alice')
    const result = await runQuery(
      pool,
      connector,
      oauth(),
      { sql: 'SELECT 1' },
      {
        evaluate: scopeEvaluator({}),
        credentials,
      },
    )
    expect(result.data).toBeDefined()
    expect(fake.apiCalls().length).toBeGreaterThan(0)
    expect(fake.apiCalls().every((r) => r.authorization === 'Bearer ya29.alice')).toBe(true)
    expect(insertBody().jobReference.projectId).toBe('optiply-dw')
    expect(fake.tokensIssued).toBe(before) // no JWT exchange
  })

  it('asks the account for a fresh token once when BigQuery refuses one', async () => {
    const { credentials, asks } = account('ya29.old', 'ya29.new')
    fake.rejectNextToken = true
    await runQuery(
      pool,
      connector,
      oauth(),
      { sql: 'SELECT 1' },
      { evaluate: scopeEvaluator({}), credentials },
    )
    expect(asks.slice(0, 2)).toEqual([false, true])
    expect(fake.apiCalls().at(-1)!.authorization).toBe('Bearer ya29.new')
  })

  it('asks for a connected account when the query has none, before calling BigQuery', async () => {
    const err = await failure(
      runQuery(pool, connector, oauth(), { sql: 'SELECT 1' }, { evaluate: scopeEvaluator({}) }),
    )
    expect(err).toMatchObject({
      code: 'auth_required',
      message: expect.stringMatching(/Connect a Google account/),
    })
    expect(fake.apiCalls()).toHaveLength(0)
  })

  it('needs the project (there is no key to take it from), not a service account key', async () => {
    const { credentials } = account('ya29.bob')
    const result = await testResource(connector, oauth('shared', { projectId: undefined }), { credentials })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', details: { issues: [{ path: 'projectId' }] } },
    })
  })

  it("cancels a job with the same account's token", async () => {
    const { credentials } = account('ya29.carol')
    fake.script('SELECT slow', { pending: Number.POSITIVE_INFINITY })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const err = await failure(
      runQuery(
        pool,
        connector,
        oauth(),
        { sql: 'SELECT slow' },
        {
          evaluate: scopeEvaluator({}),
          credentials,
          signal: controller.signal,
        },
      ),
    )
    expect(err.code).toBe('aborted')
    const jobId = insertBody().jobReference.jobId
    await expect.poll(() => fake.jobs.get(jobId)?.cancelled).toBe(true)
    expect(fake.apiCalls('cancel').at(-1)!.authorization).toBe('Bearer ya29.carol')
  })

  it('Test connection dry-runs as the connected account and says whose', async () => {
    const mine = account('ya29.dave')
    expect(await testResource(connector, oauth('perUser'), { credentials: mine.credentials })).toMatchObject({
      ok: true,
      message: 'BigQuery project optiply-dw as your Google account',
    })
    expect(fake.apiCalls('dryRun').at(-1)!.authorization).toBe('Bearer ya29.dave')
    const shared = account('ya29.team')
    expect(await testResource(connector, oauth('shared'), { credentials: shared.credentials })).toMatchObject(
      {
        ok: true,
        message: 'BigQuery project optiply-dw as the connected Google account',
      },
    )
  })

  it("gives the server's OAuth sign-in Google's endpoints and the BigQuery scope; none for a service account", () => {
    const http = httpConfigFor('bigquery', { projectId: 'p', auth: { type: 'oauth', clientId: 'cid' } })
    expect(http).toMatchObject({
      baseUrl: 'https://bigquery.googleapis.com/',
      allowedHosts: [],
      auth: {
        type: 'oauth2AuthorizationCode',
        provider: 'google',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: 'cid',
        scope: 'openid email https://www.googleapis.com/auth/bigquery',
        tokens: 'shared',
        pkce: true,
        authorizeParams: expect.arrayContaining([{ key: 'access_type', value: 'offline' }]),
      },
    })
    // Resources saved before OAuth (no `auth`) keep signing in with their key.
    expect(httpConfigFor('bigquery', { projectId: 'p' })?.auth).toEqual({ type: 'none' })
    expect(httpConfigFor('bigquery', { auth: { type: 'serviceAccount' } })?.auth).toEqual({ type: 'none' })
  })
})

describe('Optiply sign-in (the data platform, through STS)', () => {
  const optiply = (config: Record<string, unknown> = {}) =>
    resource(
      {
        location: 'EU',
        projectId: 'optiply-workflows',
        auth: { type: 'optiply', clientId: 'spa-client' },
        ...config,
      },
      {},
      String(++version),
    )
  /**
   * A connected Optiply account: hands out `first`, and `fresh` from the first forced ask on (as the server does: it
   * keeps the refreshed token). STS accepts both.
   */
  const account = (first: string, fresh = `${first}-fresh`) => {
    const asks: boolean[] = []
    let current = first
    const credentials: CredentialSource = {
      async accessToken({ force }) {
        asks.push(force === true)
        if (force) current = fresh
        return current
      },
    }
    fake.allowOptiplyToken(first)
    fake.allowOptiplyToken(fresh)
    return { credentials, asks }
  }
  const query = (res: ResolvedResource, credentials?: CredentialSource, sql = 'SELECT 1') =>
    runQuery(pool, connector, res, { sql }, { evaluate: scopeEvaluator({}), credentials })
  /** An unsigned JWT with this `exp` (seconds), as Auth0's access tokens are shaped. */
  const jwt = (exp: number, id: string) =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp, sub: id })).toString('base64url')}.sig`

  it("exchanges the person's Optiply token at STS and runs jobs with the Google token, never the Optiply one", async () => {
    const before = fake.stsIssued
    const { credentials } = account('optiply.alice')
    await query(optiply(), credentials)
    expect(fake.stsCalls()).toHaveLength(1)
    expect(fake.stsCalls()[0]!.body).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: fake.stsAudience,
      subject_token: 'optiply.alice',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    })
    const google = `fed-${before + 1}`
    expect(fake.apiCalls().every((r) => r.authorization === `Bearer ${google}`)).toBe(true)
    expect(JSON.stringify(fake.apiCalls())).not.toContain('optiply.alice')
    expect(insertBody().jobReference.projectId).toBe('optiply-workflows')
  })

  it('reuses the Google token for the same Optiply token, and exchanges a new Optiply token again', async () => {
    const res = optiply()
    const alice = account('optiply.erin')
    await query(res, alice.credentials)
    await query(res, alice.credentials)
    expect(fake.stsCalls()).toHaveLength(1)
    const bob = account('optiply.frank')
    await query(res, bob.credentials)
    expect(fake.stsCalls()).toHaveLength(2)
    expect(fake.stsCalls()[1]!.body).toMatchObject({ subject_token: 'optiply.frank' })
  })

  it('shares one exchange between simultaneous queries; cancelling one leaves the others running', async () => {
    const res = optiply()
    const { credentials } = account('optiply.lena')
    fake.exchangeDelayMs = 300
    try {
      const results = await Promise.all([
        query(res, credentials),
        query(res, credentials),
        query(res, credentials),
      ])
      expect(results).toHaveLength(3)
      expect(fake.stsCalls()).toHaveLength(1)

      const other = account('optiply.mo')
      fake.requests.length = 0
      const controller = new AbortController()
      const cancelled = runQuery(
        pool,
        connector,
        res,
        { sql: 'SELECT 1' },
        { evaluate: scopeEvaluator({}), credentials: other.credentials, signal: controller.signal },
      )
      const kept = query(res, other.credentials)
      setTimeout(() => controller.abort(), 50)
      expect((await failure(cancelled)).code).toBe('aborted')
      expect((await kept).data).toBeDefined()
      expect(fake.stsCalls()).toHaveLength(1)
    } finally {
      fake.exchangeDelayMs = 0
    }
  })

  it('never keeps a Google token past the Optiply token it came from', async () => {
    const res = optiply()
    const soon = jwt(Math.floor(Date.now() / 1000) + 30, 'grace') // inside the minute's margin
    const { credentials } = account(soon)
    await query(res, credentials)
    await query(res, credentials)
    // Every BigQuery call (an insert and a results read per query) got a freshly exchanged token.
    expect(fake.apiCalls().length).toBeGreaterThanOrEqual(4)
    expect(fake.stsCalls()).toHaveLength(fake.apiCalls().length)
  })

  it('gets a fresh Optiply token and exchanges it again when BigQuery refuses the Google token', async () => {
    const { credentials, asks } = account('optiply.old', 'optiply.new')
    fake.rejectNextToken = true
    await query(optiply(), credentials)
    expect(asks.slice(0, 2)).toEqual([false, true])
    expect(fake.stsCalls().map((r) => (r.body as Record<string, string>).subject_token)).toEqual([
      'optiply.old',
      'optiply.new',
    ])
  })

  it('tries once more with a fresh Optiply token when STS refuses one, then reports why without the token', async () => {
    const once = account('optiply.henk', 'optiply.henk2')
    fake.refuseNextExchange = true
    await query(optiply(), once.credentials)
    expect(once.asks.slice(0, 2)).toEqual([false, true])
    expect(fake.stsCalls().map((r) => (r.body as Record<string, string>).subject_token)).toEqual([
      'optiply.henk',
      'optiply.henk2',
    ])

    const asks: boolean[] = []
    const revoked: CredentialSource = {
      async accessToken({ force }) {
        asks.push(force === true)
        return 'optiply.revoked' // STS was never told to accept it
      },
    }
    fake.requests.length = 0
    const err = await failure(query(optiply(), revoked))
    expect(err.code).toBe('connection')
    expect(err.message).toMatch(
      /Google refused your Optiply sign-in.*invalid_grant: The token is invalid.*Connect your account again/,
    )
    expect(err.message).not.toContain('optiply.revoked')
    expect(asks).toEqual([false, true])
    expect(fake.apiCalls()).toHaveLength(0)
  })

  it("doesn't refresh the Optiply token for refusals a refresh can't fix, and says what to do", async () => {
    for (const [status, body, message] of [
      [
        400,
        { error: 'invalid_target', error_description: 'The audience is invalid' },
        /invalid_target: The audience is invalid.*Optiply app and audience/,
      ],
      [429, { error: 'rate_limited' }, /right now \(rate_limited\)\. Try again shortly/],
      [503, 'Service Unavailable', /right now \(HTTP 503\)\. Try again shortly/],
    ] as const) {
      const { credentials, asks } = account(`optiply.${status}`)
      fake.requests.length = 0
      fake.failExchange = { status, body, times: 2 }
      const err = await failure(query(optiply(), credentials))
      expect(err.code, String(status)).toBe('connection')
      expect(err.message, String(status)).toMatch(message)
      expect(asks, String(status)).toEqual([false]) // no fresh Optiply token
      expect(fake.stsCalls(), String(status)).toHaveLength(1)
      fake.failExchange = null
    }
  })

  it('asks for a connected Optiply account when the query has none, before calling STS or BigQuery', async () => {
    const err = await failure(query(optiply()))
    expect(err).toMatchObject({
      code: 'auth_required',
      message: expect.stringMatching(/Connect your Optiply account/),
    })
    expect(fake.requests).toHaveLength(0)
  })

  it('Test connection dry-runs as the person and says so', async () => {
    const { credentials } = account('optiply.ivy')
    expect(await testResource(connector, optiply(), { credentials })).toMatchObject({
      ok: true,
      message: 'BigQuery project optiply-workflows as your Optiply account',
    })
    expect(fake.apiCalls('dryRun').at(-1)!.authorization).toMatch(/^Bearer fed-/)
  })

  it("signs in only on Optiply's own Auth0 domains, over https", () => {
    const loginOf = (loginUrl: string) => {
      const http = httpConfigFor('bigquery', {
        projectId: 'p',
        auth: { type: 'optiply', clientId: 'c', loginUrl },
      })
      return http?.auth.type === 'oauth2AuthorizationCode' ? http.auth.authorizeUrl : null
    }
    expect(loginOf('https://optiply-staging.eu.auth0.com/')).toBe(
      'https://optiply-staging.eu.auth0.com/authorize',
    )
    expect(loginOf('https://optiply.eu.auth0.com')).toBe('https://optiply.eu.auth0.com/authorize')
    for (const bad of [
      'https://login-optiply.example/', // a look-alike
      'https://optiply-login.eu.auth0.com/', // someone else's Auth0 tenant
      'http://login.optiply.com/',
      'https://login.optiply.com:8443/',
      'https://user@login.optiply.com/',
      'mailto:x@login.optiply.com',
      'not a url',
    ]) {
      expect(loginOf(bad), bad).toBeNull()
    }
  })

  it("always exchanges at the data platform's pool: a pool in the settings is ignored", async () => {
    const { credentials } = account('optiply.kim')
    const res = optiply({
      auth: {
        type: 'optiply',
        clientId: 'spa-client',
        stsAudience:
          '//iam.googleapis.com/projects/evil/locations/global/workloadIdentityPools/p/providers/x',
      },
    })
    await query(res, credentials)
    expect(fake.stsCalls().map((r) => (r.body as Record<string, string>).audience)).toEqual([
      fake.stsAudience,
    ])
  })

  describe("the Tables panel: the data platform's table functions", () => {
    const setUp = () => {
      fake.routines.clear()
      fake.routines.set('webshop_product', {
        args: [{ name: 'shop', typeKind: 'STRING' }],
        fields: [
          { name: 'uuid', type: 'STRING', mode: 'REQUIRED' },
          { name: 'price', type: 'NUMERIC' },
          { name: 'tags', type: 'STRING', mode: 'REPEATED' },
          { name: 'meta', type: 'RECORD' },
          // The REST API's legacy names (as Google answered on 2026-11-26), shown as standard SQL's.
          { name: 'status', type: 'INTEGER' },
          { name: 'demand', type: 'FLOAT' },
          { name: 'assembled', type: 'BOOLEAN' },
        ],
      })
      // As live (2026-11-26): it takes the shop too, and declares what it returns (no dry run).
      fake.routines.set('data_freshness', {
        args: [{ name: 'shop', typeKind: 'STRING' }],
        declared: [
          { name: 'function_name', type: { typeKind: 'STRING' } },
          { name: 'loaded_at', type: { typeKind: 'TIMESTAMP' } },
          { name: 'sources', type: { typeKind: 'ARRAY', arrayElementType: { typeKind: 'STRING' } } },
        ],
      })
      fake.routines.set('product_slevel', {
        args: [{ name: 'shop', typeKind: 'STRING' }],
        dryRunError: 'Access Denied: Table optiply-data-platform:x.product_slevel',
      })
      fake.routines.set('shop_helper', { type: 'SCALAR_FUNCTION', args: [] })
      fake.routines.set('history_at', {
        args: [
          { name: 'shop', typeKind: 'STRING' },
          { name: 'at', typeKind: 'DATE' },
        ],
        fields: [{ name: 'id', type: 'INT64' }],
      })
    }

    it('lists each function with the columns it returns, inserted as its call, read as the person', async () => {
      setUp()
      const { credentials } = account('optiply.nina')
      const jobsBefore = fake.jobs.size
      const schema = await describeSqlSchema(pool, connector, optiply(), { credentials })
      expect(schema?.truncated).toBe(false)
      // Table functions only (not the scalar one), sorted, across the routine list's pages.
      expect(schema?.tables.map((t) => t.name)).toEqual([
        'data_freshness',
        'history_at',
        'product_slevel',
        'webshop_product',
      ])
      const byName = Object.fromEntries(schema!.tables.map((t) => [t.name, t]))
      expect(byName.webshop_product).toEqual({
        schema: 'optiply-data-platform.agent_api',
        name: 'webshop_product',
        insert: "`optiply-data-platform.agent_api.webshop_product`('<shop>')",
        columns: [
          { name: 'uuid', type: 'STRING', nullable: false },
          { name: 'price', type: 'NUMERIC', nullable: true },
          { name: 'tags', type: 'ARRAY<STRING>', nullable: true },
          { name: 'meta', type: 'STRUCT', nullable: true },
          { name: 'status', type: 'INT64', nullable: true },
          { name: 'demand', type: 'FLOAT64', nullable: true },
          { name: 'assembled', type: 'BOOL', nullable: true },
        ],
      })
      // A declared return type needs no dry run.
      expect(byName.data_freshness).toMatchObject({
        insert: "`optiply-data-platform.agent_api.data_freshness`('<shop>')",
        columns: [
          { name: 'function_name', type: 'STRING' },
          { name: 'loaded_at', type: 'TIMESTAMP' },
          { name: 'sources', type: 'ARRAY<STRING>' },
        ],
      })
      expect(byName.history_at!.insert).toBe("`optiply-data-platform.agent_api.history_at`('<shop>', <at>)")
      // One the platform refuses to plan is still listed, without columns.
      expect(byName.product_slevel).toMatchObject({
        columns: [],
        insert: "`optiply-data-platform.agent_api.product_slevel`('<shop>')", // its arguments kept
      })
      // Dry runs with typed NULLs, billed to the resource's project, as the person; no job was created.
      expect(fake.dryRuns).toContain(
        'SELECT * FROM `optiply-data-platform.agent_api.webshop_product`(CAST(NULL AS STRING))',
      )
      expect(fake.dryRuns).toContain(
        'SELECT * FROM `optiply-data-platform.agent_api.history_at`(CAST(NULL AS STRING), CAST(NULL AS DATE))',
      )
      expect(fake.dryRuns.some((q) => q.includes('data_freshness'))).toBe(false)
      expect(fake.jobs.size).toBe(jobsBefore)
      expect(fake.apiCalls().every((r) => r.authorization?.startsWith('Bearer fed-'))).toBe(true)
      expect(
        fake
          .apiCalls()
          .filter((r) => r.method === 'POST')
          .every((r) => r.path === '/bigquery/v2/projects/optiply-workflows/jobs'),
      ).toBe(true)
    })

    it('fails the whole list (so it isn’t kept) when a function fails for a reason that isn’t about it', async () => {
      for (const [refusal, code] of [
        [{ status: 503, reason: 'backendError', message: 'Backend error' }, 'query'],
        [{ status: 403, reason: 'rateLimitExceeded', message: 'Exceeded rate limits' }, 'query'],
      ] as const) {
        setUp()
        fake.routines.set('history_at', { args: [], getError: refusal })
        const { credentials } = account(`optiply.${refusal.reason}`)
        const err = await failure(describeSqlSchema(pool, connector, optiply(), { credentials }))
        expect(err.code, refusal.reason).toBe(code)
        expect(err.message, refusal.reason).toContain(refusal.message)
      }
      // A refused function itself (invalid, access denied, gone) is still listed without columns.
      setUp()
      fake.routines.set('history_at', {
        args: [],
        getError: { status: 404, reason: 'notFound', message: 'Not found: Routine' },
      })
      const { credentials } = account('optiply.pia')
      const schema = await describeSqlSchema(pool, connector, optiply(), { credentials })
      expect(schema?.tables.find((t) => t.name === 'history_at')).toMatchObject({ columns: [] })
    })

    it('asks to connect again when the sign-in lapses partway through the list', async () => {
      setUp()
      fake.routines.set('history_at', {
        args: [],
        getError: { status: 401, reason: 'authError', message: 'Invalid credentials' },
      })
      fake.allowOptiplyToken('optiply.quin')
      const lapsing: CredentialSource = {
        async accessToken({ force }) {
          if (force)
            throw new ConnectorError('auth_required', 'Connect your account to this resource to use it.')
          return 'optiply.quin'
        },
      }
      const err = await failure(describeSqlSchema(pool, connector, optiply(), { credentials: lapsing }))
      expect(err.code).toBe('auth_required')
    })

    it('stops at the row limit and says the list is cut short', async () => {
      setUp()
      const { credentials } = account('optiply.otto')
      const schema = await describeSqlSchema(pool, connector, optiply({ maxRows: 3 }), { credentials })
      expect(schema?.truncated).toBe(true)
      expect(schema?.tables.flatMap((t) => t.columns)).toHaveLength(2)
    })

    it('asks for a connected account, as a query does', async () => {
      setUp()
      const err = await failure(describeSqlSchema(pool, connector, optiply()))
      expect(err.code).toBe('auth_required')
    })
  })

  it('needs the project jobs run in', async () => {
    const { credentials } = account('optiply.jan')
    expect(await testResource(connector, optiply({ projectId: undefined }), { credentials })).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', details: { issues: [{ path: 'projectId' }] } },
    })
  })

  it("gives the server's OAuth sign-in Optiply's Auth0 endpoints, the API audience and each person's own account", () => {
    const http = httpConfigFor('bigquery', {
      projectId: 'p',
      auth: { type: 'optiply', clientId: 'spa-client', loginUrl: 'https://login.optiply.com/some/path' },
    })
    expect(http).toMatchObject({
      baseUrl: 'https://sts.googleapis.com/',
      allowedHosts: [],
      auth: {
        type: 'oauth2AuthorizationCode',
        provider: 'custom',
        authorizeUrl: 'https://login.optiply.com/authorize',
        tokenUrl: 'https://login.optiply.com/oauth/token',
        revokeUrl: 'https://login.optiply.com/oauth/revoke',
        clientId: 'spa-client',
        scope: 'openid email offline_access',
        authorizeParams: [{ key: 'audience', value: 'https://api.optiply.com/internal' }],
        clientAuth: 'none',
        pkce: true,
        tokens: 'perUser',
      },
    })
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
      'SELECT * FROM shop.orders WHERE (CAST(`day` AS DATE) >= CAST(@p1 AS DATE)) AND (STRPOS(LOWER(CAST(`name` AS STRING)), LOWER(@p2)) > 0) AND n > @p3',
    )
    expect(query.queryParameters.map((p: { name: string }) => p.name)).toEqual(['p1', 'p2', 'p3'])
    expect(query.queryParameters[0].parameterValue).toEqual({ value: '2026-01-01' })
  })
})
