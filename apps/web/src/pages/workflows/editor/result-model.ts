/** How a block's result is shown in the Data view: a table, a list, key/value rows or a single value. */
export type DataShape =
  | { kind: 'table'; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: 'list'; items: unknown[] }
  | { kind: 'object'; entries: [string, unknown][] }
  | { kind: 'scalar'; value: unknown }

/** Columns come from the first rows' keys, in the order they first appear. */
const COLUMN_SAMPLE = 50

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function shapeOf(value: unknown): DataShape {
  if (Array.isArray(value)) {
    // A table when every item is an object (an empty array is a list).
    if (value.length > 0 && value.every(isPlainObject)) {
      const columns: string[] = []
      const seen = new Set<string>()
      for (const row of value.slice(0, COLUMN_SAMPLE)) {
        for (const key of Object.keys(row)) {
          if (!seen.has(key)) {
            seen.add(key)
            columns.push(key)
          }
        }
      }
      return { kind: 'table', columns, rows: value }
    }
    return { kind: 'list', items: value }
  }
  if (isPlainObject(value)) return { kind: 'object', entries: Object.entries(value) }
  return { kind: 'scalar', value }
}

/** The heading over a result: `array (515)`, `object`, `string`, `null`. */
export function typeLabel(value: unknown): string {
  if (Array.isArray(value)) return `array (${value.length})`
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}

/** A value in one table cell or row: strings as they are, everything else as compact JSON. */
export function cellText(value: unknown, max = 200): string {
  const text =
    typeof value === 'string' ? value : value === undefined ? '' : (JSON.stringify(value) ?? String(value))
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A JSON tree node's summary: `[] 3 items`, `{} 1 key`. */
export function childSummary(value: unknown): string | null {
  if (Array.isArray(value)) return `[] ${value.length} item${value.length === 1 ? '' : 's'}`
  if (isPlainObject(value)) {
    const n = Object.keys(value).length
    return `{} ${n} key${n === 1 ? '' : 's'}`
  }
  return null
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The expression that reads a node from its block: `query1.data[0].name`, `x["first name"]`. With no root, the value
 * is a block's inputs by block name (the Inputs tabs): `code1.data[0].id`.
 */
export function pathExpression(root: string, path: (string | number)[]): string {
  if (!root && typeof path[0] === 'string') return pathExpression(`${path[0]}.data`, path.slice(1))
  return path.reduce<string>(
    (out, key) =>
      typeof key === 'number'
        ? `${out}[${key}]`
        : IDENTIFIER.test(key)
          ? `${out}.${key}`
          : `${out}[${JSON.stringify(key)}]`,
    root,
  )
}

/** Every expandable node's path key under a value, for "expand all" (capped: huge results stay collapsed). */
export function expandablePaths(value: unknown, max = 2000): string[] {
  const out: string[] = []
  const walk = (v: unknown, path: (string | number)[]) => {
    if (out.length >= max) return
    if (Array.isArray(v)) {
      out.push(pathKey(path))
      for (const [i, item] of v.entries()) walk(item, [...path, i])
    } else if (isPlainObject(v)) {
      out.push(pathKey(path))
      for (const [k, item] of Object.entries(v)) walk(item, [...path, k])
    }
  }
  walk(value, [])
  return out
}

export const pathKey = (path: (string | number)[]) => JSON.stringify(path)
