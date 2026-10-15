import postgres from 'postgres'
import { z } from 'zod'
import { type ColumnInfo, getTable, ManagedDbError, quoteIdent, type TableInfo } from './managed-db'

/**
 * Rows of a managed table, for the grid: reading a page (sorted and filtered), and writing single rows by their
 * primary key. Values travel as JSON without losing anything: bigints and decimals as strings, datetimes as ISO
 * strings in UTC, dates as `YYYY-MM-DD`, JSON as JSON. Writes take the same shapes.
 */

export const PAGE_LIMIT = 500
/** Counting stops here, so a filter over a huge table stays quick; the grid shows "10,000+". */
export const COUNT_LIMIT = 10_000
export const DELETE_LIMIT = 1000

export const FILTER_OPS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'not_contains',
  'starts_with',
  'is_empty',
  'is_not_empty',
] as const

export const RowFilter = z.object({
  column: z.string().min(1).max(63),
  op: z.enum(FILTER_OPS),
  /** Ignored by is_empty / is_not_empty. */
  value: z.string().max(10_000).optional(),
})
export type RowFilter = z.infer<typeof RowFilter>

export const RowQuery = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(PAGE_LIMIT).default(100),
  sort: z
    .array(z.object({ column: z.string().min(1).max(63), desc: z.boolean().default(false) }))
    .max(5)
    .default([]),
  filters: z.array(RowFilter).max(20).default([]),
  /** Whether every filter must match, or any one. */
  match: z.enum(['all', 'any']).default('all'),
})
export type RowQuery = z.infer<typeof RowQuery>

/** A value as the grid sends it. JSON columns take any JSON; the rest a string, number, boolean or null. */
export const CellValue = z.unknown()
export const RowValues = z.record(z.string().min(1).max(63), CellValue)
export type RowValues = z.infer<typeof RowValues>
/** A primary key value: a string (bigints travel as strings) or a number. */
export const RowKey = z.union([z.string().max(1000), z.number()])

export interface RowPage {
  rows: Record<string, unknown>[]
  /** Matching rows, counted up to COUNT_LIMIT. */
  total: number
  /** More than `total` match. */
  more: boolean
}

/** A write Postgres or the column types refused, with the field it's about when there is one. */
export class RowError extends ManagedDbError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super('invalid', field ? `${field}: ${message}` : message)
  }
}

/** How a column is read: in a form JSON keeps exactly. */
function readExpression(column: ColumnInfo, alias = 't'): string {
  const c = `${alias}.${quoteIdent(column.name)}`
  switch (column.type) {
    case 'integer':
    case 'boolean':
      return c
    case 'json':
      // As text, parsed in decodeRow (this client returns jsonb unparsed).
      return `${c}::text`
    case 'datetime':
      // ISO 8601 (to_json), in the session's UTC.
      return `(to_json(${c}) #>> '{}')`
    default:
      // bigint and decimal as text keep their precision; dates, uuids and other types as Postgres prints them.
      return `${c}::text`
  }
}

function selectList(table: TableInfo, alias = 't'): string {
  return table.columns.map((c) => `${readExpression(c, alias)} as ${quoteIdent(c.name)}`).join(', ')
}

/** JSON columns arrive as text; the rest are already in their JSON-exact shape. */
function decodeRow(table: TableInfo, row: postgres.Row): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const c of table.columns) {
    const value = out[c.name]
    if (c.type === 'json' && typeof value === 'string') out[c.name] = JSON.parse(value)
  }
  return out
}

function columnOf(table: TableInfo, name: string): ColumnInfo {
  const column = table.columns.find((c) => c.name === name)
  if (!column) throw new ManagedDbError('invalid', `${table.name} has no column named ${name}`)
  return column
}

/** The table's single-column primary key, which row edits address rows by. */
function keyOf(table: TableInfo): ColumnInfo {
  if (table.primaryKey.length !== 1) {
    throw new ManagedDbError(
      'invalid',
      `${table.name} has ${table.primaryKey.length ? 'a primary key of several columns' : 'no primary key'}, so its rows can't be edited here; use a query`,
    )
  }
  return columnOf(table, table.primaryKey[0]!)
}

/** A value as a query parameter: bound as text and cast to the column's type in SQL. */
function toParam(column: ColumnInfo, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (column.type === 'json') return JSON.stringify(value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  throw new RowError('Expected text, a number or true/false', column.name)
}

/**
 * `$n::text::type`: the parameter, sent as text, cast to the column's own type (Postgres' name for it, from the
 * catalog). Text first, so Postgres does the converting: postgres.js would otherwise convert a parameter it
 * learns is a boolean, date or jsonb with its own rules ('true' becomes false, bad dates throw in JS, JSON is
 * stringified twice).
 */
function cast(column: ColumnInfo, n: number): string {
  return `$${n}::text::${column.sqlType}`
}

export async function readRows(
  tx: postgres.TransactionSql,
  schemaName: string,
  tableName: string,
  query: RowQuery,
): Promise<RowPage & { table: TableInfo }> {
  const table = await getTable(tx, schemaName, tableName)
  const params: unknown[] = []
  const param = (value: unknown) => {
    params.push(value)
    return params.length
  }

  const conditions = query.filters.map((f) => {
    const column = columnOf(table, f.column)
    const c = `t.${quoteIdent(column.name)}`
    const text = `lower(${c}::text)`
    if (f.op === 'is_empty') return `(${c} is null or ${c}::text = '')`
    if (f.op === 'is_not_empty') return `(${c} is not null and ${c}::text <> '')`
    if (f.value === undefined)
      throw new ManagedDbError('invalid', `The filter on ${column.name} needs a value`)
    switch (f.op) {
      case 'contains':
        return `strpos(${text}, lower($${param(f.value)})) > 0`
      case 'not_contains':
        return `(${c} is null or strpos(${text}, lower($${param(f.value)})) = 0)`
      case 'starts_with':
        return `starts_with(${text}, lower($${param(f.value)}))`
      default: {
        const op = { eq: '=', neq: 'is distinct from', lt: '<', lte: '<=', gt: '>', gte: '>=' }[f.op]
        return `${c} ${op} ${cast(column, param(toParam(column, f.value)))}`
      }
    }
  })
  const where = conditions.length ? `where ${conditions.join(query.match === 'all' ? ' and ' : ' or ')}` : ''

  // Sorted as asked, then by the primary key, so pages don't shift between requests.
  const order = query.sort.map(
    (s) => `t.${quoteIdent(columnOf(table, s.column).name)} ${s.desc ? 'desc' : 'asc'} nulls last`,
  )
  for (const k of table.primaryKey) {
    if (!query.sort.some((s) => s.column === k)) order.push(`t.${quoteIdent(k)} asc`)
  }
  const from = `${quoteIdent(schemaName)}.${quoteIdent(table.name)} t`
  const orderBy = order.length ? `order by ${order.join(', ')}` : ''

  try {
    const rows = await tx.unsafe(
      `select ${selectList(table)} from ${from} ${where} ${orderBy} limit ${query.limit} offset ${query.offset}`,
      params as never[],
      { prepare: false },
    )
    const [{ n }] = (await tx.unsafe(
      `select count(*)::int as n from (select 1 from ${from} ${where} limit ${COUNT_LIMIT + 1}) s`,
      params as never[],
      { prepare: false },
    )) as unknown as [{ n: number }]
    return {
      table,
      rows: rows.map((r) => decodeRow(table, r)),
      total: Math.min(n, COUNT_LIMIT),
      more: n > COUNT_LIMIT,
    }
  } catch (err) {
    // A filter value that isn't valid for its column (e.g. "abc" for a number).
    if (err instanceof postgres.PostgresError && err.code.startsWith('22')) throw new RowError(err.message)
    throw err
  }
}

/**
 * Checks each value against its column's type, one savepoint each, so a bad value is reported against its field
 * rather than as the first error of the whole statement.
 */
async function checkValues(tx: postgres.TransactionSql, table: TableInfo, values: RowValues) {
  const entries = Object.entries(values).map(([name, value]) => {
    const column = columnOf(table, name)
    return { column, value: toParam(column, value) }
  })
  for (const e of entries) {
    if (e.value === null) continue
    try {
      // Only whether it converts: the converted value itself isn't read back.
      await tx.savepoint((sp) =>
        sp.unsafe(`select ${cast(e.column, 1)} is null as empty`, [e.value as never], { prepare: false }),
      )
    } catch (err) {
      if (err instanceof postgres.PostgresError) throw new RowError(err.message, e.column.name)
      throw err
    }
  }
  return entries
}

/** Not-null, unique and check violations, about the field they concern when Postgres says which. */
function writeError(err: unknown): unknown {
  if (!(err instanceof postgres.PostgresError)) return err
  if (err.code === '23502') return new RowError('is required', err.column_name)
  if (err.code === '23505') {
    const field = /^Key \(([^)]+)\)=/.exec(err.detail ?? '')?.[1]
    return new RowError(field ? 'must be unique: another row has this value' : err.message, field)
  }
  if (err.code.startsWith('22') || err.code.startsWith('23')) return new RowError(err.detail ?? err.message)
  return err
}

export async function insertRow(
  tx: postgres.TransactionSql,
  schemaName: string,
  tableName: string,
  values: RowValues,
): Promise<Record<string, unknown>> {
  const table = await getTable(tx, schemaName, tableName)
  const entries = await checkValues(tx, table, values)
  const from = `${quoteIdent(schemaName)}.${quoteIdent(table.name)}`
  // Columns left out get their defaults (the id from its identity).
  const statement = entries.length
    ? `insert into ${from} as t (${entries.map((e) => quoteIdent(e.column.name)).join(', ')})
       values (${entries.map((e, i) => cast(e.column, i + 1)).join(', ')}) returning ${selectList(table)}`
    : `insert into ${from} as t default values returning ${selectList(table)}`
  try {
    const [row] = await tx.unsafe(statement, entries.map((e) => e.value) as never[], { prepare: false })
    return decodeRow(table, row!)
  } catch (err) {
    throw writeError(err)
  }
}

export async function updateRow(
  tx: postgres.TransactionSql,
  schemaName: string,
  tableName: string,
  key: string | number,
  values: RowValues,
): Promise<Record<string, unknown>> {
  const table = await getTable(tx, schemaName, tableName)
  const keyColumn = keyOf(table)
  const entries = await checkValues(tx, table, values)
  if (!entries.length) throw new ManagedDbError('invalid', 'Nothing to change')
  const from = `${quoteIdent(schemaName)}.${quoteIdent(table.name)}`
  const params = [...entries.map((e) => e.value), String(key)]
  const statement = `update ${from} as t set ${entries.map((e, i) => `${quoteIdent(e.column.name)} = ${cast(e.column, i + 1)}`).join(', ')}
    where t.${quoteIdent(keyColumn.name)} = ${cast(keyColumn, params.length)} returning ${selectList(table)}`
  let rows: postgres.RowList<postgres.Row[]>
  try {
    rows = await tx.unsafe(statement, params as never[], { prepare: false })
  } catch (err) {
    throw writeError(err)
  }
  if (!rows.length)
    throw new ManagedDbError('not_found', `No row in ${table.name} has ${keyColumn.name} ${key}`)
  return decodeRow(table, rows[0]!)
}

export async function deleteRows(
  tx: postgres.TransactionSql,
  schemaName: string,
  tableName: string,
  keys: (string | number)[],
): Promise<number> {
  const table = await getTable(tx, schemaName, tableName)
  const keyColumn = keyOf(table)
  const from = `${quoteIdent(schemaName)}.${quoteIdent(table.name)}`
  try {
    const rows = await tx.unsafe(
      `delete from ${from} as t where t.${quoteIdent(keyColumn.name)} = any($1::text[]::${keyColumn.sqlType}[]) returning 1`,
      [keys.map(String)] as never[],
      { prepare: false },
    )
    return rows.length
  } catch (err) {
    throw writeError(err)
  }
}
