import ivm from 'isolated-vm'
import { stdlibSource } from './stdlib'
import {
  type CodeRuntime,
  type LogLevel,
  type RunOptions,
  SandboxError,
  type SandboxFetchRequest,
} from './types'

const DEFAULT_TIMEOUT_MS = 10_000
/** Extra wall-clock time after `timeoutMs` before the watchdog disposes the whole isolate. */
const WATCHDOG_GRACE_MS = 250

let snapshot: ivm.ExternalCopy<ArrayBuffer> | undefined
function getSnapshot() {
  snapshot ??= ivm.Isolate.createSnapshot([{ code: stdlibSource(), filename: 'ow:stdlib.js' }])
  return snapshot
}

export interface IvmRuntimeOptions {
  /** Heap limit for the isolate in MB (isolated-vm minimum is 8). */
  memoryLimitMb?: number
}

/**
 * isolated-vm implementation of {@link CodeRuntime}.
 *
 * - One isolate per runtime instance (the engine creates one per run lease); it is lazily (re)created.
 * - Every evaluation gets a fresh context from the stdlib snapshot, so evaluations can't see each other's
 *   globals.
 * - The host process must run with `TZ=UTC`: isolates inherit the process timezone, and dayjs' timezone
 *   plugin computes wrong DST offsets otherwise (e.g. Europe/Amsterdam on a CET host on DST-change day).
 * - Synchronous infinite loops are stopped by V8's per-eval `timeout`. Code that keeps running in async
 *   continuations is stopped by a watchdog that disposes the isolate; concurrent evaluations on the same
 *   isolate then fail with a `runtime` error and the next call gets a new isolate.
 */
export class IvmRuntime implements CodeRuntime {
  private isolate: ivm.Isolate | undefined
  private readonly memoryLimitMb: number

  constructor(opts: IvmRuntimeOptions = {}) {
    this.memoryLimitMb = opts.memoryLimitMb ?? 512
  }

  evalExpression(expression: string, scope: Record<string, unknown>, opts: RunOptions = {}) {
    // Newlines around the expression so a trailing `// comment` can't swallow the closing paren.
    const code = `__owToJson((\n${expression}\n))`
    return this.execute(code, scope, opts, { lineOffset: -1, async: false })
  }

  runCode(code: string, scope: Record<string, unknown>, opts: RunOptions = {}) {
    const wrapped = `(async () => {\n${code}\n})().then(__owToJson)`
    return this.execute(wrapped, scope, opts, { lineOffset: -1, async: true })
  }

  dispose() {
    if (this.isolate && !this.isolate.isDisposed) this.isolate.dispose()
    this.isolate = undefined
  }

  /** CPU time consumed by the current isolate, for run metadata. */
  get cpuTimeNs(): bigint {
    return this.isolate && !this.isolate.isDisposed ? this.isolate.cpuTime : 0n
  }

  private getIsolate(): ivm.Isolate {
    if (!this.isolate || this.isolate.isDisposed) {
      this.isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb, snapshot: getSnapshot() })
    }
    return this.isolate
  }

  private async execute(
    code: string,
    scope: Record<string, unknown>,
    opts: RunOptions,
    mode: { lineOffset: number; async: boolean },
  ): Promise<unknown> {
    const isolate = this.getIsolate()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let context: ivm.Context | undefined
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      if (!isolate.isDisposed) isolate.dispose()
    }, timeoutMs + WATCHDOG_GRACE_MS)

    try {
      context = await isolate.createContext()
      const global = context.global
      for (const [key, value] of Object.entries(scope)) {
        if (value === undefined) continue
        try {
          global.setSync(key, value, { copy: true })
        } catch (err) {
          throw new SandboxError('serialization', `Scope value "${key}" is not serializable: ${message(err)}`)
        }
      }
      const onLog = opts.onLog
      if (onLog) {
        global.setSync(
          '__owLog',
          new ivm.Callback((level: LogLevel, json: string) => onLog(level, JSON.parse(json) as unknown[])),
        )
      }
      if (opts.functions || opts.fetch) {
        global.setSync('__owHost', new ivm.Reference(hostBridge(opts)))
        const names = Object.keys(opts.functions ?? {})
        if (names.length) context.evalSync(`__owBindFunctions(${JSON.stringify(names)})`)
      }

      return await context.eval(code, {
        timeout: timeoutMs,
        copy: true,
        promise: mode.async,
        filename: 'user-code.js',
        lineOffset: mode.lineOffset,
      } as ivm.ContextEvalOptions)
    } catch (err) {
      throw toSandboxError(err, { timedOut, timeoutMs, memoryLimitMb: this.memoryLimitMb })
    } finally {
      clearTimeout(watchdog)
      if (context && !isolate.isDisposed) context.release()
      if (isolate.isDisposed && this.isolate === isolate) this.isolate = undefined
    }
  }
}

/**
 * The host side of `__owHost`: runs a host function or `fetch` and answers JSON text, `{ ok, value }` or
 * `{ ok: false, name, message }`. Never rejects, so the sandbox always gets an answer it can turn into an error.
 */
function hostBridge(opts: RunOptions) {
  return async (kind: string, name: string, argsJson: string): Promise<string> => {
    try {
      const args = JSON.parse(argsJson) as unknown[]
      let value: unknown
      if (kind === 'fetch') {
        if (!opts.fetch) throw new Error("fetch isn't available here")
        value = await opts.fetch(args[0] as SandboxFetchRequest)
      } else {
        const fn = opts.functions && Object.hasOwn(opts.functions, name) ? opts.functions[name] : undefined
        if (!fn) throw new Error(`${name} isn't available here`)
        value = await fn(args)
      }
      return JSON.stringify({ ok: true, value: value ?? null })
    } catch (err) {
      const e = err as { name?: unknown; message?: unknown }
      return JSON.stringify({
        ok: false,
        name: typeof e?.name === 'string' ? e.name : 'Error',
        message: typeof e?.message === 'string' ? e.message : String(err),
      })
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toSandboxError(
  err: unknown,
  info: { timedOut: boolean; timeoutMs: number; memoryLimitMb: number },
): SandboxError {
  if (err instanceof SandboxError) return err
  const msg = message(err)
  if (info.timedOut || /Script execution timed out/i.test(msg)) {
    return new SandboxError('timeout', `Code exceeded its time limit of ${info.timeoutMs}ms`)
  }
  if (/memory limit/i.test(msg)) {
    return new SandboxError('memory', `Code exceeded its memory limit of ${info.memoryLimitMb}MB`)
  }
  if (/Isolate was disposed|isolate is disposed/i.test(msg)) {
    return new SandboxError('runtime', 'Sandbox was reset while this code was running')
  }
  if (err instanceof SyntaxError || /^SyntaxError/.test(msg)) {
    return new SandboxError('syntax', msg)
  }
  if (/could not be cloned|non-transferable/i.test(msg)) {
    return new SandboxError('serialization', `Result is not JSON-serializable: ${msg}`)
  }
  return new SandboxError('runtime', msg, err instanceof Error ? err.stack : undefined)
}
