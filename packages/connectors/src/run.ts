import { scrubSecrets, scrubSecretsDeep, secretStrings } from '@ow/crypto'
import { type Evaluate, TemplateError } from '@ow/expressions'
import { type PoolManager, parseResource } from './pool'
import {
  type AnyConnector,
  ConnectorError,
  type CredentialSource,
  type QueryResult,
  type ResolvedResource,
} from './types'

export interface RunOptions {
  evaluate: Evaluate
  /** Cancels the query (e.g. the run was cancelled). */
  signal?: AbortSignal
  /** Default 120s, Retool's default query timeout. */
  timeoutMs?: number
  /** See `QueryContext.labels`. */
  labels?: Record<string, string>
  /** See `QueryContext.untrustedValues`. */
  untrustedValues?: boolean
  /** See `QueryContext.credentials`. */
  credentials?: CredentialSource
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Runs one query against a resource through the pool. Every failure becomes a `ConnectorError`, and secret values
 * are scrubbed from errors and metadata (and from data, for connectors that opt in).
 */
export async function runQuery(
  pool: PoolManager,
  connector: AnyConnector,
  resource: ResolvedResource,
  rawQuery: unknown,
  opts: RunOptions,
): Promise<QueryResult> {
  const { credentials, secrets } = scrubbing(resource, opts.credentials)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  try {
    const query = parseQuery(connector, rawQuery)
    const result = await pool.withClient(connector, resource, (client) =>
      connector.execute(client, query, {
        evaluate: wrapEvaluate(opts.evaluate),
        signal,
        timeoutMs,
        ...(opts.labels && { labels: opts.labels }),
        ...(opts.untrustedValues && { untrustedValues: true }),
        ...(credentials && { credentials }),
      }),
    )
    return {
      data: connector.scrubResultData ? scrubSecretsDeep(result.data, secrets) : result.data,
      metadata: scrubSecretsDeep(result.metadata, secrets),
    }
  } catch (err) {
    throw toConnectorError(err, { timedOut: timeout.aborted, timeoutMs, aborted: signal.aborted, secrets })
  }
}

/**
 * Tests a configuration with a fresh client (not the pool), so unsaved settings can be tried from the editor.
 */
export async function testResource(
  connector: AnyConnector,
  resource: ResolvedResource,
  opts: { timeoutMs?: number; credentials?: CredentialSource } = {},
): Promise<{ ok: true; message?: string; durationMs: number } | { ok: false; error: ConnectorError }> {
  const started = performance.now()
  const timeoutMs = opts.timeoutMs ?? 15_000
  const signal = AbortSignal.timeout(timeoutMs)
  const { credentials, secrets } = scrubbing(resource, opts.credentials)
  let client: unknown
  try {
    client = await connector.createClient(parseResource(connector, resource))
    const result = await connector.testConnection(client, {
      signal,
      timeoutMs,
      ...(credentials && { credentials }),
    })
    const message = result.message === undefined ? undefined : scrubSecrets(result.message, secrets)
    return { ok: true, message, durationMs: Math.round(performance.now() - started) }
  } catch (err) {
    return {
      ok: false,
      error: toConnectorError(err, { timedOut: signal.aborted, timeoutMs, aborted: signal.aborted, secrets }),
    }
  } finally {
    if (client !== undefined) await connector.destroyClient(client).catch(() => {})
  }
}

/**
 * The values to scrub from what a query returns: the resource's secrets, plus every access token handed out
 * during the query (the array grows as tokens are issued, and is read when scrubbing).
 */
function scrubbing(
  resource: ResolvedResource,
  source: CredentialSource | undefined,
): { secrets: string[]; credentials: CredentialSource | undefined } {
  const secrets = secretStrings(resource.secrets)
  const credentials = source && {
    async accessToken(opts: Parameters<CredentialSource['accessToken']>[0]) {
      const token = await source.accessToken(opts)
      secrets.push(token)
      return token
    },
  }
  return { secrets, credentials }
}

function parseQuery(connector: AnyConnector, rawQuery: unknown): unknown {
  const parsed = connector.querySchema.safeParse(rawQuery)
  if (!parsed.success) {
    throw new ConnectorError('invalid_query', 'The query is invalid', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  const [first] = connector.validateQuery(parsed.data)
  if (first) throw first
  return parsed.data
}

/** Marks failures inside `{{ }}` so they're reported as expression errors, not query errors. */
function wrapEvaluate(evaluate: Evaluate): Evaluate {
  return async (code) => {
    try {
      return await evaluate(code)
    } catch (err) {
      throw new ConnectorError('expression', `Error in {{ ${code.trim()} }}: ${(err as Error).message}`)
    }
  }
}

function toConnectorError(
  err: unknown,
  ctx: { timedOut: boolean; timeoutMs: number; aborted: boolean; secrets: string[] },
): ConnectorError {
  let error: ConnectorError
  if (ctx.timedOut) {
    error = new ConnectorError('timeout', `The query timed out after ${ctx.timeoutMs} ms`)
  } else if (err instanceof ConnectorError) {
    error = err
  } else if (ctx.aborted) {
    error = new ConnectorError('aborted', 'The query was cancelled')
  } else if (err instanceof TemplateError) {
    error = new ConnectorError('invalid_query', err.message, {
      start: err.start,
      end: err.end,
      hint: err.hint,
    })
  } else {
    error = new ConnectorError('query', err instanceof Error ? err.message : String(err))
  }
  const scrubbed = new ConnectorError(
    error.code,
    scrubSecrets(error.message, ctx.secrets),
    error.details && scrubSecretsDeep(error.details, ctx.secrets),
  )
  return scrubbed
}
