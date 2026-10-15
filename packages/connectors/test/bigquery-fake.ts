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
    return { apiUrl: `${base}/bigquery/v2`, tokenUrl: `${base}/token` }
  }

  script(match: string | RegExp, job: FakeJob): void {
    const test = typeof match === 'string' ? (sql: string) => sql === match : (sql: string) => match.test(sql)
    this.scripts.unshift({ match: test, job })
  }

  /** Requests to the API (not the token endpoint). */
  apiCalls(kind?: 'insert' | 'results' | 'cancel' | 'dryRun'): Recorded[] {
    return this.requests.filter((r) => {
      if (r.path === '/token') return false
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

    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token || !this.validTokens.has(token) || this.rejectNextToken) {
      this.rejectNextToken = false
      if (token) this.validTokens.delete(token)
      return googleError(401, 'authError', 'Request had invalid authentication credentials.')
    }

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
  private insert(body: Record<string, any>): { status: number; body: unknown } {
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
