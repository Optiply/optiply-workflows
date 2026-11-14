import { ConnectorError } from '../types'

// The SDK runner's client (M37, docs/architecture.md §2.41): `POST /run` on apps/code-executor's `sdk-runner`
// (`SDK_RUNNER_URL`, `SDK_RUNNER_TOKEN`), streamed, its prints handed on as they come.

export interface SdkRunRequest {
  language: 'python' | 'javascript'
  envId?: string
  mode: 'call' | 'code' | 'describe'
  setup: string
  context: {
    token: string | null
    baseUrl: string | null
    options: Record<string, unknown>
    secrets: Record<string, string>
  }
  method?: string
  args?: unknown
  limit?: number
  code?: string
  params?: unknown
  allowedHosts: string[]
  allowPrivate: boolean
  timeoutMs: number
}

export interface SdkOutcome {
  ok: boolean
  result?: unknown
  error?: { kind: string; message: string; line?: number | null; status?: number; type?: string }
  blocked?: { host: string; reason: string }[]
  connections?: number
}

export type SdkLog = (level: 'log' | 'info' | 'warn' | 'error', message: string) => void

/** The runner is asked to stop this much before the query's own timeout, so it reports the timeout with the prints. */
const RUN_MARGIN_MS = 500
/** Beyond the timeout: the runner's queue (30 s) and a margin. */
const RUN_SLACK_MS = 35_000
const LEVELS = new Set(['log', 'info', 'warn', 'error'])

export interface SdkRunner {
  run(request: SdkRunRequest, opts: { signal: AbortSignal; onLog?: SdkLog }): Promise<SdkOutcome>
}

export class SdkRunnerClient implements SdkRunner {
  private readonly url: string

  constructor(private readonly opts: { url: string; token: string }) {
    this.url = opts.url.replace(/\/$/, '')
  }

  async run(request: SdkRunRequest, opts: { signal: AbortSignal; onLog?: SdkLog }): Promise<SdkOutcome> {
    const timeoutMs = Math.max(1, Math.round(request.timeoutMs))
    const asked = timeoutMs > RUN_MARGIN_MS * 2 ? timeoutMs - RUN_MARGIN_MS : timeoutMs
    const deadline = AbortSignal.timeout(timeoutMs + RUN_SLACK_MS)
    const failed = (err: unknown, doing: string): never => {
      if (err instanceof ConnectorError) throw err
      if (opts.signal.aborted) throw new ConnectorError('aborted', 'The request was cancelled')
      if (deadline.aborted)
        throw new ConnectorError('sdk_unavailable', 'The SDK runner didn’t answer in time')
      throw new ConnectorError('sdk_unavailable', `The SDK runner ${doing}: ${(err as Error).message}`)
    }
    let res: Response
    try {
      res = await fetch(`${this.url}/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, timeoutMs: asked, stream: true }),
        signal: AbortSignal.any([opts.signal, deadline]),
      })
    } catch (err) {
      return failed(err, "isn't reachable")
    }
    if (res.status === 503) throw new ConnectorError('sdk_unavailable', 'The SDK runner is busy; try again')
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text.slice(0, 200)
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
      } catch {}
      throw new ConnectorError(
        'sdk_unavailable',
        `The SDK runner refused the call (${res.status}): ${message}`,
      )
    }
    try {
      return await readStream(res, (entry) =>
        opts.onLog?.(LEVELS.has(entry.level) ? (entry.level as 'log') : 'log', entry.message),
      )
    } catch (err) {
      return failed(err, 'stopped answering')
    }
  }
}

async function readStream(
  res: Response,
  onLog: (entry: { level: string; message: string }) => void,
): Promise<SdkOutcome> {
  if (!res.body) throw new ConnectorError('sdk_unavailable', 'The SDK runner sent no answer')
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
      const item = JSON.parse(line) as { log?: { level: string; message: string }; outcome?: SdkOutcome }
      if (item.log) onLog(item.log)
      else if (item.outcome) {
        while (!(await reader.read()).done) {}
        return item.outcome
      }
    }
  }
  throw new ConnectorError('sdk_unavailable', 'The SDK runner stopped answering before the call ended')
}

/** This process's SDK runner, set once by the server (like `configurePython`); none: SDK resources can't run. */
let runner: SdkRunner | null = null

export function configureSdkRunner(next: SdkRunner | null): void {
  runner = next
}

export function sdkRunner(): SdkRunner {
  if (!runner) {
    throw new ConnectorError(
      'sdk_unavailable',
      "This instance has no SDK runner (SDK_RUNNER_URL): SDK resources can't run here",
    )
  }
  return runner
}

/** What an SDK resource installs (M37): its packages in its language, from a Python index or the npm registries. */
export interface SdkEnvSpec {
  resourceId: string
  language: 'python' | 'javascript'
  /** Requirement lines (`acme-sdk==1.4.2`) or npm packages (`@acme/sdk@^2`). */
  packages: string[]
  /** A Python index's slug (Settings → Python); npm registries apply by scope. */
  pythonIndex?: string | undefined
}

/** The installed env (its id for the runner, the versions installed), or a `sdk_install` ConnectorError. */
export type SdkEnvProvider = (
  spec: SdkEnvSpec,
) => Promise<{ envId: string; versions: Record<string, string> }>

let envProvider: SdkEnvProvider | null = null

/** Set once by the server: installs through the package builder (PYTHON_BUILDER_URL). */
export function configureSdkEnvs(next: SdkEnvProvider | null): void {
  envProvider = next
}

export function sdkEnvs(): SdkEnvProvider {
  if (!envProvider) {
    throw new ConnectorError(
      'sdk_install',
      "This instance has no package builder (PYTHON_BUILDER_URL): an SDK's packages can't be installed here",
    )
  }
  return envProvider
}
