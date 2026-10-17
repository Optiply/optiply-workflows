import { type LogLevel, SandboxError } from './types'

/**
 * Python code blocks run by the code executor (apps/code-executor, docs/architecture.md §2.14), each in a fresh
 * nsjail jail: data in (the scope), data out (the return value), prints as logs. No network, no functions.
 */
export interface PythonRunner {
  /** Runs `code` as a function body against `scope`; resolves to its JSON result, rejects with a `SandboxError`. */
  run(code: string, scope: Record<string, unknown>, opts: PythonRunOptions): Promise<unknown>
  /** Compiles fields without running them: their syntax errors (line and column are 1-based). */
  check(fields: { id: string; code: string }[], opts?: { signal?: AbortSignal }): Promise<PythonProblem[]>
}

export interface PythonRunOptions {
  /** The executor stops the code at this (the jail's limit is the next whole second). */
  timeoutMs: number
  /** Aborting hangs up on the executor, which kills the jail. */
  signal?: AbortSignal
  /** What the code printed, a line each (stdout as `log`, stderr as `error`), once it ends. */
  onLog?: (level: LogLevel, args: unknown[]) => void
}

export interface PythonProblem {
  id: string
  message: string
  line: number
  column: number | null
}

interface Outcome {
  ok: boolean
  result?: unknown
  error?: { kind: string; message: string; line?: number | null; column?: number | null; traceback?: string }
  logs?: { level: string; message: string }[]
  problems?: PythonProblem[]
}

const KINDS = new Set(['syntax', 'runtime', 'timeout', 'memory', 'serialization'])
/** The executor is asked to stop this much before the run's timeout, so it reports the timeout (with the prints). */
const RUN_MARGIN_MS = 500
/** How long a check may take, the executor's queue included, before it counts as unavailable. */
const CHECK_TIMEOUT_MS = 15_000
/** Beyond a run's timeout, if nothing hangs up first: the executor's queue (30 s) and a margin. */
const RUN_SLACK_MS = 35_000
const LEVELS = new Set<LogLevel>(['log', 'info', 'warn', 'error'])

/** The code executor over HTTP, with its bearer token. */
export class PythonExecutorClient implements PythonRunner {
  private readonly url: string

  constructor(
    private readonly opts: {
      url: string
      token: string
      /** How long a check may take (default 15 s). */
      checkTimeoutMs?: number
    },
  ) {
    this.url = opts.url.replace(/\/$/, '')
  }

  async run(code: string, scope: Record<string, unknown>, opts: PythonRunOptions): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.round(opts.timeoutMs))
    // Stop a little before the caller's own timeout: the executor's answer then carries the prints.
    const asked = timeoutMs > RUN_MARGIN_MS * 2 ? timeoutMs - RUN_MARGIN_MS : timeoutMs
    const outcome = await this.post(
      '/run',
      { code, scope, timeoutMs: asked },
      opts.signal,
      timeoutMs + RUN_SLACK_MS,
    )
    for (const entry of outcome.logs ?? []) {
      const level = LEVELS.has(entry.level as LogLevel) ? (entry.level as LogLevel) : 'log'
      opts.onLog?.(level, [entry.message])
    }
    if (outcome.ok) return outcome.result ?? null
    if (outcome.error?.kind === 'timeout') {
      throw new SandboxError('timeout', `The Python code didn't finish within ${timeoutMs} ms`)
    }
    throw toSandboxError(outcome.error)
  }

  async check(
    fields: { id: string; code: string }[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<PythonProblem[]> {
    if (!fields.length) return []
    const outcome = await this.post(
      '/check',
      { fields },
      opts.signal,
      this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
    )
    // A check that failed (no jail, out of time) says nothing about the code: never read it as "no problems".
    if (!outcome.ok) {
      throw new SandboxError(
        'unavailable',
        `The Python executor couldn't check the code: ${outcome.error?.message ?? 'unknown error'}`,
      )
    }
    return outcome.problems ?? []
  }

  private async post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Outcome> {
    const deadline = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      if (deadline.aborted) {
        throw new SandboxError(
          'unavailable',
          `The Python executor didn't answer within ${timeoutMs / 1000} s`,
        )
      }
      throw new SandboxError('unavailable', `The Python executor isn't reachable: ${(err as Error).message}`)
    }
    if (res.status === 503) {
      throw new SandboxError('unavailable', 'The Python executor is busy; try again')
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text.slice(0, 200)
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
      } catch {}
      throw new SandboxError(
        'unavailable',
        `The Python executor refused the request (${res.status}): ${message}`,
      )
    }
    return (await res.json()) as Outcome
  }
}

function toSandboxError(error: Outcome['error']): SandboxError {
  if (!error) return new SandboxError('runtime', 'The Python code failed')
  const where =
    error.line != null
      ? ` (line ${error.line}${error.kind === 'syntax' && error.column ? `, column ${error.column}` : ''})`
      : ''
  const details = {
    ...(error.line != null && { line: error.line }),
    ...(error.column != null && { column: error.column }),
    ...(error.traceback && { traceback: error.traceback }),
  }
  if (!KINDS.has(error.kind)) {
    // `internal`: the executor couldn't start a jail.
    return new SandboxError('unavailable', error.message)
  }
  return new SandboxError(
    error.kind as 'syntax' | 'runtime' | 'timeout' | 'memory' | 'serialization',
    `${error.message}${where}`,
    error.traceback,
    Object.keys(details).length ? details : undefined,
  )
}
