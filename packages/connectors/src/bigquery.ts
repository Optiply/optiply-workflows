import { createSign, randomUUID } from 'node:crypto'
import { compileSql, TemplateError } from '@ow/expressions'
import { Agent, fetch } from 'undici'
import { z } from 'zod'
import { networkError, readBody } from './http'
import { resolveFragments } from './sql-fragments'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from './types'

/** Label keys and values: lowercase letters, digits, `_` and `-`, at most 63 characters; keys start with a letter. */
const labelKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/, 'Lowercase letters, digits, _ and -; start with a letter')
const labelValue = z.string().regex(/^[a-z0-9_-]{0,63}$/, 'Lowercase letters, digits, _ and -')

const configSchema = z.object({
  /** The project jobs run (and are billed) in. Defaults to the service account's project. */
  projectId: z.string().min(1).optional(),
  /** Where jobs run, e.g. `EU` or `europe-west4`; BigQuery infers it from the tables when left out. */
  location: z.string().min(1).optional(),
  /** `dataset` or `project.dataset`, for table names written without one. */
  defaultDataset: z
    .string()
    .regex(/^([a-z][a-z0-9.:-]*\.)?[A-Za-z0-9_]+$/, 'Write it as dataset or project.dataset')
    .optional(),
  /** A query that would bill more fails before it runs. Default 10 GiB. */
  maximumBytesBilled: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 ** 3),
  /** Queries returning more rows than this fail rather than load everything into memory. */
  maxRows: z.number().int().positive().default(10_000),
  statementTimeoutMs: z.number().int().positive().default(120_000),
  /** Added to every job, for cost attribution (alongside the workflow, run and environment). */
  labels: z.record(labelKey, labelValue).default({}),
})

const keySchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
})

const secretsSchema = z.object({
  /** The service account's JSON key file, as text; checked on save (errors name the field, never the content). */
  serviceAccountKey: z
    .string()
    .min(1)
    .refine(isServiceAccountKey, 'Paste the JSON key file of a service account'),
})

const querySchema = z.object({ sql: z.string().min(1) })

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>
type Key = z.output<typeof keySchema>

interface Client {
  config: Config
  key: Key
  projectId: string
  agent: Agent
  endpoints: BigQueryEndpoints
  token?: Promise<{ value: string; expiresAt: number }>
}

export interface BigQueryEndpoints {
  /** The BigQuery v2 REST API. */
  apiUrl: string
  /** Google's OAuth token endpoint (the key's own `token_uri` is ignored, so a key can't send tokens elsewhere). */
  tokenUrl: string
}

const GOOGLE: BigQueryEndpoints = {
  apiUrl: 'https://bigquery.googleapis.com/bigquery/v2',
  tokenUrl: 'https://oauth2.googleapis.com/token',
}
const SCOPE = 'https://www.googleapis.com/auth/bigquery'
/** How long one API call may wait for a job before we poll again. */
const POLL_MS = 10_000
const PAGE_ROWS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/**
 * BigQuery over its REST API: a service account signs a JWT for an access token, queries run as jobs with named
 * parameters (`@p1`, `@p2`, … from `{{ }}`), a `maximumBytesBilled` limit and labels, and results are paged in.
 * Cancelling or timing out cancels the job. `endpoints` exists for tests (a fake API).
 */
export function createBigQueryConnector(
  endpoints: BigQueryEndpoints = GOOGLE,
): Connector<Config, Secrets, Query, Client> {
  return {
    type: 'bigquery',
    label: 'BigQuery',
    configSchema,
    secretsSchema,
    querySchema,

    createClient({ config, secrets }) {
      const key = parseKey(secrets.serviceAccountKey)
      return {
        config,
        key,
        projectId: config.projectId ?? key.project_id,
        agent: new Agent({ connections: 16 }),
        endpoints,
      }
    },

    async destroyClient({ agent }) {
      await agent.close()
    },

    async testConnection(client, { signal }) {
      // A dry run is free and checks the credentials, the project and the permission to run jobs.
      await api(client, 'POST', `/projects/${enc(client.projectId)}/queries`, signal, {
        query: 'SELECT 1',
        useLegacySql: false,
        dryRun: true,
        ...(client.config.location && { location: client.config.location }),
      })
      return { message: `BigQuery project ${client.projectId} as ${client.key.client_email}` }
    },

    validateQuery(query) {
      try {
        compileSql(query.sql, 'bigquery')
        return []
      } catch (err) {
        if (err instanceof TemplateError) return [err]
        throw err
      }
    },

    execute(client, query, ctx) {
      return executeQuery(client, query, ctx)
    },
  }
}

export const bigqueryConnector = createBigQueryConnector()

function isServiceAccountKey(text: string): boolean {
  try {
    return keySchema.safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}

function parseKey(text: string): Key {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Never quote the text: it's a private key.
    throw new ConnectorError('invalid_config', "The service account key isn't valid JSON", {
      issues: [{ path: 'serviceAccountKey' }],
    })
  }
  const key = keySchema.safeParse(json)
  if (!key.success) {
    throw new ConnectorError('invalid_config', 'The service account key is missing fields', {
      issues: key.error.issues.map((i) => ({ path: ['serviceAccountKey', ...i.path].join('.') })),
    })
  }
  return key.data
}

interface JobReference {
  projectId: string
  jobId: string
  location?: string
}

interface GoogleError {
  reason?: string
  location?: string
  message?: string
}

interface InsertResponse {
  jobReference?: JobReference
  status?: { state?: string; errorResult?: GoogleError }
}

interface JobResponse {
  jobReference?: JobReference
  jobComplete?: boolean
  schema?: { fields?: Field[] }
  rows?: { f: { v: unknown }[] }[]
  totalRows?: string
  pageToken?: string
  totalBytesProcessed?: string
  cacheHit?: boolean
  numDmlAffectedRows?: string
  dmlStats?: Record<string, string>
}

interface Field {
  name: string
  type: string
  mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED'
  fields?: Field[]
}

async function executeQuery(client: Client, query: Query, ctx: QueryContext): Promise<QueryResult> {
  const { config } = client
  const plan = await resolveFragments(compileSql(query.sql, 'bigquery'), 'bigquery', ctx.evaluate)
  const queryParameters: unknown[] = []
  for (const [i, param] of plan.params.entries()) {
    queryParameters.push({ name: `p${i + 1}`, ...toQueryParameter(await ctx.evaluate(param.code)) })
  }

  const statementTimeout = AbortSignal.timeout(Math.min(ctx.timeoutMs, config.statementTimeoutMs))
  const signal = AbortSignal.any([ctx.signal, statementTimeout])
  const project = enc(client.projectId)

  // Our own job id, so a cancel always knows which job to stop (even one still being created), and a retried
  // insert can't start a second job.
  let job: JobReference = {
    projectId: client.projectId,
    jobId: `ow_${randomUUID().replaceAll('-', '')}`,
    ...(config.location && { location: config.location }),
  }

  try {
    const inserted = await api<InsertResponse>(client, 'POST', `/projects/${project}/jobs`, signal, {
      jobReference: job,
      configuration: {
        query: {
          query: plan.text,
          useLegacySql: false,
          parameterMode: 'NAMED',
          queryParameters,
          maximumBytesBilled: String(config.maximumBytesBilled),
          ...(config.defaultDataset && {
            defaultDataset: datasetReference(config.defaultDataset, client.projectId),
          }),
        },
        labels: jobLabels(config.labels, ctx.labels),
      },
    })
    job = inserted.jobReference ?? job
    if (inserted.status?.errorResult) throw googleError(400, inserted.status.errorResult)
    const results = (pageToken?: string) => {
      const params = new URLSearchParams({
        maxResults: String(Math.min(PAGE_ROWS, config.maxRows + 1)),
        timeoutMs: String(POLL_MS),
        'formatOptions.useInt64Timestamp': 'true',
      })
      if (job.location) params.set('location', job.location)
      if (pageToken) params.set('pageToken', pageToken)
      return api<JobResponse>(
        client,
        'GET',
        `/projects/${project}/queries/${enc(job.jobId)}?${params}`,
        signal,
      )
    }
    let res = await results()
    while (!res.jobComplete) {
      // BigQuery holds an unfinished poll for up to POLL_MS; if one comes back early anyway, don't spin.
      const started = Date.now()
      res = await results()
      if (!res.jobComplete && Date.now() - started < 1000) await sleep(250, signal)
    }

    const meta = {
      jobId: job.jobId,
      location: res.jobReference?.location ?? job.location,
      totalBytesProcessed: Number(res.totalBytesProcessed ?? 0),
      cacheHit: res.cacheHit ?? false,
    }
    // DML (and DDL) have no rows; a script's result is its last statement's.
    if (res.numDmlAffectedRows !== undefined && !res.schema?.fields?.length) {
      const affected = Number(res.numDmlAffectedRows)
      return { data: [], metadata: { rowCount: affected, affectedRows: affected, fields: [], ...meta } }
    }
    const fields = res.schema?.fields ?? []
    const total = Number(res.totalRows ?? 0)
    if (total > config.maxRows) {
      throw new ConnectorError(
        'too_large',
        `The query returned ${total} rows, more than ${config.maxRows}. Add a LIMIT or raise the resource's maxRows.`,
      )
    }
    const rows = (res.rows ?? []).map((row) => toRow(row.f, fields))
    while (res.pageToken && rows.length < total) {
      res = await results(res.pageToken)
      for (const row of res.rows ?? []) rows.push(toRow(row.f, fields))
    }
    return {
      data: rows,
      metadata: {
        rowCount: rows.length,
        fields: fields.map((f) => ({ name: f.name, type: f.type, mode: f.mode ?? 'NULLABLE' })),
        ...meta,
      },
    }
  } catch (err) {
    if (signal.aborted) void cancelJob(client, job)
    if (statementTimeout.aborted && !ctx.signal.aborted) {
      throw new ConnectorError('timeout', 'The query hit the statement timeout')
    }
    throw err
  }
}

/** Best effort: the job keeps running (and billing) on BigQuery's side unless it's cancelled. */
async function cancelJob(client: Client, job: JobReference): Promise<void> {
  const location = job.location ? `?location=${enc(job.location)}` : ''
  await api(
    client,
    'POST',
    `/projects/${enc(job.projectId)}/jobs/${enc(job.jobId)}/cancel${location}`,
    AbortSignal.timeout(10_000),
  ).catch(() => {})
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function enc(segment: string): string {
  return encodeURIComponent(segment)
}

function datasetReference(defaultDataset: string, projectId: string) {
  const dot = defaultDataset.lastIndexOf('.')
  return dot === -1
    ? { projectId, datasetId: defaultDataset }
    : { projectId: defaultDataset.slice(0, dot), datasetId: defaultDataset.slice(dot + 1) }
}

/** The resource's labels plus who ran the query, made valid (BigQuery refuses the job over a bad label). */
function jobLabels(
  config: Record<string, string>,
  ctx: Record<string, string> | undefined,
): Record<string, string> {
  const labels: Record<string, string> = { ...config }
  for (const [key, value] of Object.entries(ctx ?? {})) {
    const k = labelPart(key)
    if (/^[a-z]/.test(k)) labels[k] = labelPart(value)
  }
  return labels
}

function labelPart(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 63)
}

/**
 * A `{{ }}` value as a typed BigQuery parameter. Arrays become ARRAYs (`IN UNNEST(@p1)`) typed by their first
 * item; objects are sent as JSON text (`PARSE_JSON(@p1)`), dates as TIMESTAMPs. BigQuery has no untyped NULL, so
 * null is a NULL STRING.
 */
export function toQueryParameter(value: unknown): {
  parameterType: Record<string, unknown>
  parameterValue: Record<string, unknown>
} {
  if (Array.isArray(value)) {
    const items = value.filter((v) => v !== null && v !== undefined)
    const type = items.some((v) => typeof v === 'number' && !Number.isInteger(v))
      ? 'FLOAT64'
      : scalarType(items[0])
    return {
      parameterType: { type: 'ARRAY', arrayType: { type } },
      parameterValue: { arrayValues: value.map((v) => ({ value: scalarValue(v) })) },
    }
  }
  if (value === null || value === undefined) return { parameterType: { type: 'STRING' }, parameterValue: {} }
  return { parameterType: { type: scalarType(value) }, parameterValue: { value: scalarValue(value) } }
}

function scalarType(value: unknown): string {
  if (typeof value === 'boolean') return 'BOOL'
  if (typeof value === 'bigint') return 'INT64'
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'INT64' : 'FLOAT64'
  if (value instanceof Date) return 'TIMESTAMP'
  return 'STRING'
}

function scalarValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A REST row (`{ f: [{ v }] }`, every value a string) as a plain object, typed by the schema. */
function toRow(cells: { v: unknown }[], fields: Field[]): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [i, field] of fields.entries()) row[field.name] = toValue(cells[i]?.v, field)
  return row
}

function toValue(v: unknown, field: Field): unknown {
  if (v === null || v === undefined) return field.mode === 'REPEATED' ? [] : null
  if (field.mode === 'REPEATED') {
    return (v as { v: unknown }[]).map((item) => toValue(item.v, { ...field, mode: 'NULLABLE' }))
  }
  switch (field.type) {
    case 'RECORD':
    case 'STRUCT':
      return toRow((v as { f: { v: unknown }[] }).f, field.fields ?? [])
    case 'INTEGER':
    case 'INT64': {
      // Past 2^53 a string, rather than a rounded number.
      const n = Number(v)
      return Number.isSafeInteger(n) ? n : String(v)
    }
    case 'FLOAT':
    case 'FLOAT64': {
      // NaN and ±Infinity have no JSON form; keep BigQuery's text.
      const n = Number(v)
      return Number.isFinite(n) ? n : String(v)
    }
    case 'BOOLEAN':
    case 'BOOL':
      return v === 'true'
    case 'TIMESTAMP':
      // Microseconds since the epoch (formatOptions.useInt64Timestamp), as an ISO instant.
      return new Date(Number(BigInt(String(v)) / 1000n)).toISOString()
    case 'JSON':
      return JSON.parse(String(v))
    default:
      // STRING, BYTES (base64), NUMERIC and BIGNUMERIC (exact, so strings), DATE, TIME, DATETIME, GEOGRAPHY (WKT),
      // INTERVAL, RANGE: BigQuery's text.
      return v
  }
}

/** One call to the API with the service account's token; a 401 refreshes the token once. */
async function api<T = unknown>(
  client: Client,
  method: 'GET' | 'POST',
  path: string,
  signal: AbortSignal,
  body?: unknown,
  retried = false,
): Promise<T> {
  const url = new URL(client.endpoints.apiUrl + path)
  const token = await accessToken(client, signal, retried)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      dispatcher: client.agent,
    })
  } catch (err) {
    throw networkError(err, url)
  }
  if (res.status === 401 && !retried) {
    await res.body?.cancel()
    return api<T>(client, method, path, signal, body, true)
  }
  const text = (await readBody(res, MAX_RESPONSE_BYTES)).toString('utf8')
  if (!res.ok) throw apiError(res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

/** A cached access token from a signed JWT (RFC 7523), refreshed a minute before it expires. */
async function accessToken(client: Client, signal: AbortSignal, force: boolean): Promise<string> {
  const cached = force ? undefined : await client.token?.catch(() => undefined)
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value
  const fresh = fetchToken(client, signal)
  client.token = fresh
  return (await fresh).value
}

async function fetchToken(
  client: Client,
  signal: AbortSignal,
): Promise<{ value: string; expiresAt: number }> {
  const { tokenUrl } = client.endpoints
  const now = Math.floor(Date.now() / 1000)
  const b64 = (json: object) => Buffer.from(JSON.stringify(json)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: client.key.client_email,
    scope: SCOPE,
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  })}`
  let signature: string
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(client.key.private_key, 'base64url')
  } catch {
    throw new ConnectorError('invalid_config', "The service account key's private key can't sign", {
      issues: [{ path: 'serviceAccountKey.private_key' }],
    })
  }
  const url = new URL(tokenUrl)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      signal,
      dispatcher: client.agent,
    })
  } catch (err) {
    throw networkError(err, url)
  }
  const text = (await readBody(res, 1024 * 1024)).toString('utf8')
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
  try {
    json = JSON.parse(text)
  } catch {
    // Reported below.
  }
  if (!res.ok || !json.access_token) {
    throw new ConnectorError(
      'connection',
      `Google refused the service account key: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
      { status: res.status, error: json.error },
    )
  }
  return { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 }
}

/** Google's error body: `{ error: { code, message, status, errors: [{ reason, location, message }] } }`. */
function apiError(status: number, text: string): ConnectorError {
  let error: { message?: string; errors?: GoogleError[] } = {}
  try {
    error = (JSON.parse(text) as { error?: typeof error }).error ?? {}
  } catch {
    // Not JSON (a proxy's error page): report the status.
  }
  return googleError(status, { ...error.errors?.[0], message: error.message ?? error.errors?.[0]?.message })
}

/** An API error or a failed job's `errorResult`, e.g. `invalidQuery`, `bytesBilledLimitExceeded`, `accessDenied`. */
function googleError(status: number, error: GoogleError): ConnectorError {
  const message = error.message ?? `BigQuery answered HTTP ${status}`
  const details = { status, reason: error.reason, location: error.location }
  if (error.reason === 'bytesBilledLimitExceeded') {
    return new ConnectorError(
      'query',
      `The query would bill more than the resource's maximum bytes billed. ${message}`,
      details,
    )
  }
  return new ConnectorError(status === 401 ? 'connection' : 'query', message, details)
}
