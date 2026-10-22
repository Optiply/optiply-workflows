import { scrubSecrets, scrubSecretsDeep, secretStrings } from '@ow/crypto'
import { type Evaluate, TemplateError } from '@ow/expressions'
import { type PoolManager, parseResource } from './pool'
import { tunnelFor } from './ssh/client'
import type { SshConfig, SshSecrets } from './ssh/settings'
import type { SshTestStep } from './ssh/tunnel'
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
): Promise<
  | { ok: true; message?: string; durationMs: number; ssh?: SshTestStep[] }
  | { ok: false; error: ConnectorError; ssh?: SshTestStep[] }
> {
  const started = performance.now()
  const timeoutMs = opts.timeoutMs ?? 15_000
  const signal = AbortSignal.timeout(timeoutMs)
  const { credentials, secrets } = scrubbing(resource, opts.credentials)
  let client: unknown
  let ssh: SshTestStep[] | undefined
  try {
    const parsed = parseResource(connector, resource)
    // Through an SSH tunnel (M17): each hop first, reported on its own; the resource only once they all work.
    const tunnel = tunnelFor(parsed.config as { ssh?: SshConfig }, parsed.secrets as { ssh?: SshSecrets }, {
      connectTimeoutMs: timeoutMs,
    })
    if (tunnel) {
      ssh = await tunnel.probe()
      await tunnel.close()
      const failed = ssh.find((s) => !s.ok)
      if (failed?.error) {
        const error = new ConnectorError('connection', failed.error.message, {
          ssh: { code: failed.error.code, hop: failed.hop, host: failed.host },
        })
        return { ok: false, error, ssh }
      }
    }
    client = await connector.createClient(parsed)
    const result = await connector.testConnection(client, {
      signal,
      timeoutMs,
      ...(credentials && { credentials }),
    })
    const message = result.message === undefined ? undefined : scrubSecrets(result.message, secrets)
    return { ok: true, message, durationMs: Math.round(performance.now() - started), ...(ssh ? { ssh } : {}) }
  } catch (err) {
    return {
      ok: false,
      error: toConnectorError(err, { timedOut: signal.aborted, timeoutMs, aborted: signal.aborted, secrets }),
      ...(ssh ? { ssh } : {}),
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
  let credentials: CredentialSource | undefined
  if (source) {
    credentials = {}
    if (source.accessToken) {
      const accessToken = source.accessToken.bind(source)
      credentials.accessToken = async (opts) => {
        const token = await accessToken(opts)
        secrets.push(token)
        return token
      }
    }
    if (source.authVariables) {
      const authVariables = source.authVariables.bind(source)
      credentials.authVariables = async (opts) => {
        const variables = await authVariables(opts)
        secrets.push(...variables.secrets)
        return variables
      }
    }
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
