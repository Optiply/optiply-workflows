export type LogLevel = 'log' | 'info' | 'warn' | 'error'

export interface RunOptions {
  /** Wall-clock limit; the isolate is disposed when exceeded (also kills async infinite loops). */
  timeoutMs?: number
  /** Receives console.* calls from user code. Arguments are JSON-safe copies. */
  onLog?: (level: LogLevel, args: unknown[]) => void
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

export type SandboxErrorKind = 'timeout' | 'memory' | 'runtime' | 'syntax' | 'serialization'

export class SandboxError extends Error {
  constructor(
    readonly kind: SandboxErrorKind,
    message: string,
    readonly userStack?: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}
