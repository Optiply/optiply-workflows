/**
 * The Table component's logic, apart from React: its columns (configured, or inferred from the data), sorting,
 * the changeset an editable table collects, and turning typed text into values.
 */

import { pageSizeOf, type TableFilter, type TableFilterOp } from '@ow/app-definition'

export type ColumnType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'json'

export interface TableColumn {
  key: string
  label: string
  type: ColumnType
  editable: boolean
  width: number | null
  /** Computed per row from its `value` template (M24): shown, sorted and searched, never edited. */
  computed: boolean
  /** Has a filter in its header when the table's filters are on (M24); `filterable: false` turns it off. */
  filterable: boolean
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
        editable: c.editable === true && typeof c.value !== 'string',
        width: typeof c.width === 'number' && c.width > 0 ? c.width : null,
        computed: typeof c.value === 'string',
        filterable: c.filterable !== false,
      },
    ]
  })
}

/** Identifies a row in the changeset and selection: its primary key, or its position when it has none. */
export function rowKey(row: Row | null | undefined, primaryKey: string, index: number): string {
  const pk = row?.[primaryKey]
  return pk === null || pk === undefined ? `#${index}` : JSON.stringify(pk)
}

/**
 * Identifies a row for selection: its primary key, or (without one) its content, so the same row matches whether it
 * comes from the data or from `selectedRows` (positions differ between the two).
 */
export function selectionKey(row: Row | null | undefined, primaryKey: string): string {
  const pk = row?.[primaryKey]
  return pk === null || pk === undefined ? `row:${JSON.stringify(row ?? null)}` : JSON.stringify(pk)
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

/** The operators a column's filter offers, by its type, with how they read (M24). */
export const FILTER_OPS_BY_TYPE: Record<ColumnType, readonly { op: TableFilterOp; label: string }[]> = {
  text: [
    { op: 'contains', label: 'contains' },
    { op: 'equals', label: 'is' },
    { op: 'notEquals', label: 'is not' },
    { op: 'empty', label: 'is empty' },
    { op: 'notEmpty', label: 'is not empty' },
  ],
  number: [
    { op: 'equals', label: '=' },
    { op: 'notEquals', label: '≠' },
    { op: 'lt', label: '<' },
    { op: 'lte', label: '≤' },
    { op: 'gt', label: '>' },
    { op: 'gte', label: '≥' },
    { op: 'between', label: 'between' },
    { op: 'empty', label: 'is empty' },
  ],
  boolean: [
    { op: 'equals', label: 'is' },
    { op: 'empty', label: 'is empty' },
  ],
  date: [
    { op: 'equals', label: 'on' },
    { op: 'lt', label: 'before' },
    { op: 'gt', label: 'after' },
    { op: 'between', label: 'between' },
    { op: 'empty', label: 'is empty' },
  ],
  datetime: [
    { op: 'lt', label: 'before' },
    { op: 'gt', label: 'after' },
    { op: 'between', label: 'between' },
    { op: 'empty', label: 'is empty' },
  ],
  json: [
    { op: 'contains', label: 'contains' },
    { op: 'empty', label: 'is empty' },
    { op: 'notEmpty', label: 'is not empty' },
  ],
}

/** How a filter reads in its chip: `qty ≥ 3`, `name contains ada`, `day between 2026-01-01 and 2026-01-31`. */
export function filterLabel(filter: TableFilter, label: string): string {
  const type = (filter.type && filter.type in FILTER_OPS_BY_TYPE ? filter.type : 'text') as ColumnType
  const word = FILTER_OPS_BY_TYPE[type].find((o) => o.op === filter.op)?.label ?? filter.op
  if (filter.op === 'empty' || filter.op === 'notEmpty') return `${label} ${word}`
  if (filter.op === 'between' && Array.isArray(filter.value)) {
    return `${label} between ${String(filter.value[0])} and ${String(filter.value[1])}`
  }
  return `${label} ${word} ${String(filter.value ?? '')}`
}

const isEmptyCell = (v: unknown) => v === null || v === undefined || v === ''

/** A value to order by for a column's type: numbers, times for dates, else text. */
function ordinal(value: unknown, type: string | undefined): unknown {
  if (type === 'number') return typeof value === 'number' ? value : Number(value)
  if (type === 'date' || type === 'datetime') {
    const t = Date.parse(String(value))
    return Number.isNaN(t) ? String(value) : t
  }
  if (type === 'boolean') return value === true || value === 'true'
  return value
}

/** Whether a cell passes one filter, as `sql.where` would have the database decide (text compared without case). */
function passes(cell: unknown, filter: TableFilter, type: string | undefined): boolean {
  const value = filter.value
  switch (filter.op) {
    case 'empty':
      return isEmptyCell(cell)
    case 'notEmpty':
      return !isEmptyCell(cell)
    case 'contains':
      return (
        !isEmptyCell(cell) &&
        fold(formatCell(cell, (type as ColumnType) ?? 'text')).includes(fold(String(value ?? '')))
      )
    case 'notEquals':
      return isEmptyCell(cell) || compare(ordinal(cell, type), ordinal(value, type)) !== 0
    case 'between': {
      if (isEmptyCell(cell) || !Array.isArray(value)) return false
      const x = ordinal(cell, type)
      return compare(x, ordinal(value[0], type)) >= 0 && compare(x, ordinal(value[1], type)) <= 0
    }
    default: {
      if (isEmptyCell(cell)) return false
      const c = compare(ordinal(cell, type), ordinal(value, type))
      return filter.op === 'equals'
        ? c === 0
        : filter.op === 'lt'
          ? c < 0
          : filter.op === 'lte'
            ? c <= 0
            : filter.op === 'gt'
              ? c > 0
              : c >= 0
    }
  }
}

/** The positions of the rows passing every filter (a filter on a column the table doesn't have is ignored). */
export function filterRows(rows: Row[], columns: TableColumn[], filters: TableFilter[]): number[] {
  const active = filters.flatMap((f) => {
    const column = columns.find((c) => c.key === f.column)
    return column ? [{ filter: f, type: f.type ?? column.type }] : []
  })
  return rows.flatMap((row, index) =>
    active.every(({ filter, type }) => passes(row?.[filter.column], filter, type)) ? [index] : [],
  )
}

export type Paging = 'scroll' | 'pages' | 'server'

export interface TableView {
  /** The rows to show, with their positions in the data. */
  rows: { row: Row; index: number }[]
  /** Rows matching the filters and the search (before paging); with server paging, `totalRowCount` (null when not given). */
  total: number | null
  /** The page shown, from 0, kept within the pages there are. */
  page: number
  /** How many pages there are; null with server paging and no `totalRowCount`. */
  pageCount: number | null
}

/** Text without case or accents, for searching ("Gómez" matches "gomez"). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
}

/**
 * What the table shows: in the browser (`scroll`, `pages`) the rows whose shown values contain the search text,
 * sorted, then one page of them; with `server` paging the data as it came (a query did all of that).
 */
export function tableView(opts: {
  rows: Row[]
  columns: TableColumn[]
  paging: Paging
  page: number
  pageSize: number
  sort: { key: string; desc: boolean } | null
  searchText: string
  totalRowCount: number | null
  filters?: TableFilter[]
}): TableView {
  // The same as the table's `pagination` (AppModel), so the rows shown and the query's page always agree.
  const size = pageSizeOf(opts.pageSize)
  const asked = Number.isInteger(opts.page) && opts.page > 0 ? opts.page : 0
  if (opts.paging === 'server') {
    const total = opts.totalRowCount !== null && opts.totalRowCount >= 0 ? opts.totalRowCount : null
    return {
      rows: opts.rows.map((row, index) => ({ row, index })),
      total,
      page: asked,
      pageCount: total === null ? null : Math.max(1, Math.ceil(total / size)),
    }
  }
  const needle = fold(opts.searchText.trim())
  // Filters first (M24), then the search, among what's left.
  const filtered = opts.filters?.length
    ? filterRows(opts.rows, opts.columns, opts.filters)
    : opts.rows.map((_, index) => index)
  const matching = needle
    ? filtered.filter((index) =>
        opts.columns.some((col) => fold(formatCell(opts.rows[index]?.[col.key], col.type)).includes(needle)),
      )
    : filtered
  // `sortedRows` numbers the matching rows; map those back to positions in the data.
  const sorted = sortedRows(
    matching.map((i) => opts.rows[i]!),
    opts.sort,
  ).map(({ row, index }) => ({ row, index: matching[index]! }))
  if (opts.paging === 'scroll') return { rows: sorted, total: sorted.length, page: 0, pageCount: 1 }
  const pageCount = Math.max(1, Math.ceil(sorted.length / size))
  const page = Math.min(asked, pageCount - 1)
  return { rows: sorted.slice(page * size, (page + 1) * size), total: sorted.length, page, pageCount }
}
