import { randomUUID } from 'node:crypto'
import { compileSql, paramValue, TemplateError } from '@ow/expressions'
import { Agent, fetch } from 'undici'
import { z } from 'zod'
import {
  GOOGLE_TOKEN_URL,
  type GoogleTokens,
  isServiceAccountKey,
  parseServiceAccountKey,
  type ServiceAccountKey,
  serviceAccountTokens,
} from './google-auth'
import { networkError, readBody } from './http'
import { resolveFragments } from './sql-fragments'
import {
  type Connector,
  ConnectorError,
  type QueryContext,
  type QueryResult,
  statementTimeoutMs,
} from './types'

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
  maxRows: z.number().int().positive().default(1_000_000),
  statementTimeoutMs: z.number().int().positive().default(120_000),
  /** Added to every job, for cost attribution (alongside the workflow, run and environment). */
  labels: z.record(labelKey, labelValue).default({}),
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

interface Client {
  config: Config
  key: ServiceAccountKey
  projectId: string
  agent: Agent
  endpoints: BigQueryEndpoints
  tokens: GoogleTokens
}

export interface BigQueryEndpoints {
  /** The BigQuery v2 REST API. */
  apiUrl: string
  /** Google's OAuth token endpoint (the key's own `token_uri` is ignored, so a key can't send tokens elsewhere). */
  tokenUrl: string
}

const GOOGLE: BigQueryEndpoints = {
  apiUrl: 'https://bigquery.googleapis.com/bigquery/v2',
  tokenUrl: GOOGLE_TOKEN_URL,
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

    // The default dataset's columns, else the whole region's (the resource's location). A small catalog read, billed
    // to the resource's project like any query. Without either it can't know where to look (a guessed region would
    // just show no tables).
    schemaSql: (config, limit) => {
      if (!config.defaultDataset && !config.location) {
        throw new ConnectorError(
          'invalid_config',
          "Set the resource's location (e.g. EU) or a default dataset to list its tables",
        )
      }
      const from = config.defaultDataset
        ? `\`${config.defaultDataset}\`.INFORMATION_SCHEMA.COLUMNS`
        : `\`region-${config.location!.toLowerCase()}\`.INFORMATION_SCHEMA.COLUMNS`
      return `SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS d, is_nullable AS n
FROM ${from}
ORDER BY table_schema, table_name, ordinal_position
LIMIT ${limit}`
    },

    createClient({ config, secrets }) {
      const key = parseServiceAccountKey(secrets.serviceAccountKey, 'serviceAccountKey')
      const agent = new Agent({ connections: 16 })
      return {
        config,
        key,
        projectId: config.projectId ?? key.project_id,
        agent,
        endpoints,
        tokens: serviceAccountTokens(key, {
          scope: SCOPE,
          field: 'serviceAccountKey',
          tokenUrl: endpoints.tokenUrl,
          dispatcher: agent,
        }),
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
    queryParameters.push({ name: `p${i + 1}`, ...toQueryParameter(await paramValue(param, ctx.evaluate)) })
  }

  const statementTimeout = AbortSignal.timeout(statementTimeoutMs(ctx, config.statementTimeoutMs))
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
  const token = await client.tokens.token(signal, retried)
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
