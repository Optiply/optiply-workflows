import type { Block, FunctionDefinition } from '@ow/definition'

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

/** The `sql` helpers, for workflows and apps alike. */
export const SQL_HELPERS = `
/** For SQL queries: a sort column and direction chosen at run time, from a list written in the query. */
declare const sql: {
  /**
   * One of \`columns\` (or \`fallback\` when \`value\` is empty), quoted into the SQL as a column name:
   * \`ORDER BY {{ sql.column(table1.sort?.column, ['name', 'price'], 'id') }}\`. Must be the whole {{ }}, with the
   * columns written as strings; the server checks the value against them.
   */
  column(value: any, columns: string[], fallback?: string): string
  /** \`DESC\` for true or "desc", \`ASC\` for false, "asc" or nothing: \`{{ sql.direction(table1.sort?.desc) }}\`. */
  direction(value: any): 'ASC' | 'DESC'
}
`

const GLOBALS = `
/** Lodash. */
declare const _: any
/** Day.js, with the utc, timezone, customParseFormat and relativeTime plugins. */
declare const dayjs: any
${SQL_HELPERS}
/** Config vars for the run's environment (secret ones only in released runs). */
declare const configVars: Record<string, string>
declare const workflowContext: { runId: string; workflowId: string; environment: string; triggerType: string }
/** The caller's Idempotency-Key, or the run id. */
declare const idempotencyKey: string
/** In a filter condition or a loop: the current item. */
declare const value: any
/** In a filter condition or a loop: the current item's index. */
declare const index: number
interface OwBlockError { code: string; message: string; details?: unknown }
interface OwResponse {
  ok: boolean; status: number; statusText: string; url: string; redirected: boolean
  headers: { get(name: string): string | null; has(name: string): boolean }
  text(): Promise<string>; json(): Promise<any>
}
/** An HTTP request (code only). The body must be a string; private and internal addresses are refused. */
declare function fetch(url: string, init?: { method?: string; headers?: Record<string, string> | [string, string][]; body?: string }): Promise<OwResponse>
`

/**
 * Declarations for every block's result in the open graph, typed from the last run where there is one, so
 * `query1.data[0].` completes in code. Also declares the workflow's functions (`await name(...)`) and, inside a
 * function, its `params`. Returns plain sample values for `{{ }}` completions outside JavaScript too.
 */
export function scopeDeclarations(
  blocks: readonly Block[],
  samples: Record<string, SampleResult>,
  functions: readonly FunctionDefinition[] = [],
  inFunction?: FunctionDefinition,
): { dts: string; sample: Record<string, unknown> } {
  const lines = [GLOBALS]
  for (const fn of functions) {
    const args = (fn.params ?? []).map((p) => `${p.name}?: any`).join(', ')
    lines.push(`/** Calls the ${fn.name} function. */\ndeclare function ${fn.name}(${args}): Promise<any>`)
  }
  if (inFunction) {
    const params = (inFunction.params ?? []).map((p) => `${p.name}: any`).join('; ')
    lines.push(`/** The arguments this function was called with. */\ndeclare const params: { ${params} }`)
  }
  const sample: Record<string, unknown> = {
    _: {},
    dayjs: {},
    sql: {},
    configVars: {},
    workflowContext: { runId: '', workflowId: '', environment: '', triggerType: '' },
    idempotencyKey: '',
  }
  if (inFunction) {
    sample.params = Object.fromEntries((inFunction.params ?? []).map((p) => [p.name, p.testValue ?? null]))
  }
  for (const block of blocks) {
    // Function blocks have no run samples (function calls aren't recorded per block).
    const result = inFunction ? undefined : samples[block.name]
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
