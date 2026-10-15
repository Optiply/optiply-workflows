import { DEFAULT_TASK_OUTCOMES, type TaskField, type TaskOutcome } from './schema'

/** A task field as a person sees it: the block's field with its default already evaluated. */
export interface OpenTaskField extends Omit<TaskField, 'default'> {
  default?: unknown
}

export type TaskSubmission =
  | { ok: true; outcome: string; values: Record<string, unknown> }
  | { ok: false; errors: { field?: string; message: string }[] }

/** The task's outcomes: its own, or a single "Submit". */
export function taskOutcomes(outcomes: readonly TaskOutcome[] | undefined): TaskOutcome[] {
  return outcomes?.length ? [...outcomes] : DEFAULT_TASK_OUTCOMES.map((o) => ({ ...o }))
}

/**
 * Checks what a person submitted against the task's fields and outcomes, the same way in the browser and on the
 * server. Values come back typed: text as strings, numbers as numbers (a numeric string is accepted), checkboxes
 * as booleans, a choice as one of its options; a field left empty is null (an unticked checkbox is false).
 * Unknown fields are refused.
 */
export function checkTaskSubmission(
  fields: readonly OpenTaskField[],
  outcomes: readonly TaskOutcome[] | undefined,
  outcome: string,
  values: Record<string, unknown>,
): TaskSubmission {
  const errors: { field?: string; message: string }[] = []
  if (!taskOutcomes(outcomes).some((o) => o.id === outcome)) {
    errors.push({ message: `"${outcome}" isn't one of this task's outcomes` })
  }
  const known = new Set(fields.map((f) => f.name))
  for (const name of Object.keys(values)) {
    if (!known.has(name)) errors.push({ field: name, message: `This task has no field "${name}"` })
  }
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')
    const fail = (message: string) => errors.push({ field: field.name, message })
    switch (field.type) {
      case 'checkbox':
        if (raw !== undefined && raw !== null && typeof raw !== 'boolean')
          fail(`${field.label} must be yes or no`)
        out[field.name] = raw === true
        if (field.required && raw !== true) fail(`${field.label} must be ticked`)
        continue
      case 'number': {
        if (empty) break
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN
        if (!Number.isFinite(n)) fail(`${field.label} must be a number`)
        else out[field.name] = n
        continue
      }
      case 'select':
        if (empty) break
        if (typeof raw !== 'string' || !field.options?.includes(raw))
          fail(`Choose one of the options for ${field.label}`)
        else out[field.name] = raw
        continue
      default:
        if (empty) break
        if (typeof raw !== 'string') fail(`${field.label} must be text`)
        else out[field.name] = raw
        continue
    }
    // Empty.
    out[field.name] = null
    if (field.required) fail(`${field.label} is required`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, outcome, values: out }
}
