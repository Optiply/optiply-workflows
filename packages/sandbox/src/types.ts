export type LogLevel = 'log' | 'info' | 'warn' | 'error'

export interface RunOptions {
  /** Wall-clock limit; the isolate is disposed when exceeded (also kills async infinite loops). */
  timeoutMs?: number
  /** Receives console.* calls from user code. Arguments are JSON-safe copies. */
  onLog?: (level: LogLevel, args: unknown[]) => void
  /**
   * Functions code can call by name, `await name(...args)` (workflow functions). Arguments arrive as JSON copies;
   * the result is copied back as JSON. A thrown error rejects the call inside the sandbox with its message.
   */
  functions?: Record<string, HostFunction>
  /** Backs the global `fetch`. Without it, `fetch` rejects with "fetch isn't available here". */
  fetch?: (request: SandboxFetchRequest) => Promise<SandboxFetchResponse>
  /**
   * The workflow's JavaScript packages: a bundle setting `globalThis.__owModules`, run in the context before the
   * code (`import` lines, rewritten, read it through `__owImport`). `hash` identifies it, so it's compiled once.
   */
  modules?: SandboxModules
}

export interface SandboxModules {
  hash: string
  js: string
}

export type HostFunction = (args: unknown[]) => Promise<unknown>

/** What code passed to `fetch(url, init)`, normalized. */
export interface SandboxFetchRequest {
  url: string
  /** Upper case. */
  method: string
  headers: [string, string][]
  body: string | null
}

/** What `fetch` resolves to, before the sandbox wraps it in a Response-like object. */
export interface SandboxFetchResponse {
  status: number
  statusText: string
  /** The final URL, after redirects. */
  url: string
  redirected: boolean
  headers: [string, string][]
  /** The body decoded as UTF-8, like `Response.text()`. */
  body: string
}

/**
 * Executes untrusted user JavaScript. Implementations must expose no Node APIs (no process, require, fs, env).
 * Values crossing the boundary are deep-copied and must be JSON-serializable.
 */
export interface CodeRuntime {
  /** Evaluates a single JS expression (the inside of a `{{ }}`) against `scope`. */
  evalExpression(expression: string, scope: Record<string, unknown>, opts?: RunOptions): Promise<unknown>
  /** Runs a code block body as an async function (may `await`, must `return`) against `scope`. */
  runCode(code: string, scope: Record<string, unknown>, opts?: RunOptions): Promise<unknown>
  dispose(): void
}

/**
 * `unavailable`: Python's executor couldn't be reached, was busy, or couldn't start a jail. `python_packages`: the
 * workflow's Python packages (M23) aren't installed where the code runs.
 */
export type SandboxErrorKind =
  | 'timeout'
  | 'memory'
  | 'runtime'
  | 'syntax'
  | 'serialization'
  | 'unavailable'
  | 'python_packages'

export class SandboxError extends Error {
  constructor(
    readonly kind: SandboxErrorKind,
    message: string,
    readonly userStack?: string,
    /** Where it happened, for Python: `{ line, column?, traceback? }` (they reach the run's error). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}
