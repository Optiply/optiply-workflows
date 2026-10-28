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
  /** What the code prints, a line each (stdout as `log`, stderr as `error`), as it prints it. */
  onLog?: (level: LogLevel, args: unknown[]) => void
}

export interface PythonProblem {
  id: string
  message: string
  line: number
  column: number | null
}

/**
 * This process's Python executions by the jail they ran in (M23): `warm` ones from the executor's pool, `cold` ones
 * started for them. Read by the server's metrics.
 */
export const pythonStats = { warm: 0, cold: 0 }

interface Outcome {
  ok: boolean
  warm?: boolean
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
    const onLog = (entry: { level: string; message: string }) => {
      const level = LEVELS.has(entry.level as LogLevel) ? (entry.level as LogLevel) : 'log'
      opts.onLog?.(level, [entry.message])
    }
    const outcome = await this.request(
      '/run',
      { code, scope, timeoutMs: asked, stream: true },
      opts.signal,
      timeoutMs + RUN_SLACK_MS,
      async (res) => {
        // An executor from before streaming answers JSON, its logs in the outcome.
        if (!res.headers.get('content-type')?.startsWith('application/x-ndjson')) {
          const whole = (await res.json()) as Outcome
          for (const entry of whole.logs ?? []) onLog(entry)
          return whole
        }
        return readStream(res, onLog)
      },
    )
    // An executor from before the pool doesn't say.
    if (outcome.warm !== undefined) pythonStats[outcome.warm ? 'warm' : 'cold']++
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
    const outcome = await this.request(
      '/check',
      { fields },
      opts.signal,
      this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
      async (res) => (await res.json()) as Outcome,
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

  /** Posts `body` and reads the answer with `read`; the caller's signal and the deadline cover the reading too. */
  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    read: (res: Response) => Promise<Outcome>,
  ): Promise<Outcome> {
    const deadline = AbortSignal.timeout(timeoutMs)
    const failed = (err: unknown, doing: string): never => {
      if (err instanceof SandboxError) throw err
      if (signal?.aborted) throw signal.reason ?? err
      if (deadline.aborted) {
        throw new SandboxError(
          'unavailable',
          `The Python executor didn't answer within ${timeoutMs / 1000} s`,
        )
      }
      throw new SandboxError('unavailable', `The Python executor ${doing}: ${(err as Error).message}`)
    }
    let res: Response
    try {
      res = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
    } catch (err) {
      return failed(err, "isn't reachable")
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
    try {
      return await read(res)
    } catch (err) {
      return failed(err, 'stopped answering')
    }
  }
}

/** The executor's NDJSON stream: each `log` line to `onLog` as it comes, then the outcome (the last line). */
async function readStream(
  res: Response,
  onLog: (entry: { level: string; message: string }) => void,
): Promise<Outcome> {
  if (!res.body) throw new SandboxError('unavailable', 'The Python executor sent no answer')
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += value
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const item = JSON.parse(line) as { log?: { level: string; message: string }; outcome?: Outcome }
      if (item.log) onLog(item.log)
      else if (item.outcome) {
        // Read to the end (the chunked answer's terminator), so the connection can be used again.
        while (!(await reader.read()).done) {}
        return item.outcome
      }
    }
  }
  // The executor went away mid-run (it was restarted, it died): what was printed so far has been logged.
  throw new SandboxError('unavailable', 'The Python executor stopped answering before the code ended')
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
