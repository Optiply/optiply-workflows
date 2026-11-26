import { createHash, randomUUID } from 'node:crypto'
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
import { oauthPresets } from './oauth-presets'
import { type RestConfig, restConfigSchema } from './rest'
import { resolveFragments } from './sql-fragments'
import {
  type Connector,
  ConnectorError,
  type CredentialSource,
  type QueryContext,
  type QueryResult,
  statementTimeoutMs,
} from './types'

/** Label keys and values: lowercase letters, digits, `_` and `-`, at most 63 characters; keys start with a letter. */
const labelKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/, 'Lowercase letters, digits, _ and -; start with a letter')
const labelValue = z.string().regex(/^[a-z0-9_-]{0,63}$/, 'Lowercase letters, digits, _ and -')

const SCOPE = 'https://www.googleapis.com/auth/bigquery'

/**
 * The Optiply data platform's workload identity pool: Google STS takes a person's Optiply (Auth0) access token here
 * and gives back a Google token of that same person, which the data platform's `agent_api` table functions check
 * shop membership against.
 */
export const OPTIPLY_DATA_PLATFORM_POOL =
  '//iam.googleapis.com/projects/429012531216/locations/global/workloadIdentityPools/data-platform-users/providers/auth0'

/** Optiply's Auth0 sign-in domains: production, production by its Auth0 name, staging. */
export const OPTIPLY_LOGIN_URLS = [
  'https://login.optiply.com/',
  'https://optiply.eu.auth0.com/',
  'https://optiply-staging.eu.auth0.com/',
] as const

function isOptiplyLogin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      OPTIPLY_LOGIN_URLS.some((allowed) => new URL(allowed).host === url.host)
    )
  } catch {
    return false
  }
}

const configSchema = z.object({
  /**
   * How it signs in: a service account key (the default, as before), a Google account through OAuth sign-in (M9):
   * one shared account per environment, or each person's own, so queries run with that person's BigQuery access; or
   * each person's own Optiply account, exchanged at Google STS for a Google token through workload identity
   * federation (the Optiply data platform: queries see only the webshops that person is a member of).
   */
  auth: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('serviceAccount') }),
      z.object({
        type: z.literal('oauth'),
        clientId: z.string().trim().min(1),
        scope: z.string().default(`openid email ${SCOPE}`),
        tokens: z.enum(['shared', 'perUser']).default('shared'),
      }),
      z.object({
        type: z.literal('optiply'),
        /** The Auth0 application people sign in with (its Allowed Callback URLs must hold this server's). */
        clientId: z.string().trim().min(1),
        /**
         * Optiply's Auth0 sign-in domain: one of Optiply's own (production, the same tenant by its Auth0 name, or
         * staging), so nobody with Edit can send people to a look-alike sign-in page. Only its origin is used.
         */
        loginUrl: z
          .string()
          .default(OPTIPLY_LOGIN_URLS[0])
          .refine(isOptiplyLogin, `Use one of Optiply's sign-in domains: ${OPTIPLY_LOGIN_URLS.join(', ')}`),
        /** The API the Optiply token is for; the identity pool accepts this one. */
        audience: z.string().trim().min(1).default('https://api.optiply.com/internal'),
        scope: z.string().default('openid email offline_access'),
        // The identity pool isn't a setting: it's the data platform's, fixed (endpoints.stsAudience), so nobody with
        // Edit can send people's Optiply tokens to be exchanged in a pool of their own.
      }),
    ])
    .default({ type: 'serviceAccount' }),
  /** The project jobs run (and are billed) in. Defaults to the service account's project; needed with OAuth. */
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
    .refine(isServiceAccountKey, 'Paste the JSON key file of a service account')
    .optional(),
  /** OAuth: the Google OAuth client's secret. */
  clientSecret: z.string().optional(),
})

const querySchema = z.object({ sql: z.string().min(1) })

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

interface Client {
  config: Config
  projectId: string
  agent: Agent
  endpoints: BigQueryEndpoints
  /** The service account's tokens; null with OAuth, whose token comes with each query (`ctx.credentials`). */
  tokens: GoogleTokens | null
  /** Who it signs in as, for Test connection: the key's email (null with OAuth). */
  key: ServiceAccountKey | null
  /** Optiply sign-in: Google tokens from STS, by a hash of the Optiply token they came from. */
  federated: Map<string, { token: string; expiresAt: number }>
  /** Optiply sign-in: exchanges under way, by the same key, so simultaneous queries share one. */
  exchanging: Map<string, Promise<string>>
}

/** An access token for one API call; `force` gets a fresh one (the API refused the last). */
type TokenSource = (signal: AbortSignal, force: boolean) => Promise<string>

export interface BigQueryEndpoints {
  /** The BigQuery v2 REST API. */
  apiUrl: string
  /** Google's OAuth token endpoint (the key's own `token_uri` is ignored, so a key can't send tokens elsewhere). */
  tokenUrl: string
  /** Google's Security Token Service, where Optiply sign-in exchanges the Optiply token (the only place it goes). */
  stsUrl: string
  /** The workload identity pool provider STS exchanges it at: the data platform's. */
  stsAudience: string
}

const GOOGLE: BigQueryEndpoints = {
  apiUrl: 'https://bigquery.googleapis.com/bigquery/v2',
  tokenUrl: GOOGLE_TOKEN_URL,
  stsUrl: 'https://sts.googleapis.com/v1/token',
  stsAudience: OPTIPLY_DATA_PLATFORM_POOL,
}
/** How long one API call may wait for a job before we poll again. */
const POLL_MS = 10_000
const PAGE_ROWS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/**
 * BigQuery over its REST API: a service account signs a JWT for an access token (or, with OAuth, the connected Google
 * account's token comes with each query), queries run as jobs with named parameters (`@p1`, `@p2`, … from `{{ }}`), a
 * `maximumBytesBilled` limit and labels, and results are paged in. Cancelling or timing out cancels the job.
 * `endpoints` exists for tests (a fake API).
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
      if (config.auth.type !== 'serviceAccount') {
        if (!config.projectId) {
          throw new ConnectorError(
            'invalid_config',
            'Set the project queries run in (with OAuth sign-in there is no key to take it from)',
            { issues: [{ path: 'projectId', message: 'Required with OAuth sign-in' }] },
          )
        }
        return {
          config,
          projectId: config.projectId,
          agent: new Agent({ connections: 16 }),
          endpoints,
          tokens: null,
          key: null,
          federated: new Map(),
          exchanging: new Map(),
        }
      }
      if (!secrets.serviceAccountKey) {
        throw new ConnectorError('invalid_config', 'Add the service account key (serviceAccountKey)', {
          issues: [{ path: 'serviceAccountKey', message: 'Required' }],
        })
      }
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
        federated: new Map(),
        exchanging: new Map(),
      }
    },

    async destroyClient({ agent }) {
      await agent.close()
    },

    // OAuth sign-in (M9) works from these: Google's endpoints, the BigQuery scope, tokens only for BigQuery's host.
    httpConfig: (config) => bigQueryHttpConfig(config, endpoints),

    async testConnection(client, { signal, credentials }) {
      // A dry run is free and checks the credentials, the project and the permission to run jobs.
      await api(
        client,
        tokenSource(client, credentials),
        'POST',
        `/projects/${enc(client.projectId)}/queries`,
        signal,
        {
          query: 'SELECT 1',
          useLegacySql: false,
          dryRun: true,
          ...(client.config.location && { location: client.config.location }),
        },
      )
      const who = client.key
        ? client.key.client_email
        : client.config.auth.type === 'optiply'
          ? 'your Optiply account'
          : client.config.auth.type === 'oauth' && client.config.auth.tokens === 'perUser'
            ? 'your Google account'
            : 'the connected Google account'
      return { message: `BigQuery project ${client.projectId} as ${who}` }
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

/** The REST-shaped settings the server's OAuth sign-in works from; no OAuth for a service account. */
function bigQueryHttpConfig(config: Config, endpoints: BigQueryEndpoints): RestConfig {
  const { auth } = config
  if (auth.type === 'optiply') {
    // Each person signs in to Optiply (Auth0, PKCE); the token goes only to Google STS (the base URL's origin, so
    // pointing the resource elsewhere asks everyone to connect again).
    const login = new URL(auth.loginUrl).origin
    return restConfigSchema.parse({
      baseUrl: `${new URL(endpoints.stsUrl).origin}/`,
      allowedHosts: [],
      auth: {
        type: 'oauth2AuthorizationCode',
        provider: 'custom',
        authorizeUrl: `${login}/authorize`,
        tokenUrl: `${login}/oauth/token`,
        revokeUrl: `${login}/oauth/revoke`,
        clientId: auth.clientId,
        scope: auth.scope,
        authorizeParams: [{ key: 'audience', value: auth.audience }],
        // A public Auth0 app: no secret is ever sent, not even one stored from a Google OAuth sign-in before.
        clientAuth: 'none',
        pkce: true,
        tokens: 'perUser',
      },
    })
  }
  const google = oauthPresets.google
  return restConfigSchema.parse({
    baseUrl: `${new URL(endpoints.apiUrl).origin}/`,
    allowedHosts: [],
    auth:
      config.auth.type === 'oauth'
        ? {
            type: 'oauth2AuthorizationCode',
            provider: 'google',
            authorizeUrl: google.authorizeUrl,
            tokenUrl: google.tokenUrl,
            revokeUrl: google.revokeUrl,
            clientId: config.auth.clientId,
            scope: config.auth.scope,
            authorizeParams: google.authorizeParams,
            clientAuth: google.clientAuth,
            pkce: google.pkce,
            tokens: config.auth.tokens,
          }
        : { type: 'none' },
  })
}

/**
 * Where a call's token comes from: the service account's, the query's connected Google account, or (Optiply sign-in)
 * a Google token STS exchanged the person's connected Optiply token for.
 */
function tokenSource(client: Client, credentials: CredentialSource | undefined): TokenSource {
  const { tokens, config } = client
  if (tokens) return (signal, force) => tokens.token(signal, force)
  const optiply = config.auth.type === 'optiply'
  return async (signal, force) => {
    if (!credentials?.accessToken) {
      throw new ConnectorError(
        'auth_required',
        optiply
          ? 'Connect your Optiply account to this resource first'
          : 'Connect a Google account to this resource first',
      )
    }
    const accessToken = credentials.accessToken
    if (!optiply) return accessToken({ signal, force })
    return federatedToken(client, (fresh, s) => accessToken({ signal: s, force: fresh }), signal, force)
  }
}

/** Re-exchange this long before the Google token (or the Optiply token it came from) expires. */
const FEDERATED_SKEW_MS = 60_000
const FEDERATED_CACHE_MAX = 512
/** How long a shared exchange (STS, and a fresh Optiply token if one is needed) may take. */
const EXCHANGE_TIMEOUT_MS = 30_000

/**
 * A Google token for the person behind the connected Optiply token, from Google STS (RFC 8693 token exchange),
 * cached per Optiply token. `force` (BigQuery refused the last one) asks for a fresh Optiply token and exchanges it
 * again. STS refusing the token itself (`invalid_grant`) gets one fresh Optiply token and one more try. Simultaneous
 * calls for the same Optiply token share one exchange.
 */
async function federatedToken(
  client: Client,
  optiplyToken: (fresh: boolean, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  force: boolean,
): Promise<string> {
  const { stsAudience } = client.endpoints
  const keyOf = (token: string) => createHash('sha256').update(`${stsAudience}\0${token}`).digest('hex')
  const subject = await optiplyToken(force, signal)
  const key = keyOf(subject)
  const hit = client.federated.get(key)
  if (!force && hit && hit.expiresAt - FEDERATED_SKEW_MS > Date.now()) return hit.token

  // Simultaneous queries of the same person (an app page loading) share one exchange. It runs on a timeout of its
  // own, not the first query's signal: cancelling that query mustn't fail the others; each waits with its own signal.
  let shared = client.exchanging.get(key)
  if (!shared) {
    shared = exchange(client, keyOf, subject, optiplyToken, force).finally(() =>
      client.exchanging.delete(key),
    )
    client.exchanging.set(key, shared)
  }
  return untilAborted(shared, signal)
}

/** The exchange `federatedToken` shares: STS, one fresh Optiply token if STS refused the token, then the cache. */
async function exchange(
  client: Client,
  keyOf: (token: string) => string,
  subject: string,
  optiplyToken: (fresh: boolean, signal: AbortSignal) => Promise<string>,
  force: boolean,
): Promise<string> {
  const { stsAudience } = client.endpoints
  const signal = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
  let exchanged = await exchangeAtSts(client, stsAudience, subject, signal)
  let source = subject
  // Only a refused token is worth a fresh one; a refresh can't fix a wrong app, a busy STS or an outage, and each one
  // spends the person's refresh token at Auth0.
  if (exchanged.refused !== null && exchanged.error === 'invalid_grant' && !force) {
    source = await optiplyToken(true, signal)
    exchanged = await exchangeAtSts(client, stsAudience, source, signal)
  }
  if (exchanged.refused !== null) throw stsError(exchanged)
  const expiresAt = Math.min(
    Date.now() + exchanged.expiresIn * 1000,
    jwtExpiry(source) ?? Number.POSITIVE_INFINITY,
  )
  if (client.federated.size >= FEDERATED_CACHE_MAX) {
    for (const [k, v] of client.federated) if (v.expiresAt <= Date.now()) client.federated.delete(k)
    if (client.federated.size >= FEDERATED_CACHE_MAX) client.federated.clear()
  }
  client.federated.set(keyOf(source), { token: exchanged.token, expiresAt })
  return exchanged.token
}

/** `promise`, or the signal's abort reason as soon as it aborts (the promise itself goes on for the others). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

type StsResult =
  | { refused: null; token: string; expiresIn: number }
  | {
      refused: string
      status: number
      /** The OAuth error code (`invalid_grant`, `invalid_target`, …), when Google sent one. */
      error: string | undefined
      token?: undefined
      expiresIn?: undefined
    }

/** Why the exchange failed, worded by what the person can do about it. */
function stsError(failed: Extract<StsResult, { refused: string }>): ConnectorError {
  const details = { status: failed.status, error: failed.error }
  if (failed.status === 429 || failed.status >= 500) {
    return new ConnectorError(
      'connection',
      `Google's token service couldn't exchange your Optiply sign-in right now (${failed.refused}). Try again shortly.`,
      details,
    )
  }
  if (failed.error === 'invalid_grant') {
    return new ConnectorError(
      'connection',
      `Google refused your Optiply sign-in for data platform access (${failed.refused}). Connect your account again.`,
      details,
    )
  }
  return new ConnectorError(
    'connection',
    `Google refused to exchange your Optiply sign-in for data platform access (${failed.refused}). ` +
      "Check the resource's Optiply app and audience: the data platform's identity pool may not accept them.",
    details,
  )
}

/** One token exchange at Google STS. A refusal comes back (never with the response body quoted whole: it can echo the token). */
async function exchangeAtSts(
  client: Client,
  audience: string,
  subjectToken: string,
  signal: AbortSignal,
): Promise<StsResult> {
  const url = new URL(client.endpoints.stsUrl)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      }).toString(),
      signal,
      dispatcher: client.agent,
    })
  } catch (err) {
    throw networkError(err, url)
  }
  const text = (await readBody(res, 64 * 1024)).toString('utf8')
  let body: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } =
    {}
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON (a proxy's error page): reported by status below.
  }
  if (res.ok && typeof body.access_token === 'string' && body.access_token) {
    const expiresIn = Number(body.expires_in)
    return {
      refused: null,
      token: body.access_token,
      expiresIn: Number.isFinite(expiresIn) ? expiresIn : 300,
    }
  }
  const reason =
    typeof body.error === 'string'
      ? `${body.error}${typeof body.error_description === 'string' ? `: ${body.error_description.slice(0, 200)}` : ''}`
      : `HTTP ${res.status}`
  return {
    refused: reason,
    status: res.status,
    error: typeof body.error === 'string' ? body.error : undefined,
  }
}

/** A JWT's `exp` in milliseconds, unverified (only to bound the cache); null when it isn't a JWT. */
function jwtExpiry(token: string): number | null {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
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
    queryParameters.push({ name: `p${i + 1}`, ...toQueryParameter(await paramValue(param, ctx.evaluate)) })
  }

  const statementTimeout = AbortSignal.timeout(statementTimeoutMs(ctx, config.statementTimeoutMs))
  const signal = AbortSignal.any([ctx.signal, statementTimeout])
  const project = enc(client.projectId)
  const token = tokenSource(client, ctx.credentials)

  // Our own job id, so a cancel always knows which job to stop (even one still being created), and a retried
  // insert can't start a second job.
  let job: JobReference = {
    projectId: client.projectId,
    jobId: `ow_${randomUUID().replaceAll('-', '')}`,
    ...(config.location && { location: config.location }),
  }

  try {
    const inserted = await api<InsertResponse>(client, token, 'POST', `/projects/${project}/jobs`, signal, {
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
        token,
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
    if (signal.aborted) void cancelJob(client, token, job)
    if (statementTimeout.aborted && !ctx.signal.aborted) {
      throw new ConnectorError('timeout', 'The query hit the statement timeout')
    }
    throw err
  }
}

/** Best effort: the job keeps running (and billing) on BigQuery's side unless it's cancelled. */
async function cancelJob(client: Client, token: TokenSource, job: JobReference): Promise<void> {
  const location = job.location ? `?location=${enc(job.location)}` : ''
  await api(
    client,
    token,
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

/** One call to the API with the client's token (a service account's or the connected account's); a 401 refreshes it once. */
async function api<T = unknown>(
  client: Client,
  tokens: TokenSource,
  method: 'GET' | 'POST',
  path: string,
  signal: AbortSignal,
  body?: unknown,
  retried = false,
): Promise<T> {
  const url = new URL(client.endpoints.apiUrl + path)
  const token = await tokens(signal, retried)
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
    return api<T>(client, tokens, method, path, signal, body, true)
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
