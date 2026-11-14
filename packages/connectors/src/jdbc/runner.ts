import { ConnectorError, type ConnectorErrorCode, type QueryResult } from '../types'
import type { JdbcConnection } from './settings'

// The JDBC runner's client (M38, docs/architecture.md §2.42): apps/jdbc-runner's API (`JDBC_RUNNER_URL`,
// `JDBC_RUNNER_TOKEN`). Queries come back as JSON lines; an uploaded driver's jar is sent when the runner asks.

export interface JdbcQueryRequest {
  queryId: string
  connection: JdbcConnection
  sql: string
  params: unknown[]
  maxRows: number
  timeoutMs: number
}

/** An uploaded driver's jar, read only when the runner doesn't have it yet. */
export type JarSource = () => Promise<Uint8Array>

export interface JdbcRunner {
  query(request: JdbcQueryRequest, opts: { signal: AbortSignal; jar?: JarSource }): Promise<QueryResult>
  test(
    connection: JdbcConnection,
    opts: { signal: AbortSignal; timeoutMs: number; jar?: JarSource },
  ): Promise<{ message: string }>
  /** Closes the pools a resource's client made (its settings changed, or it was dropped). Best effort. */
  closePools(poolKey: string): Promise<void>
}

/** The runner answers by then, or it's gone: its own timeout first, then a margin (its queue waits up to 30 s). */
const SLACK_MS = 45_000

const KINDS: Record<string, ConnectorErrorCode> = {
  connection: 'connection',
  query: 'query',
  timeout: 'timeout',
  aborted: 'aborted',
  too_large: 'too_large',
  invalid_config: 'invalid_config',
}

export class JdbcRunnerClient implements JdbcRunner {
  private readonly url: string

  constructor(private readonly opts: { url: string; token: string }) {
    this.url = opts.url.replace(/\/$/, '')
  }

  async query(
    request: JdbcQueryRequest,
    opts: { signal: AbortSignal; jar?: JarSource },
  ): Promise<QueryResult> {
    const deadline = AbortSignal.timeout(request.timeoutMs + SLACK_MS)
    const signal = AbortSignal.any([opts.signal, deadline])
    // Cancelled here: the runner cancels the statement on the database (closing the stream would too, later).
    const onAbort = () => {
      void this.post('/cancel', { queryId: request.queryId }, AbortSignal.timeout(5_000)).catch(() => {})
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.withDriver(
        () => this.post('/query', request, signal),
        request.connection,
        opts.jar,
        signal,
      )
      return await readLines(res)
    } catch (err) {
      throw this.failure(err, opts.signal, deadline)
    } finally {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  async test(
    connection: JdbcConnection,
    opts: { signal: AbortSignal; timeoutMs: number; jar?: JarSource },
  ): Promise<{ message: string }> {
    const deadline = AbortSignal.timeout(opts.timeoutMs + 5_000)
    const signal = AbortSignal.any([opts.signal, deadline])
    try {
      const res = await this.withDriver(
        () => this.post('/test', { connection, timeoutMs: opts.timeoutMs }, signal),
        connection,
        opts.jar,
        signal,
      )
      const body = (await res.json()) as { ok: boolean; message?: string; error?: RunnerError }
      if (!body.ok) throw toError(body.error)
      return { message: body.message ?? 'Connected' }
    } catch (err) {
      throw this.failure(err, opts.signal, deadline)
    }
  }

  async closePools(poolKey: string): Promise<void> {
    try {
      await fetch(`${this.url}/pools?key=${encodeURIComponent(poolKey)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      // The runner closes idle pools itself.
    }
  }

  /** Sends the request; when the runner doesn't have the uploaded driver's jar yet (409), uploads it and asks again. */
  private async withDriver(
    send: () => Promise<Response>,
    connection: JdbcConnection,
    jar: JarSource | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    let res = await send()
    if (res.status === 409 && connection.driverSha && jar) {
      await res.body?.cancel()
      const bytes = await jar()
      const put = await fetch(`${this.url}/drivers/${connection.driverSha}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/java-archive' },
        body: new Uint8Array(bytes),
        signal,
      })
      if (!put.ok) throw await refused(put, 'the driver')
      res = await send()
    }
    if (!res.ok) throw await refused(res, 'the query')
    return res
  }

  private post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  private failure(err: unknown, signal: AbortSignal, deadline: AbortSignal): unknown {
    if (err instanceof ConnectorError) return err
    if (signal.aborted) return new ConnectorError('aborted', 'The query was cancelled')
    if (deadline.aborted) return new ConnectorError('timeout', 'The JDBC runner didn’t answer in time')
    return new ConnectorError('connection', `The JDBC runner isn't reachable: ${(err as Error).message}`)
  }
}

interface RunnerError {
  kind?: string
  message?: string
  sqlState?: string
  vendorCode?: number
}

function toError(e: RunnerError | undefined): ConnectorError {
  const code: ConnectorErrorCode = (e?.kind ? KINDS[e.kind] : undefined) ?? 'connection'
  const message =
    e?.kind === 'busy' ? `${e.message} Try again in a moment.` : (e?.message ?? 'The JDBC runner failed')
  return new ConnectorError(code, message, {
    ...(e?.sqlState ? { sqlState: e.sqlState } : {}),
    ...(e?.vendorCode !== undefined ? { vendorCode: e.vendorCode } : {}),
  })
}

async function refused(res: Response, what: string): Promise<ConnectorError> {
  const text = await res.text().catch(() => '')
  let message = text.slice(0, 300)
  let kind: string | undefined
  try {
    const body = JSON.parse(text) as { error?: string; kind?: string }
    message = body.error ?? message
    kind = body.kind
  } catch {}
  if (res.status === 401)
    return new ConnectorError(
      'connection',
      "The JDBC runner refused this instance's token (JDBC_RUNNER_TOKEN)",
    )
  if (kind === 'invalid_config') return new ConnectorError('invalid_config', message)
  return new ConnectorError('connection', `The JDBC runner refused ${what} (${res.status}): ${message}`)
}

/** The query's lines: fields, rows, then the end or an error. */
async function readLines(res: Response): Promise<QueryResult> {
  if (!res.body) throw new ConnectorError('connection', 'The JDBC runner sent no answer')
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let fields: { name: string; type: string }[] | undefined
  const rows: Record<string, unknown>[] = []
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += value
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const item = JSON.parse(line) as {
        type: string
        fields?: { name: string; type: string }[]
        rows?: Record<string, unknown>[]
        affectedRows?: number
      } & RunnerError
      if (item.type === 'fields') fields = item.fields
      else if (item.type === 'rows') for (const row of item.rows ?? []) rows.push(row)
      else if (item.type === 'error') {
        await reader.cancel().catch(() => {})
        throw toError(item)
      } else if (item.type === 'end') {
        await reader.cancel().catch(() => {})
        const affected = item.affectedRows ?? 0
        if (!fields) return { data: [], metadata: { rowCount: affected, affectedRows: affected, fields: [] } }
        return {
          data: rows,
          metadata: { rowCount: rows.length, fields, ...(affected ? { affectedRows: affected } : {}) },
        }
      }
    }
  }
  throw new ConnectorError('connection', 'The JDBC runner stopped answering before the query ended')
}

/** This process's JDBC runner, set once by the server (like the SDK runner); none: JDBC resources can't run. */
let runner: JdbcRunner | null = null

export function configureJdbcRunner(next: JdbcRunner | null): void {
  runner = next
}

export function jdbcRunner(): JdbcRunner {
  if (!runner) {
    throw new ConnectorError(
      'connection',
      "This instance has no JDBC runner (JDBC_RUNNER_URL and JDBC_RUNNER_TOKEN): JDBC resources can't run here",
    )
  }
  return runner
}

/** An uploaded driver as the connector needs it (M38 step 3b): its jar by hash, and its class. */
export interface UploadedDriver {
  sha256: string
  className: string
  jar: JarSource
}

let driverLookup: ((id: string) => Promise<UploadedDriver | null>) | null = null

/** Set once by the server: finds an uploaded driver by id (Settings → JDBC drivers). */
export function configureJdbcDrivers(next: ((id: string) => Promise<UploadedDriver | null>) | null): void {
  driverLookup = next
}

export async function uploadedDriver(id: string): Promise<UploadedDriver> {
  const found = driverLookup ? await driverLookup(id) : null
  if (!found) {
    throw new ConnectorError(
      'invalid_config',
      'The resource’s uploaded driver is gone: choose another in its settings',
      {
        field: 'driverId',
      },
    )
  }
  return found
}
