import { type PoolManager, postgresConnector } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import { type Db, environments, managedDatabases, resourceConfigs, resources } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { z } from 'zod'
import { toResolved } from './resources'

/**
 * The managed database's tables: reading their shape and changing it. Every statement runs as the environment's
 * role, through the same pooled client workflows use, so nothing here can reach past the environment's schema.
 */

/** Column types the schema editor offers, and the Postgres type each one is. */
export const COLUMN_TYPES = {
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamp with time zone',
  json: 'jsonb',
  uuid: 'uuid',
} as const
export type ColumnType = keyof typeof COLUMN_TYPES
const COLUMN_TYPE_IDS = Object.keys(COLUMN_TYPES) as [ColumnType, ...ColumnType[]]

/** Defaults computed by Postgres the editor offers, besides a fixed value. */
export const DEFAULT_EXPRESSIONS = ['now()', 'current_date', 'gen_random_uuid()'] as const

/** The primary key every table made here gets. */
export const ID_COLUMN = 'id'

/** Names for new tables and columns: what a workflow can write without quoting. */
export const NewName = z
  .string()
  .regex(
    /^[a-z_][a-z0-9_]{0,62}$/,
    'Use lowercase letters, digits and underscores (up to 63), not starting with a digit',
  )
  .refine((n) => !n.startsWith('pg_'), 'Names starting with pg_ are reserved by Postgres')
/** Existing tables and columns may have been made in SQL with any name. */
export const ExistingName = z.string().min(1).max(63)

export const ColumnDefault = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('value'), value: z.string().max(10_000) }),
  z.object({ kind: z.literal('expression'), expression: z.enum(DEFAULT_EXPRESSIONS) }),
])
export type ColumnDefault = z.infer<typeof ColumnDefault>

export const ColumnSpec = z.object({
  name: NewName.refine((n) => n !== ID_COLUMN, 'Every table already has an id column'),
  type: z.enum(COLUMN_TYPE_IDS),
  nullable: z.boolean().default(true),
  unique: z.boolean().default(false),
  default: ColumnDefault.default({ kind: 'none' }),
})
export type ColumnSpec = z.infer<typeof ColumnSpec>

/** A column as the editor shows it. Columns made in SQL can have types and defaults the editor doesn't offer. */
export interface ColumnInfo {
  name: string
  type: ColumnType | 'other'
  /** Postgres' own name for the type, e.g. `character varying(20)`. */
  sqlType: string
  nullable: boolean
  unique: boolean
  primaryKey: boolean
  /** Filled in by Postgres (identity), like `id`. */
  identity: boolean
  default: ColumnDefault | { kind: 'other'; expression: string }
}

export interface TableInfo {
  name: string
  columns: ColumnInfo[]
  /** The primary key's columns; rows can only be edited in the grid by a single-column key. */
  primaryKey: string[]
  /** Postgres' estimate (updated by autovacuum); null until it has made one. */
  estimatedRows: number | null
}

/** Something about the managed database the caller should know (not set up, a refused change). */
export class ManagedDbError extends Error {
  override name = 'ManagedDbError'
  constructor(
    readonly code: 'not_ready' | 'invalid' | 'not_found',
    message: string,
  ) {
    super(message)
  }
}

export interface ManagedDbTarget {
  resourceId: string
  environmentId: string
  schemaName: string
}

/** The built-in resource and the environment's schema, or `not_ready` when provisioning hasn't happened. */
export async function managedTarget(db: Db, environmentId: string): Promise<ManagedDbTarget> {
  const [row] = await db
    .select({ resourceId: resources.id, schemaName: managedDatabases.schemaName })
    .from(managedDatabases)
    .innerJoin(environments, eq(environments.id, managedDatabases.environmentId))
    .innerJoin(resources, eq(resources.systemKind, 'database'))
    .where(eq(managedDatabases.environmentId, environmentId))
  if (!row) throw new ManagedDbError('not_ready', 'The database is not set up in this environment yet')
  return { resourceId: row.resourceId, environmentId, schemaName: row.schemaName }
}

/**
 * Runs `fn` in one transaction as the environment's role, in UTC. Schema changes wait at most 5 s for locks (a busy table
 * fails the change rather than stalling everyone queued behind it) and run for at most 2 minutes.
 */
export async function withManagedDb<T>(
  deps: { db: Db; keyring: Keyring; pool: PoolManager },
  target: ManagedDbTarget,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const [config] = await deps.db
    .select()
    .from(resourceConfigs)
    .where(
      and(
        eq(resourceConfigs.resourceId, target.resourceId),
        eq(resourceConfigs.environmentId, target.environmentId),
      ),
    )
  if (!config) throw new ManagedDbError('not_ready', 'The database is not set up in this environment yet')
  return deps.pool.withClient(postgresConnector, toResolved(deps.keyring, config), async (client) => {
    const { sql } = client as { sql: postgres.Sql }
    return sql.begin(async (tx) => {
      // UTC, so datetimes read back as UTC and ones written without an offset are taken as UTC.
      await tx`
        select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '120s', true),
               set_config('TimeZone', 'UTC', true)`
      return fn(tx)
    }) as Promise<T>
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listTables(tx: postgres.TransactionSql, schemaName: string): Promise<TableInfo[]> {
  const tables = await tx<{ oid: number; name: string; reltuples: number }[]>`
    select c.oid::int as oid, c.relname as name, c.reltuples::float8 as reltuples
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relkind in ('r', 'p')
    order by c.relname`
  if (!tables.length) return []
  const oids = tables.map((t) => t.oid)
  const columns = await tx<
    {
      table: number
      name: string
      sql_type: string
      not_null: boolean
      identity: string
      default_expr: string | null
    }[]
  >`
    select a.attrelid::int as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as sql_type,
           a.attnotnull as not_null, a.attidentity as identity, pg_get_expr(d.adbin, d.adrelid) as default_expr
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = any(${oids}::oid[]) and a.attnum > 0 and not a.attisdropped
    order by a.attrelid, a.attnum`
  const constraints = await tx<{ table: number; type: string; columns: string[] }[]>`
    select con.conrelid::int as table, con.contype::text as type,
           array(select a.attname from unnest(con.conkey) k join pg_attribute a
                 on a.attrelid = con.conrelid and a.attnum = k order by array_position(con.conkey, k))::text[] as columns
    from pg_constraint con
    where con.conrelid = any(${oids}::oid[]) and con.contype in ('p', 'u')`

  return tables.map((t) => {
    const keys = constraints.filter((c) => c.table === t.oid)
    const primaryKey = keys.find((k) => k.type === 'p')?.columns ?? []
    const uniqueColumns = new Set(
      keys.filter((k) => k.type === 'u' && k.columns.length === 1).map((k) => k.columns[0]),
    )
    return {
      name: t.name,
      primaryKey,
      estimatedRows: t.reltuples >= 0 ? Math.round(t.reltuples) : null,
      columns: columns
        .filter((c) => c.table === t.oid)
        .map((c) => ({
          name: c.name,
          type: columnType(c.sql_type),
          sqlType: c.sql_type,
          nullable: !c.not_null,
          unique: uniqueColumns.has(c.name) || (primaryKey.length === 1 && primaryKey[0] === c.name),
          primaryKey: primaryKey.includes(c.name),
          identity: c.identity !== '',
          default: parseDefault(c.default_expr),
        })),
    }
  })
}

export async function getTable(
  tx: postgres.TransactionSql,
  schemaName: string,
  table: string,
): Promise<TableInfo> {
  const found = (await listTables(tx, schemaName)).find((t) => t.name === table)
  if (!found) throw new ManagedDbError('not_found', `There's no table named ${table}`)
  return found
}

function columnType(sqlType: string): ColumnType | 'other' {
  for (const [id, pg] of Object.entries(COLUMN_TYPES)) if (pg === sqlType) return id as ColumnType
  // numeric(10,2) is still a decimal.
  if (/^numeric\(\d+(,\d+)?\)$/.test(sqlType)) return 'decimal'
  return 'other'
}

/** A default as Postgres prints it, back into the editor's terms when it can be. */
export function parseDefault(expression: string | null): ColumnInfo['default'] {
  if (expression === null) return { kind: 'none' }
  if ((DEFAULT_EXPRESSIONS as readonly string[]).includes(expression)) {
    return { kind: 'expression', expression: expression as (typeof DEFAULT_EXPRESSIONS)[number] }
  }
  if (expression === 'CURRENT_DATE') return { kind: 'expression', expression: 'current_date' }
  // 'text'::type, as Postgres prints a literal.
  const literal = /^'((?:[^']|'')*)'::[a-z ]+(\(\d+(,\d+)?\))?$/.exec(expression)
  if (literal) return { kind: 'value', value: literal[1]!.replaceAll("''", "'") }
  // Numbers and booleans print bare (negative numbers in parentheses).
  if (/^\(?-?\d+(\.\d+)?\)?$/.test(expression))
    return { kind: 'value', value: expression.replace(/[()]/g, '') }
  if (expression === 'true' || expression === 'false') return { kind: 'value', value: expression }
  return { kind: 'other', expression }
}

// ── Changing ────────────────────────────────────────────────────────────────

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function defaultSql(spec: ColumnDefault, type: ColumnType): string | null {
  if (spec.kind === 'none') return null
  if (spec.kind === 'expression') return spec.expression
  return `${quoteLiteral(spec.value)}::${COLUMN_TYPES[type]}`
}

function columnSql(spec: ColumnSpec): string {
  const parts = [quoteIdent(spec.name), COLUMN_TYPES[spec.type]]
  if (!spec.nullable) parts.push('not null')
  const fallback = defaultSql(spec.default, spec.type)
  if (fallback) parts.push(`default ${fallback}`)
  if (spec.unique) parts.push('unique')
  return parts.join(' ')
}

/** Statements run one by one, never as a multi-statement string. */
async function run(tx: postgres.TransactionSql, statements: string[]): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement, [], { prepare: false })
}

export async function createTable(
  tx: postgres.TransactionSql,
  table: string,
  columns: ColumnSpec[],
): Promise<void> {
  const names = new Set<string>()
  for (const c of columns) {
    if (names.has(c.name)) throw new ManagedDbError('invalid', `Two columns are named ${c.name}`)
    names.add(c.name)
  }
  const definitions = [
    `${quoteIdent(ID_COLUMN)} bigint generated by default as identity primary key`,
    ...columns.map(columnSql),
  ]
  await run(tx, [`create table ${quoteIdent(table)} (${definitions.join(', ')})`])
}

export async function renameTable(tx: postgres.TransactionSql, table: string, to: string): Promise<void> {
  await run(tx, [`alter table ${quoteIdent(table)} rename to ${quoteIdent(to)}`])
}

export async function dropTable(tx: postgres.TransactionSql, table: string): Promise<void> {
  await run(tx, [`drop table ${quoteIdent(table)}`])
}

export async function addColumn(tx: postgres.TransactionSql, table: string, spec: ColumnSpec): Promise<void> {
  await run(tx, [`alter table ${quoteIdent(table)} add column ${columnSql(spec)}`])
}

export async function renameColumn(
  tx: postgres.TransactionSql,
  table: string,
  column: string,
  to: string,
): Promise<void> {
  assertNotKey(column, 'renamed')
  if (to === ID_COLUMN) throw new ManagedDbError('invalid', 'Every table already has an id column')
  await run(tx, [`alter table ${quoteIdent(table)} rename column ${quoteIdent(column)} to ${quoteIdent(to)}`])
}

export async function dropColumn(tx: postgres.TransactionSql, table: string, column: string): Promise<void> {
  assertNotKey(column, 'dropped')
  await run(tx, [`alter table ${quoteIdent(table)} drop column ${quoteIdent(column)}`])
}

export const ColumnChange = z.object({
  type: z.enum(COLUMN_TYPE_IDS).optional(),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: ColumnDefault.optional(),
})
export type ColumnChange = z.infer<typeof ColumnChange>

/**
 * Changes a column's type (existing values are cast; a value that doesn't convert fails the change), whether it
 * may be empty, whether its values must be unique, and its default. All or nothing.
 */
export async function alterColumn(
  tx: postgres.TransactionSql,
  schemaName: string,
  table: string,
  column: string,
  change: ColumnChange,
): Promise<void> {
  assertNotKey(column, 'changed')
  const info = await getTable(tx, schemaName, table)
  const current = info.columns.find((c) => c.name === column)
  if (!current) throw new ManagedDbError('not_found', `${table} has no column named ${column}`)
  if (current.primaryKey)
    throw new ManagedDbError('invalid', `${column} is the primary key: it can't be changed`)

  const t = quoteIdent(table)
  const c = quoteIdent(column)
  const statements: string[] = []
  const typeChanges = change.type !== undefined && change.type !== current.type
  const type = change.type ?? (current.type === 'other' ? undefined : current.type)
  // The old default may not convert to the new type: one the editor understands is dropped first and set again
  // after; one made in SQL is left for Postgres to convert (or refuse).
  const resetDefault = typeChanges && current.default.kind !== 'other'
  const nextDefault = change.default ?? (resetDefault ? current.default : undefined)
  if (resetDefault || change.default) statements.push(`alter table ${t} alter column ${c} drop default`)
  if (typeChanges && change.type) {
    const pg = COLUMN_TYPES[change.type]
    statements.push(
      `alter table ${t} alter column ${c} type ${pg} using ${usingCast(c, current.sqlType, change.type)}`,
    )
  }
  if (change.nullable !== undefined && change.nullable !== current.nullable) {
    statements.push(`alter table ${t} alter column ${c} ${change.nullable ? 'drop' : 'set'} not null`)
  }
  if (nextDefault && nextDefault.kind !== 'none' && nextDefault.kind !== 'other') {
    if (!type) throw new ManagedDbError('invalid', `Choose a type for ${column} before giving it a default`)
    statements.push(`alter table ${t} alter column ${c} set default ${defaultSql(nextDefault, type)}`)
  }
  if (change.unique !== undefined && change.unique !== current.unique) {
    if (change.unique) {
      statements.push(`alter table ${t} add unique (${c})`)
    } else {
      const names = await tx<{ name: string }[]>`
        select con.conname as name from pg_constraint con
        join pg_class r on r.oid = con.conrelid join pg_namespace n on n.oid = r.relnamespace
        where n.nspname = ${schemaName} and r.relname = ${table} and con.contype = 'u'
          and con.conkey = array[(select attnum from pg_attribute where attrelid = r.oid and attname = ${column})]`
      for (const { name } of names) statements.push(`alter table ${t} drop constraint ${quoteIdent(name)}`)
    }
  }
  await run(tx, statements)
}

/** How existing values convert. Booleans from text accept what Postgres does (true/false, yes/no, 1/0, on/off). */
function usingCast(column: string, from: string, to: ColumnType): string {
  const pg = COLUMN_TYPES[to]
  // jsonb has no cast to numbers or booleans except through text; text to jsonb parses the text as JSON.
  if (from === 'jsonb' && to !== 'json' && to !== 'text') return `(${column} #>> '{}')::${pg}`
  // Numbers and booleans to json become JSON numbers and booleans.
  if (to === 'json' && from !== 'text') return `to_jsonb(${column})`
  return `${column}::${pg}`
}

function assertNotKey(column: string, what: string) {
  if (column === ID_COLUMN) throw new ManagedDbError('invalid', `The id column can't be ${what}`)
}
