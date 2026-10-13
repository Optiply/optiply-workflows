import type { WorkflowDefinition } from '@ow/definition'

/** What the last run produced for a block, if anything. */
export interface SampleResult {
  data: unknown
  status: string
}

const MAX_DEPTH = 6
const MAX_KEYS = 100
const SAMPLE_ITEMS = 20

/** A TypeScript type for a JSON value. Array items are merged, so keys missing from some items become optional. */
export function typeOf(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return 'unknown'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      break
    default:
      return 'unknown'
  }
  if (Array.isArray(value)) {
    if (!value.length) return 'unknown[]'
    const items = value.slice(0, SAMPLE_ITEMS)
    const objects = items.filter(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v),
    )
    const others = items.filter((v) => !(v && typeof v === 'object' && !Array.isArray(v)))
    const types = new Set(others.map((v) => typeOf(v, depth + 1)))
    if (objects.length) types.add(mergedObjectType(objects, depth + 1))
    const union = [...types].join(' | ')
    return types.size > 1 ? `(${union})[]` : `${union}[]`
  }
  return mergedObjectType([value as Record<string, unknown>], depth)
}

function mergedObjectType(objects: Record<string, unknown>[], depth: number): string {
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].slice(0, MAX_KEYS)
  if (!keys.length) return 'Record<string, unknown>'
  const fields = keys.map((key) => {
    const present = objects.filter((o) => key in o)
    const types = [...new Set(present.map((o) => typeOf(o[key], depth + 1)))]
    const optional = present.length < objects.length ? '?' : ''
    return `${propertyName(key)}${optional}: ${types.join(' | ')}`
  })
  return `{ ${fields.join('; ')} }`
}

function propertyName(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}

const GLOBALS = `
/** Lodash. */
declare const _: any
/** Day.js, with the utc, timezone, customParseFormat and relativeTime plugins. */
declare const dayjs: any
/** Config vars for the run's environment (secret ones only in released runs). */
declare const configVars: Record<string, string>
declare const workflowContext: { runId: string; workflowId: string; environment: string; triggerType: string }
/** The caller's Idempotency-Key, or the run id. */
declare const idempotencyKey: string
/** In a filter condition: the current item. */
declare const value: any
/** In a filter condition: the current item's index. */
declare const index: number
interface OwBlockError { code: string; message: string; details?: unknown }
`

/**
 * Declarations for every block's result, typed from the last run where there is one, so `query1.data[0].` completes
 * in code. Also returns plain sample values for `{{ }}` completions outside JavaScript.
 */
export function scopeDeclarations(
  def: WorkflowDefinition,
  samples: Record<string, SampleResult>,
): { dts: string; sample: Record<string, unknown> } {
  const lines = [GLOBALS]
  const sample: Record<string, unknown> = {
    _: {},
    dayjs: {},
    configVars: {},
    workflowContext: { runId: '', workflowId: '', environment: '', triggerType: '' },
    idempotencyKey: '',
  }
  for (const block of def.blocks) {
    const result = samples[block.name]
    const data = result ? typeOf(result.data) : 'unknown'
    const extra =
      block.type === 'startTrigger'
        ? ' headers: Record<string, string>; pathParams: Record<string, string>; urlParams: Record<string, string>;'
        : ''
    lines.push(
      `declare const ${block.name}: { data: ${data}; error: OwBlockError | null; metadata: { status: string; [key: string]: unknown };${extra} }`,
    )
    sample[block.name] = {
      data: result?.data ?? null,
      error: null,
      metadata: { status: result?.status ?? '' },
    }
  }
  return { dts: lines.join('\n'), sample }
}
