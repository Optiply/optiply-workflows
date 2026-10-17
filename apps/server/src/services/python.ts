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

export function pythonRunner(): PythonRunner | null {
  return runner
}

const UNAVAILABLE = "Python isn't set up on this instance (PYTHON_EXECUTOR_URL)"

/**
 * The definition's Python syntax errors, from the executor (`compile()` in a jail, nothing runs): a `syntax`
 * diagnostic per broken field, at its line and column. Without an executor, or when it can't be reached, every
 * Python field is `python_unavailable` (such a workflow couldn't run anyway).
 */
export async function pythonDiagnostics(definition: WorkflowDefinition): Promise<Diagnostic[]> {
  const fields = pythonFields(definition)
  if (!fields.length) return []
  const unavailable = (message: string) =>
    fields.map(
      (field): Diagnostic => ({ ...where(field), severity: 'error', code: 'python_unavailable', message }),
    )
  if (!runner) return unavailable(UNAVAILABLE)
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
