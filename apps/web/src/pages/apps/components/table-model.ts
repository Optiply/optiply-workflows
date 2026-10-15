/**
 * The Table component's logic, apart from React: its columns (configured, or inferred from the data), sorting,
 * the changeset an editable table collects, and turning typed text into values.
 */

export type ColumnType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'json'

export interface TableColumn {
  key: string
  label: string
  type: ColumnType
  editable: boolean
  width: number | null
}

export type Row = Record<string, unknown>

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

/** A column's type from its first non-empty value. */
export function inferType(rows: Row[], key: string): ColumnType {
  for (const row of rows.slice(0, 50)) {
    const v = row?.[key]
    if (v === null || v === undefined) continue
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'object') return 'json'
    if (typeof v === 'string' && DATE.test(v)) return 'date'
    if (typeof v === 'string' && DATETIME.test(v)) return 'datetime'
    return 'text'
  }
  return 'text'
}

const TYPES = new Set<ColumnType>(['text', 'number', 'boolean', 'date', 'datetime', 'json'])

/**
 * The columns to show: the configured ones (`{ key, label?, type?, editable?, hidden?, width? }`, or plain key
 * strings), or every key of the first rows. Entries without a key are skipped.
 */
export function tableColumns(config: unknown, rows: Row[]): TableColumn[] {
  const configured = Array.isArray(config) ? config : []
  const entries: Record<string, unknown>[] = configured.length
    ? configured.flatMap((c) =>
        typeof c === 'string'
          ? [{ key: c }]
          : c && typeof c === 'object'
            ? [c as Record<string, unknown>]
            : [],
      )
    : [...new Set(rows.slice(0, 50).flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))].map(
        (key) => ({ key }),
      )
  return entries.flatMap((c) => {
    if (typeof c.key !== 'string' || !c.key || c.hidden === true) return []
    const type =
      typeof c.type === 'string' && TYPES.has(c.type as ColumnType)
        ? (c.type as ColumnType)
        : inferType(rows, c.key)
    return [
      {
        key: c.key,
        label: typeof c.label === 'string' && c.label ? c.label : c.key,
        type,
        editable: c.editable === true,
        width: typeof c.width === 'number' && c.width > 0 ? c.width : null,
      },
    ]
  })
}

/** Identifies a row in the changeset and selection: its primary key, or its position when it has none. */
export function rowKey(row: Row | null | undefined, primaryKey: string, index: number): string {
  const pk = row?.[primaryKey]
  return pk === null || pk === undefined ? `#${index}` : JSON.stringify(pk)
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? 1 : -1
  const x = typeof a === 'object' ? JSON.stringify(a) : String(a)
  const y = typeof b === 'object' ? JSON.stringify(b) : String(b)
  return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
}

/** The rows with their positions in the data, sorted by one column (empty values last either way). */
export function sortedRows(
  rows: Row[],
  sort: { key: string; desc: boolean } | null,
): { row: Row; index: number }[] {
  const indexed = rows.map((row, index) => ({ row, index }))
  if (!sort) return indexed
  return indexed.sort((p, q) => {
    const a = p.row?.[sort.key]
    const b = q.row?.[sort.key]
    const empty = (v: unknown) => v === null || v === undefined || v === ''
    if (empty(a) || empty(b)) return empty(a) === empty(b) ? p.index - q.index : empty(a) ? 1 : -1
    return (sort.desc ? -compare(a, b) : compare(a, b)) || p.index - q.index
  })
}

/** The changeset entry for a row: its primary key plus the changed fields. */
export function changeFor(changeset: Row[], primaryKey: string, row: Row): Row | undefined {
  const pk = row[primaryKey]
  return pk === undefined
    ? undefined
    : changeset.find((c) => JSON.stringify(c[primaryKey]) === JSON.stringify(pk))
}

/**
 * The changeset after setting one cell. A value back to the original drops the field, and an entry with nothing
 * left but its key drops out. Rows without a primary key can't be changed (there'd be nothing to save them by).
 */
export function applyEdit(
  changeset: Row[],
  primaryKey: string,
  row: Row,
  field: string,
  value: unknown,
): Row[] {
  const pk = row[primaryKey]
  if (pk === undefined || pk === null || field === primaryKey) return changeset
  const same = (c: Row) => JSON.stringify(c[primaryKey]) === JSON.stringify(pk)
  const existing = changeset.find(same) ?? { [primaryKey]: pk }
  const next: Row = { ...existing }
  if (JSON.stringify(value) === JSON.stringify(row[field])) delete next[field]
  else next[field] = value
  const others = changeset.filter((c) => !same(c))
  return Object.keys(next).length > 1 ? [...others, next] : others
}

/** A value as the table shows it. */
export function formatCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return ''
  if (type === 'json' || typeof value === 'object') return JSON.stringify(value)
  if (type === 'datetime' && typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
  }
  return String(value)
}

/** Text for editing a value. */
export function editText(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return ''
  if (type === 'json' || typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** What typed text means for a column's type: `{ value }`, or `{ error }`. Empty text is null. */
export function parseCell(text: string, type: ColumnType): { value: unknown } | { error: string } {
  const t = text.trim()
  if (!t) return { value: null }
  switch (type) {
    case 'number': {
      const n = Number(t.replace(',', '.'))
      return Number.isFinite(n) ? { value: n } : { error: 'Expected a number' }
    }
    case 'boolean':
      if (/^(true|yes|1)$/i.test(t)) return { value: true }
      if (/^(false|no|0)$/i.test(t)) return { value: false }
      return { error: 'Expected true or false' }
    case 'date':
      return DATE.test(t) ? { value: t } : { error: 'Expected a date as YYYY-MM-DD' }
    case 'json':
      try {
        return { value: JSON.parse(t) }
      } catch {
        return { error: 'Expected JSON' }
      }
    default:
      return { value: text }
  }
}
