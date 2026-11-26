import { createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** How a scripted job behaves. Rows are BigQuery's REST shape: `{ f: [{ v }] }` with string values. */
export interface FakeJob {
  schema?: { fields: object[] }
  rows?: { f: { v: unknown }[] }[]
  /** Rows per page (default: all at once). */
  pageSize?: number
  /** How many result calls answer "not complete yet" first (Infinity: never completes). */
  pending?: number
  /** Bytes the query would bill; over the request's maximumBytesBilled, the job fails like BigQuery's. */
  bytes?: number
  numDmlAffectedRows?: number
  /** The job fails with this error result. */
  error?: { reason: string; message: string; location?: string }
}

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  authorization?: string
  body: unknown
}

interface Job extends FakeJob {
  id: string
  location: string
  request: Record<string, unknown>
  cancelled: boolean
}

/**
 * A stand-in for Google's token endpoint and the BigQuery v2 REST API, just enough for the connector: the JWT
 * bearer grant (signature and claims checked), jobs.insert, getQueryResults with paging and polling, jobs.cancel
 * and dry runs. Jobs are scripted by SQL text with `script()`.
 */
export interface FakeRoutine {
  type?: string
  args: { name: string; typeKind?: string }[]
  /** returnTableType's columns, when the function declares them. */
  declared?: { name: string; type: { typeKind: string; arrayElementType?: { typeKind: string } } }[]
  /** What a dry run says it returns. */
  fields?: { name: string; type: string; mode?: string }[]
  dryRunError?: string
  getError?: string
}

export class FakeBigQuery {
  readonly requests: Recorded[] = []
  readonly keyJson: string
  readonly clientEmail = 'workflows@optiply-test.iam.gserviceaccount.com'
  readonly projectId = 'optiply-test'
  tokensIssued = 0
  /** Answer the next API call with 401 (an expired token), once. */
  rejectNextToken = false
  readonly jobs = new Map<string, Job>()
  private readonly scripts: { match: (sql: string) => boolean; job: FakeJob }[] = []
  private readonly publicKey: string
  private server?: Server
  private validTokens = new Set<string>()

  /** An access token the API accepts, as if Google had issued it to a connected account (OAuth). */
  allowToken(value: string): void {
    this.validTokens.add(value)
  }

  /** STS: the identity pool audience it accepts, the Optiply tokens it exchanges, and what it issued. */
  readonly stsAudience =
    '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/auth0'
  private readonly optiplyTokens = new Set<string>()
  stsIssued = 0
  /** The next STS exchange is refused (e.g. an Optiply token Auth0 has revoked), once. */
  refuseNextExchange = false
  /** The next STS exchanges answer this instead (a wrong audience, a busy or failing STS), `times` times. */
  failExchange: { status: number; body: unknown; times: number } | null = null
  /** How long STS takes to answer (to have exchanges overlap). */
  exchangeDelayMs = 0
  /**
   * The data platform's routines (`optiply-data-platform.agent_api`): what `routines.list`/`get` answer, and what a dry
   * run of `SELECT * FROM fn(...)` says it returns (`fields`), or refuses (`dryRunError`).
   */
  readonly routines = new Map<string, FakeRoutine>()
  /** The dry runs' SQL, in order. */
  readonly dryRuns: string[] = []
  /** An Optiply (Auth0) token STS exchanges for a Google token. */
  allowOptiplyToken(value: string): void {
    this.optiplyTokens.add(value)
  }

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.publicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    this.keyJson = JSON.stringify({
      type: 'service_account',
      project_id: this.projectId,
      private_key_id: 'abc123',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: this.clientEmail,
      // Ignored by the connector: tokens only ever go to the configured endpoint.
      token_uri: 'https://evil.example.com/token',
    })
  }

  get endpoints() {
    const base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
    return {
      apiUrl: `${base}/bigquery/v2`,
      tokenUrl: `${base}/token`,
      stsUrl: `${base}/sts/v1/token`,
      stsAudience: this.stsAudience,
    }
  }

  script(match: string | RegExp, job: FakeJob): void {
    const test = typeof match === 'string' ? (sql: string) => sql === match : (sql: string) => match.test(sql)
    this.scripts.unshift({ match: test, job })
  }

  /** Requests to the API (not the token endpoint). */
  apiCalls(kind?: 'insert' | 'results' | 'cancel' | 'dryRun'): Recorded[] {
    return this.requests.filter((r) => {
      if (r.path === '/token' || r.path === '/sts/v1/token') return false
      if (!kind) return true
      if (kind === 'insert') return r.method === 'POST' && r.path.endsWith('/jobs')
      if (kind === 'results') return r.method === 'GET' && r.path.includes('/queries/')
      if (kind === 'cancel') return r.path.endsWith('/cancel')
      return r.method === 'POST' && r.path.endsWith('/queries')
    })
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        },
        (err: Error) => {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: err.message } }))
        },
      )
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise((r) => this.server?.close(r))
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url!, 'http://fake')
    const raw = await new Promise<string>((resolve) => {
      let data = ''
      req.on('data', (c: Buffer) => {
        data += c.toString()
      })
      req.on('end', () => resolve(data))
    })
    const isForm = req.headers['content-type']?.includes('x-www-form-urlencoded')
    const body = raw ? (isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined
    this.requests.push({
      method: req.method!,
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
      body,
    })

    if (url.pathname === '/token') return this.token(body as Record<string, string>)
    if (url.pathname === '/sts/v1/token') {
      if (this.exchangeDelayMs) await new Promise((r) => setTimeout(r, this.exchangeDelayMs))
      return this.exchange(body as Record<string, string>)
    }

    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token || !this.validTokens.has(token) || this.rejectNextToken) {
      this.rejectNextToken = false
      if (token) this.validTokens.delete(token)
      return googleError(401, 'authError', 'Request had invalid authentication credentials.')
    }

    const r = /^\/bigquery\/v2\/projects\/([^/]+)\/datasets\/([^/]+)\/routines(?:\/([^/]+))?$/.exec(
      url.pathname,
    )
    if (r && req.method === 'GET')
      return this.routine(r[1]!, r[2]!, r[3] && decodeURIComponent(r[3]), url.searchParams)

    const m = /^\/bigquery\/v2\/projects\/([^/]+)\/(jobs|queries)(?:\/([^/]+))?(?:\/(cancel))?$/.exec(
      url.pathname,
    )
    if (!m) return { status: 404, body: { error: { message: `No route ${url.pathname}` } } }
    const [, , collection, jobId, cancel] = m

    if (collection === 'queries' && !jobId && req.method === 'POST') {
      // jobs.query, used for dry runs.
      return {
        status: 200,
        body: { kind: 'bigquery#queryResponse', jobComplete: true, totalBytesProcessed: '0' },
      }
    }
    if (collection === 'jobs' && !jobId && req.method === 'POST')
      // biome-ignore lint/suspicious/noExplicitAny: request JSON
      return this.insert(body as Record<string, any>)
    const job = this.jobs.get(decodeURIComponent(jobId ?? ''))
    if (!job) return googleError(404, 'notFound', `Not found: Job ${jobId}`)
    if (cancel) {
      job.cancelled = true
      return { status: 200, body: { kind: 'bigquery#jobCancelResponse' } }
    }
    return this.results(job, url.searchParams)
  }

  /** Requests to STS. */
  stsCalls(): Recorded[] {
    return this.requests.filter((r) => r.path === '/sts/v1/token')
  }

  // As Google STS answers: an OAuth error object on refusal, a Google access token on success.
  private exchange(form: Record<string, string>): { status: number; body: unknown } {
    if (
      form.grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange' ||
      form.requested_token_type !== 'urn:ietf:params:oauth:token-type:access_token' ||
      form.subject_token_type !== 'urn:ietf:params:oauth:token-type:jwt' ||
      form.scope !== 'https://www.googleapis.com/auth/cloud-platform'
    ) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'Bad exchange' } }
    }
    if (this.failExchange && this.failExchange.times > 0) {
      this.failExchange.times--
      return { status: this.failExchange.status, body: this.failExchange.body }
    }
    if (form.audience !== this.stsAudience) {
      return { status: 400, body: { error: 'invalid_target', error_description: 'Unknown audience' } }
    }
    if (this.refuseNextExchange || !this.optiplyTokens.has(form.subject_token ?? '')) {
      this.refuseNextExchange = false
      return { status: 400, body: { error: 'invalid_grant', error_description: 'The token is invalid' } }
    }
    const value = `fed-${++this.stsIssued}`
    this.validTokens.add(value)
    return { status: 200, body: { access_token: value, expires_in: 3599, token_type: 'Bearer' } }
  }

  private token(form: Record<string, string>): { status: number; body: unknown } {
    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      return { status: 400, body: { error: 'unsupported_grant_type' } }
    }
    const [header, claims, signature] = (form.assertion ?? '').split('.')
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(this.publicKey, signature ?? '', 'base64url')
    const c = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())
    const now = Date.now() / 1000
    if (
      !valid ||
      c.iss !== this.clientEmail ||
      c.scope !== 'https://www.googleapis.com/auth/bigquery' ||
      c.aud !== this.endpoints.tokenUrl ||
      !(c.iat <= now + 5 && c.exp > now)
    ) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }
    }
    const value = `tok-${++this.tokensIssued}`
    this.validTokens.add(value)
    return { status: 200, body: { access_token: value, expires_in: 3599, token_type: 'Bearer' } }
  }

  // biome-ignore lint/suspicious/noExplicitAny: request JSON
  private routine(
    project: string,
    dataset: string,
    id: string | undefined,
    params: URLSearchParams,
  ): { status: number; body: unknown } {
    if (project !== 'optiply-data-platform' || dataset !== 'agent_api') {
      return googleError(404, 'notFound', `Not found: Dataset ${project}:${dataset}`)
    }
    const ref = (routineId: string) => ({ projectId: project, datasetId: dataset, routineId })
    if (id === undefined) {
      // Pages of two, to have the connector follow nextPageToken.
      const all = [...this.routines.keys()]
      const start = Number(params.get('pageToken') ?? 0)
      const page = all.slice(start, start + 2)
      return {
        status: 200,
        body: {
          routines: page.map((name) => ({
            routineReference: ref(name),
            routineType: this.routines.get(name)!.type ?? 'TABLE_VALUED_FUNCTION',
          })),
          ...(start + 2 < all.length && { nextPageToken: String(start + 2) }),
        },
      }
    }
    const routine = this.routines.get(id)
    if (!routine) return googleError(404, 'notFound', `Not found: Routine ${project}:${dataset}.${id}`)
    if (routine.getError) return googleError(403, 'accessDenied', routine.getError)
    return {
      status: 200,
      body: {
        routineReference: ref(id),
        routineType: routine.type ?? 'TABLE_VALUED_FUNCTION',
        arguments: routine.args.map((a) => ({ name: a.name, dataType: { typeKind: a.typeKind } })),
        ...(routine.declared && {
          returnTableType: { columns: routine.declared.map((c) => ({ name: c.name, type: c.type })) },
        }),
      },
    }
  }

  // A dry run (jobs.insert with configuration.dryRun) of one of the data platform's functions: its columns, no job.
  // biome-ignore lint/suspicious/noExplicitAny: request JSON
  private dryRun(body: Record<string, any>): { status: number; body: unknown } {
    const sql: string = body.configuration.query.query
    this.dryRuns.push(sql)
    const name = /`optiply-data-platform\.agent_api\.(\w+)`\(/.exec(sql)?.[1]
    const routine = name ? this.routines.get(name) : undefined
    if (!routine) return googleError(400, 'invalidQuery', `Unrecognized name in ${sql}`)
    if (routine.dryRunError) return googleError(403, 'accessDenied', routine.dryRunError)
    return {
      status: 200,
      body: {
        status: { state: 'DONE' },
        statistics: { query: { schema: { fields: routine.fields ?? [] } } },
      },
    }
  }

  private insert(body: Record<string, any>): { status: number; body: unknown } {
    if (body.configuration?.dryRun) return this.dryRun(body)
    const ref = body.jobReference
    const query = body.configuration.query
    const script = this.scripts.find((s) => s.match(query.query))?.job ?? { rows: [], schema: { fields: [] } }
    const job: Job = {
      ...script,
      id: ref.jobId,
      location: ref.location ?? 'EU',
      request: body,
      cancelled: false,
    }
    if ((script.bytes ?? 0) > Number(query.maximumBytesBilled)) {
      job.error = {
        reason: 'bytesBilledLimitExceeded',
        message: `Query exceeded limit for bytes billed: ${query.maximumBytesBilled}. ${script.bytes} or higher required.`,
      }
    }
    this.jobs.set(job.id, job)
    return {
      status: 200,
      body: {
        jobReference: { projectId: ref.projectId, jobId: job.id, location: job.location },
        status: { state: 'RUNNING' },
      },
    }
  }

  private results(job: Job, params: URLSearchParams): { status: number; body: unknown } {
    const reference = { projectId: this.projectId, jobId: job.id, location: job.location }
    if (job.cancelled)
      return googleError(400, 'stopped', 'Job execution was cancelled: User requested cancellation')
    if ((job.pending ?? 0) > 0) {
      job.pending = (job.pending ?? 0) - 1
      return { status: 200, body: { jobReference: reference, jobComplete: false } }
    }
    if (job.error) return googleError(400, job.error.reason, job.error.message, job.error.location)
    if (job.numDmlAffectedRows !== undefined) {
      return {
        status: 200,
        body: {
          jobReference: reference,
          jobComplete: true,
          numDmlAffectedRows: String(job.numDmlAffectedRows),
        },
      }
    }
    const rows = job.rows ?? []
    const start = Number(params.get('pageToken') ?? 0)
    const size = Math.min(job.pageSize ?? rows.length, Number(params.get('maxResults') ?? rows.length))
    const end = start + size
    return {
      status: 200,
      body: {
        jobReference: reference,
        jobComplete: true,
        schema: job.schema,
        totalRows: String(rows.length),
        rows: rows.slice(start, end),
        ...(end < rows.length && { pageToken: String(end) }),
        totalBytesProcessed: String(job.bytes ?? 0),
        cacheHit: false,
      },
    }
  }
}

function googleError(code: number, reason: string, message: string, location?: string) {
  return {
    status: code,
    body: { error: { code, message, errors: [{ reason, message, ...(location && { location }) }] } },
  }
}
