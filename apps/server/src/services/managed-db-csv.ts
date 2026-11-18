import postgres from 'postgres'
import { z } from 'zod'
import { csvField } from './audit-log'
import { type CsvRecord, DELIMITERS, fromDecimalComma } from './csv'
import {
  COLUMN_TYPES,
  type ColumnInfo,
  createTable,
  ExistingName,
  getTable,
  ID_COLUMN,
  ManagedDbError,
  NewName,
  quoteIdent,
  type TableInfo,
} from './managed-db'
import { cast, type RowSelection, readExpression, selectionSql, writeError } from './managed-db-rows'

/** Per import: the most rows, and the most bytes (checked by the route as the file streams in). */
export const IMPORT_MAX_ROWS = 500_000
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024
/**
 * A batch also goes in once its values reach this many characters, not only at its row count: a batch is held a few
 * times over while it's sent (the values, the statement's parameters, the driver's message, and Postgres's copy), so
 * 1,000 rows of big JSON documents would make one statement of tens of MB on a 1 GB server. A bigger row goes alone.
 * (The 26 MB file that crashed production on 2026-11-17 ran out of memory in the parser: see `CsvParser.push`.)
 */
export const IMPORT_BATCH_CHARS = 2_000_000
/** Problems reported at once: enough to fix a file in one go, not so many the message is useless. */
const MAX_REPORTED = 20

const COLUMN_TYPE_IDS = Object.keys(COLUMN_TYPES) as [
  keyof typeof COLUMN_TYPES,
  ...(keyof typeof COLUMN_TYPES)[],
]

/**
 * How to import a file. `columns` lists the file's columns to take (by position) and where each goes: in `create`
 * mode, the new table's columns (a column named `id` fills the table's own id); in `append` mode, the existing
 * table's columns. Columns not listed are skipped.
 */
export const ImportSpec = z
  .object({
    environmentId: z.uuid(),
    mode: z.enum(['create', 'append']),
    table: ExistingName,
    delimiter: z.enum(DELIMITERS),
    /** The first record holds column names, not data. */
    header: z.boolean().default(true),
    /** How dates like 03/04/2026 read. */
    dateOrder: z.enum(['DMY', 'MDY', 'YMD']).default('DMY'),
    /** Numbers are written 1.234,56. */
    decimalComma: z.boolean().default(false),
    columns: z
      .array(
        z.object({
          source: z.number().int().min(0),
          name: ExistingName,
          type: z.enum(COLUMN_TYPE_IDS).optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .superRefine((spec, ctx) => {
    if (spec.mode !== 'create') return
    if (!NewName.safeParse(spec.table).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['table'],
        message: 'Use lowercase letters, digits and underscores',
      })
    }
    for (const [i, c] of spec.columns.entries()) {
      if (!NewName.safeParse(c.name).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', i, 'name'],
          message: `${c.name} isn't a valid column name`,
        })
      }
      if (!c.type) ctx.addIssue({ code: 'custom', path: ['columns', i, 'type'], message: 'Choose a type' })
      if (c.name === ID_COLUMN && c.type !== 'integer' && c.type !== 'bigint') {
        ctx.addIssue({ code: 'custom', path: ['columns', i, 'type'], message: 'id holds whole numbers' })
      }
    }
  })
export type ImportSpec = z.infer<typeof ImportSpec>

export interface ImportProblem {
  line: number
  column?: string
  message: string
}

/** An import that didn't happen, with what to fix. Nothing was written. */
export class ImportError extends ManagedDbError {
  constructor(readonly problems: ImportProblem[]) {
    super(
      'invalid',
      problems.map((p) => `Line ${p.line}${p.column ? `, ${p.column}` : ''}: ${p.message}`).join('\n'),
    )
  }
}

interface Target {
  source: number
  column: ColumnInfo
}

/**
 * Imports records into a new or existing table, in one transaction: either every row goes in or none does. Rows go
 * in batches; a batch Postgres refuses is gone through row by row (and a failing row value by value) to say which
 * line and column are wrong. A file `id` column fills the id, and the id counter then continues after the highest.
 */
export async function importCsv(
  tx: postgres.TransactionSql,
  schemaName: string,
  spec: ImportSpec,
  records: AsyncIterable<CsvRecord>,
): Promise<{ table: TableInfo; rows: number }> {
  await tx`select set_config('DateStyle', ${`ISO, ${spec.dateOrder}`}, true)`
  const names = new Set<string>()
  for (const c of spec.columns) {
    if (names.has(c.name)) throw new ManagedDbError('invalid', `Two columns are named ${c.name}`)
    names.add(c.name)
  }
  if (spec.mode === 'create') {
    await createTable(
      tx,
      schemaName,
      spec.table,
      spec.columns
        .filter((c) => c.name !== ID_COLUMN)
        .map((c) => ({
          name: c.name,
          type: c.type!,
          nullable: true,
          unique: false,
          default: { kind: 'none' },
        })),
    )
  }
  const table = await getTable(tx, schemaName, spec.table)
  const targets: Target[] = spec.columns.map((c) => {
    const column = table.columns.find((t) => t.name === c.name)
    if (!column) throw new ManagedDbError('invalid', `${table.name} has no column named ${c.name}`)
    return { source: c.source, column }
  })
  const into = `${quoteIdent(schemaName)}.${quoteIdent(table.name)}`
  const columnList = targets.map((t) => quoteIdent(t.column.name)).join(', ')
  // Postgres takes at most 65,535 parameters a statement.
  const batchSize = Math.max(1, Math.min(1000, Math.floor(30_000 / targets.length)))

  let expected: number | undefined
  let count = 0
  let batch: { line: number; values: (string | null)[] }[] = []
  let batchChars = 0
  const flush = async () => {
    if (!batch.length) return
    const rows = batch
    batch = []
    batchChars = 0
    try {
      await tx.savepoint((sp) => insertWith(sp, rows))
    } catch (err) {
      if (!(err instanceof postgres.PostgresError)) throw err
      throw new ImportError(await diagnose(tx, into, columnList, targets, rows, err))
    }
  }
  // In a savepoint (through its handle), so a refused batch can be rolled back and gone through row by row.
  const insertWith = async (sp: postgres.TransactionSql, rows: typeof batch) => {
    const placeholders = rows.map(
      (_, r) => `(${targets.map((t, c) => cast(t.column, r * targets.length + c + 1)).join(', ')})`,
    )
    await sp.unsafe(
      `insert into ${into} (${columnList}) values ${placeholders.join(', ')}`,
      rows.flatMap((r) => r.values) as never[],
      { prepare: false },
    )
  }

  let first = true
  for await (const record of records) {
    if (first) {
      first = false
      expected = record.fields.length
      // A column the file doesn't have would import as all NULL: a stale or wrong spec.
      const beyond = targets.find((t) => t.source >= record.fields.length)
      if (beyond) {
        throw new ImportError([
          {
            line: record.line,
            column: beyond.column.name,
            message: `takes the file's column ${beyond.source + 1}, but the file has ${record.fields.length}`,
          },
        ])
      }
      if (spec.header) continue
    }
    if (record.fields.length !== expected) {
      throw new ImportError([
        {
          line: record.line,
          message: `${record.fields.length} values, but the ${spec.header ? 'header has' : 'first row has'} ${expected}`,
        },
      ])
    }
    if (++count > IMPORT_MAX_ROWS) {
      throw new ManagedDbError(
        'invalid',
        `The file has more than ${IMPORT_MAX_ROWS.toLocaleString('en')} rows: split it into smaller files`,
      )
    }
    const values = targets.map((t) => toValue(record.fields[t.source], t.column, spec))
    batch.push({ line: record.line, values })
    for (const v of values) batchChars += v?.length ?? 0
    if (batch.length >= batchSize || batchChars >= IMPORT_BATCH_CHARS) await flush()
  }
  await flush()
  if (first) throw new ManagedDbError('invalid', 'The file is empty')

  // Ids from the file: new rows' ids continue after the highest.
  if (targets.some((t) => t.column.identity)) {
    for (const t of targets.filter((x) => x.column.identity)) {
      await tx.unsafe(
        `select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${quoteIdent(t.column.name)}) from ${into}), 0) + 1, false)`,
        [into, t.column.name],
        { prepare: false },
      )
    }
  }
  return { table: await getTable(tx, schemaName, table.name), rows: count }
}

/** A CSV value as a parameter: empty is null; numbers, dates and booleans are trimmed; decimal commas converted. */
function toValue(raw: string | undefined, column: ColumnInfo, spec: ImportSpec): string | null {
  if (raw === undefined || raw === '') return null
  if (column.type === 'text' || column.type === 'other' || column.type === 'json') return raw
  const value = raw.trim()
  if (value === '') return null
  if (
    spec.decimalComma &&
    (column.type === 'decimal' || column.type === 'integer' || column.type === 'bigint')
  ) {
    return fromDecimalComma(value)
  }
  return value
}

/** Finds the rows (up to MAX_REPORTED) in a refused batch, and in each the value, that Postgres refuses. */
async function diagnose(
  tx: postgres.TransactionSql,
  into: string,
  columnList: string,
  targets: Target[],
  rows: { line: number; values: (string | null)[] }[],
  batchError: postgres.PostgresError,
): Promise<ImportProblem[]> {
  const problems: ImportProblem[] = []
  for (const row of rows) {
    if (problems.length >= MAX_REPORTED) break
    try {
      await tx.savepoint((sp) =>
        sp.unsafe(
          `insert into ${into} (${columnList}) values (${targets.map((t, c) => cast(t.column, c + 1)).join(', ')})`,
          row.values as never[],
          { prepare: false },
        ),
      )
    } catch (err) {
      if (!(err instanceof postgres.PostgresError)) throw err
      problems.push(await explain(tx, targets, row, err))
    }
  }
  // Nothing failed on its own: rows clash with each other (e.g. two equal values in a unique column).
  if (!problems.length) {
    const mapped = writeError(batchError)
    problems.push({
      line: rows[0]!.line,
      message: mapped instanceof Error ? mapped.message : batchError.message,
    })
  }
  return problems
}

async function explain(
  tx: postgres.TransactionSql,
  targets: Target[],
  row: { line: number; values: (string | null)[] },
  err: postgres.PostgresError,
): Promise<ImportProblem> {
  // A value that doesn't convert: try each on its own to name it.
  if (err.code.startsWith('22')) {
    for (const [i, t] of targets.entries()) {
      if (row.values[i] === null) continue
      try {
        await tx.savepoint((sp) =>
          sp.unsafe(`select ${cast(t.column, 1)} is null`, [row.values[i]] as never[], { prepare: false }),
        )
      } catch (e) {
        if (e instanceof postgres.PostgresError)
          return { line: row.line, column: t.column.name, message: e.message }
        throw e
      }
    }
  }
  if (err.code === '23502') return { line: row.line, column: err.column_name, message: 'is required' }
  if (err.code === '23505') {
    const column = /^Key \(([^)]+)\)=/.exec(err.detail ?? '')?.[1]
    return { line: row.line, column, message: 'must be unique: another row has this value' }
  }
  return { line: row.line, message: err.detail ? `${err.message} (${err.detail})` : err.message }
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Streams a table (as filtered and sorted in the grid) as CSV: a header of column names, then rows, in the same
 * forms the grid shows. Text cells a spreadsheet would run as a formula get a leading `'`; numbers, dates and the
 * like are written as they are, so a negative number stays a number. `write` returns false to stop (the client
 * went away). Returns the number of rows written.
 */
export async function exportCsv(
  tx: postgres.TransactionSql,
  schemaName: string,
  tableName: string,
  selection: RowSelection,
  write: (chunk: string) => Promise<boolean>,
): Promise<number> {
  const table = await getTable(tx, schemaName, tableName)
  const { from, where, orderBy, params } = selectionSql(schemaName, table, selection)
  const list = table.columns
    .map((c, i) => `${c.type === 'json' ? `t.${quoteIdent(c.name)}::text` : readExpression(c)} as c${i}`)
    .join(', ')
  const guarded = table.columns.map((c) => c.type === 'text' || c.type === 'other' || c.type === 'json')
  const line = (row: postgres.Row) =>
    `${table.columns.map((_, i) => (guarded[i] ? csvField(row[`c${i}`]) : plainField(row[`c${i}`]))).join(',')}\r\n`
  const batches = tx
    .unsafe(`select ${list} from ${from} ${where} ${orderBy}`, params as never[], { prepare: false })
    .cursor(1000)
    [Symbol.asyncIterator]()
  // The first batch before anything is written: a bad filter fails while an error can still be the response.
  let next = await batches.next()
  if (!(await write(`${table.columns.map((c) => csvField(c.name)).join(',')}\r\n`))) {
    await batches.return?.()
    return 0
  }
  let rows = 0
  while (!next.done) {
    rows += next.value.length
    if (!(await write(next.value.map(line).join('')))) {
      await batches.return?.()
      break
    }
    next = await batches.next()
  }
  return rows
}

/** A field with RFC 4180 quoting only: numbers, dates and booleans can't hold formulas. */
function plainField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
