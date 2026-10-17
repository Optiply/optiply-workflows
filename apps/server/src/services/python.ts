import {
  type Diagnostic,
  lineColumnOffset,
  type PythonField,
  pythonFields,
  type WorkflowDefinition,
} from '@ow/definition'
import { PythonExecutorClient, type PythonRunner, SandboxError } from '@ow/sandbox'
import type { Config } from '../config'

/**
 * The process's code executor for Python (M12), from PYTHON_EXECUTOR_URL; null when there is none. Set up once at
 * startup (the API and the worker both call `configurePython`), so the checks before runs and publishing can reach
 * it without every caller passing it along.
 */
let runner: PythonRunner | null = null

export function configurePython(config: Pick<Config, 'PYTHON_EXECUTOR_URL' | 'PYTHON_EXECUTOR_TOKEN'>) {
  runner =
    config.PYTHON_EXECUTOR_URL && config.PYTHON_EXECUTOR_TOKEN
      ? new PythonExecutorClient({ url: config.PYTHON_EXECUTOR_URL, token: config.PYTHON_EXECUTOR_TOKEN })
      : null
  return runner
}

/** Why Python is off although configured (a URL without its token), for a warning at start; null otherwise. */
export function pythonConfigWarning(
  config: Pick<Config, 'PYTHON_EXECUTOR_URL' | 'PYTHON_EXECUTOR_TOKEN'>,
): string | null {
  return config.PYTHON_EXECUTOR_URL && !config.PYTHON_EXECUTOR_TOKEN
    ? 'PYTHON_EXECUTOR_URL is set without PYTHON_EXECUTOR_TOKEN: Python code blocks are off'
    : null
}

export function pythonRunner(): PythonRunner | null {
  return runner
}

const UNAVAILABLE = "Python isn't set up on this instance (PYTHON_EXECUTOR_URL and PYTHON_EXECUTOR_TOKEN)"

/**
 * The definition's Python problems: without an executor, every Python field is `python_unavailable` (such a
 * workflow couldn't run). With `syntax` (publishing, rollback, Git deploys), the executor also compiles the fields
 * (nothing runs): a `syntax` diagnostic per broken field at its line and column, or `python_unavailable` when it
 * can't be reached. Runs skip that: a busy executor mustn't refuse them, and a syntax error fails its block anyway.
 */
export async function pythonDiagnostics(
  definition: WorkflowDefinition,
  opts: { syntax: boolean },
): Promise<Diagnostic[]> {
  const fields = pythonFields(definition)
  if (!fields.length) return []
  const unavailable = (message: string) =>
    fields.map(
      (field): Diagnostic => ({ ...where(field), severity: 'error', code: 'python_unavailable', message }),
    )
  if (!runner) return unavailable(UNAVAILABLE)
  if (!opts.syntax) return []
  let problems: Awaited<ReturnType<PythonRunner['check']>>
  try {
    problems = await runner.check(fields.map((f) => ({ id: f.id, code: f.source })))
  } catch (err) {
    if (err instanceof SandboxError) return unavailable(err.message)
    throw err
  }
  const byId = new Map(fields.map((f) => [f.id, f]))
  return problems.flatMap((problem): Diagnostic[] => {
    const field = byId.get(problem.id)
    if (!field) return []
    // Python may point just past the code (an expression cut off at the end): mark the last character then.
    const start = Math.min(
      lineColumnOffset(field.source, problem.line, problem.column),
      Math.max(0, field.source.length - 1),
    )
    return [
      {
        ...where(field),
        severity: 'error',
        code: 'syntax',
        message: `${problem.message} (line ${problem.line})`,
        start,
        end: Math.min(field.source.length, start + 1),
      },
    ]
  })
}

function where(field: PythonField): Pick<Diagnostic, 'path' | 'block' | 'function'> {
  return { path: field.path, block: field.block, ...(field.function && { function: field.function }) }
}
