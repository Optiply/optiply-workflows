import { type PoolManager, postgresConnector } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import { type Db, environments, managedDatabases, resourceConfigs, resources } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { z } from 'zod'
import { atLeast, loadAccess } from './permissions'
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

/**
 * Beyond the plain types, like Retool's presets: `custom` is any Postgres type by name (`sqlType`), and
 * `foreignKey` references another table's key or unique column (`references`), taking that column's type.
 */
export type SpecType = ColumnType | 'custom' | 'foreignKey'
export const SPEC_TYPES = [...COLUMN_TYPE_IDS, 'custom', 'foreignKey'] as [SpecType, ...SpecType[]]

/**
 * A Postgres type as people write it: words, a size or precision in parentheses, array brackets
 * (`varchar(20)`, `timestamp(3) without time zone`, `integer[]`). Nothing that could end the statement; whether
 * the type exists is asked of Postgres.
 */
export const CustomType = z
  .string()
  .trim()
  .max(100)
  .regex(
    /^[a-zA-Z_][a-zA-Z0-9_]*(\s+[a-zA-Z_][a-zA-Z0-9_]*|\s*\(\s*\d+\s*(,\s*\d+\s*)?\))*(\s*\[\d*\])*$/,
    'Write a Postgres type, e.g. varchar(20), smallint, inet or text[]',
  )

/** What happens to a row when the row it references is deleted. */
export const ON_DELETE = ['no action', 'restrict', 'cascade', 'set null'] as const
export type OnDelete = (typeof ON_DELETE)[number]

export const ColumnReference = z.object({
  table: ExistingName,
  column: ExistingName,
  onDelete: z.enum(ON_DELETE).default('no action'),
})
export type ColumnReference = z.infer<typeof ColumnReference>

/** An enum's values (a text column limited to them by a check constraint). */
export const EnumValues = z
  .array(z.string().min(1).max(200))
  .min(1, 'Give the enum at least one value')
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'The enum has the same value twice')

export const ColumnSpec = z
  .object({
    name: NewName.refine((n) => n !== ID_COLUMN, 'Every table already has an id column'),
    type: z.enum(SPEC_TYPES),
    /** The Postgres type, for `custom`. */
    sqlType: CustomType.optional(),
    /** The referenced column, for `foreignKey`. */
    references: ColumnReference.optional(),
    /** Text only: the values it may take. */
    enumValues: EnumValues.optional(),
    /** Integers only: numbered by Postgres (an auto-incrementing ID). */
    identity: z.boolean().optional(),
    nullable: z.boolean().default(true),
    unique: z.boolean().default(false),
    default: ColumnDefault.default({ kind: 'none' }),
  })
  .superRefine((spec, ctx) => {
    const problem = specProblem(spec)
    if (problem) ctx.addIssue({ code: 'custom', message: `${spec.name}: ${problem}` })
  })
export type ColumnSpec = z.infer<typeof ColumnSpec>

/** Which extras go with which type; the same rules for a new column and a change. */
function specProblem(spec: {
  type?: SpecType
  sqlType?: string
  references?: ColumnReference | null
  enumValues?: string[] | null
  identity?: boolean
  default?: ColumnDefault
}): string | null {
  if (spec.type === 'custom' && !spec.sqlType) return 'Write the Postgres type of a custom column'
  if (spec.type !== undefined && spec.type !== 'custom' && spec.sqlType)
    return 'Only a custom column has a type name'
  if (spec.type === 'foreignKey' && !spec.references)
    return 'Choose the table and column a foreign key references'
  if (spec.type !== undefined && spec.type !== 'foreignKey' && spec.references)
    return 'Only a foreign key references a table'
  if (spec.enumValues && spec.type !== undefined && spec.type !== 'text')
    return 'Only a text column can be an enum'
  if (spec.identity) {
    if (spec.type !== 'integer' && spec.type !== 'bigint') return 'Only an integer column can number itself'
    if (spec.default && spec.default.kind !== 'none')
      return 'An auto-incrementing column has no other default'
  }
  return null
}

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
  /** The values a text column is limited to (an enum), or null. */
  enumValues: string[] | null
  /** The column it references (a single-column foreign key), or null. */
  references: ColumnReference | null
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
    readonly code: 'not_ready' | 'invalid' | 'not_found' | 'forbidden',
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
 * The environment's database, for someone with Use on the built-in resource there (admins always). Use is the
 * whole of it: rows, schema and SQL, like Use on any resource, whose queries run with the resource's rights.
 */
export async function authorizeManagedDb(
  db: Db,
  user: { id: string; isAdmin: boolean },
  environmentId: string,
): Promise<ManagedDbTarget> {
  const target = await managedTarget(db, environmentId)
  const [resource] = await db.select().from(resources).where(eq(resources.id, target.resourceId))
  const access = await loadAccess(db, user)
  if (!atLeast(access.level(resource!, environmentId), 'use')) {
    throw new ManagedDbError('forbidden', 'You need use access to the database in this environment')
  }
  return target
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
    // The pool is shared with the playground and workflow queries, and a plain SET there outlasts its
    // transaction: everything this code relies on is set again, for this transaction only. Read write, the
    // schema to work in, ISO dates, UTC (datetimes read back as UTC; ones written without an offset are UTC).
    return sql.begin('read write', async (tx) => {
      await tx`
        select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '120s', true),
               set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, MDY', true),
               set_config('search_path', quote_ident(${target.schemaName}), true)`
      return fn(tx)
    }) as Promise<T>
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The schema's tables, or just `only` (getTable reads one table's catalog rows, not the whole schema's). */
export async function listTables(
  tx: postgres.TransactionSql,
  schemaName: string,
  only?: string,
): Promise<TableInfo[]> {
  const tables = await tx<{ oid: number; name: string; reltuples: number }[]>`
    select c.oid::int as oid, c.relname as name, c.reltuples::float8 as reltuples
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relkind in ('r', 'p')
      and (${only ?? null}::text is null or c.relname = ${only ?? null}::text)
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
  const constraints = await tx<ConstraintRow[]>`
    select con.conrelid::int as table, con.contype::text as type, con.conname as name,
           array(select a.attname from unnest(con.conkey) k join pg_attribute a
                 on a.attrelid = con.conrelid and a.attnum = k order by array_position(con.conkey, k))::text[] as columns,
           case when con.contype = 'c' then pg_get_constraintdef(con.oid) end as definition,
           ref.relname as ref_table,
           (select a.attname from pg_attribute a
            where a.attrelid = con.confrelid and a.attnum = con.confkey[1]) as ref_column,
           con.confdeltype::text as on_delete
    from pg_constraint con
    left join pg_class ref on ref.oid = con.confrelid
    where con.conrelid = any(${oids}::oid[]) and con.contype in ('p', 'u', 'c', 'f')`

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
          enumValues: enumConstraint(keys, c.name)?.values ?? null,
          references: foreignKey(keys, c.name)?.references ?? null,
        })),
    }
  })
}

export async function getTable(
  tx: postgres.TransactionSql,
  schemaName: string,
  table: string,
): Promise<TableInfo> {
  const [found] = await listTables(tx, schemaName, table)
  if (!found) throw new ManagedDbError('not_found', `There's no table named ${table}`)
  return found
}

interface ConstraintRow {
  table: number
  type: string
  name: string
  columns: string[]
  definition: string | null
  ref_table: string | null
  ref_column: string | null
  on_delete: string | null
}

/**
 * The column's enum: a check constraint on it alone, as Postgres prints `check (c = any (array[…]))`. Other
 * checks (made in SQL) aren't read as enums.
 */
function enumConstraint(
  constraints: ConstraintRow[],
  column: string,
): { name: string; values: string[] } | undefined {
  for (const con of constraints) {
    if (con.type !== 'c' || con.columns.length !== 1 || con.columns[0] !== column || !con.definition) continue
    const match = /^CHECK \(\(\(?.+?\)? = ANY \(\(?ARRAY\[(.*)\]\)?(::text\[\])?\)\)\)$/s.exec(con.definition)
    if (!match) continue
    const inner = match[1]!
    const values = [...inner.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1]!.replaceAll("''", "'"))
    // Only when the array is nothing but those literals (no function or other column hiding in it).
    if (values.length && values.map((v) => `'${v.replaceAll("'", "''")}'::text`).join(', ') === inner)
      return { name: con.name, values }
  }
  return undefined
}

const ON_DELETE_CODES: Record<string, OnDelete> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
}

/** The column's foreign key, when it is a single-column one. */
function foreignKey(
  constraints: ConstraintRow[],
  column: string,
): { name: string; references: ColumnReference } | undefined {
  const con = constraints.find(
    (c) => c.type === 'f' && c.columns.length === 1 && c.columns[0] === column && c.ref_table && c.ref_column,
  )
  if (!con) return undefined
  return {
    name: con.name,
    references: {
      table: con.ref_table!,
      column: con.ref_column!,
      onDelete: ON_DELETE_CODES[con.on_delete ?? 'a'] ?? 'no action',
    },
  }
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

function defaultSql(spec: ColumnDefault, pgType: string): string | null {
  if (spec.kind === 'none') return null
  if (spec.kind === 'expression') return spec.expression
  return `${quoteLiteral(spec.value)}::${pgType}`
}

function enumCheck(column: string, values: string[]): string {
  return `check (${quoteIdent(column)} = any (array[${values.map(quoteLiteral).join(', ')}]::text[]))`
}

function referencesSql(ref: ColumnReference): string {
  return `references ${quoteIdent(ref.table)} (${quoteIdent(ref.column)}) on delete ${ref.onDelete}`
}

/**
 * The Postgres type a column of this kind gets: a plain type's, a custom one Postgres knows, or the type of the
 * column a foreign key references (which must be its table's key or unique).
 */
async function pgTypeOf(
  tx: postgres.TransactionSql,
  schemaName: string,
  spec: { type: SpecType; sqlType?: string; references?: ColumnReference | null },
): Promise<string> {
  if (spec.type === 'custom') {
    const [row] = await tx<{ known: boolean }[]>`select to_regtype(${spec.sqlType!}) is not null as known`
    if (!row?.known) throw new ManagedDbError('invalid', `Postgres has no type named ${spec.sqlType}`)
    return spec.sqlType!
  }
  if (spec.type === 'foreignKey') {
    const ref = spec.references!
    const [table] = await listTables(tx, schemaName, ref.table)
    if (!table) throw new ManagedDbError('invalid', `There's no table named ${ref.table} to reference`)
    const target = table.columns.find((c) => c.name === ref.column)
    if (!target) throw new ManagedDbError('invalid', `${ref.table} has no column named ${ref.column}`)
    if (!target.unique) {
      throw new ManagedDbError(
        'invalid',
        `${ref.table}.${ref.column} can't be referenced: it must be the table's key or unique`,
      )
    }
    return target.sqlType
  }
  return COLUMN_TYPES[spec.type]
}

async function columnSql(tx: postgres.TransactionSql, schemaName: string, spec: ColumnSpec): Promise<string> {
  const pgType = await pgTypeOf(tx, schemaName, spec)
  const parts = [quoteIdent(spec.name), pgType]
  if (spec.identity) parts.push('generated by default as identity')
  if (!spec.nullable) parts.push('not null')
  const fallback = spec.identity ? null : defaultSql(spec.default, pgType)
  if (fallback) parts.push(`default ${fallback}`)
  if (spec.unique) parts.push('unique')
  if (spec.enumValues) parts.push(enumCheck(spec.name, spec.enumValues))
  if (spec.references) parts.push(referencesSql(spec.references))
  return parts.join(' ')
}

/** Statements run one by one, never as a multi-statement string. */
async function run(tx: postgres.TransactionSql, statements: string[]): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement, [], { prepare: false })
}

export async function createTable(
  tx: postgres.TransactionSql,
  schemaName: string,
  table: string,
  columns: ColumnSpec[],
): Promise<void> {
  const names = new Set<string>()
  for (const c of columns) {
    if (names.has(c.name)) throw new ManagedDbError('invalid', `Two columns are named ${c.name}`)
    names.add(c.name)
  }
  const definitions = [`${quoteIdent(ID_COLUMN)} bigint generated by default as identity primary key`]
  for (const column of columns) definitions.push(await columnSql(tx, schemaName, column))
  await run(tx, [`create table ${quoteIdent(table)} (${definitions.join(', ')})`])
}

export async function renameTable(tx: postgres.TransactionSql, table: string, to: string): Promise<void> {
  await run(tx, [`alter table ${quoteIdent(table)} rename to ${quoteIdent(to)}`])
}

export async function dropTable(tx: postgres.TransactionSql, table: string): Promise<void> {
  await run(tx, [`drop table ${quoteIdent(table)}`])
}

export async function addColumn(
  tx: postgres.TransactionSql,
  schemaName: string,
  table: string,
  spec: ColumnSpec,
): Promise<void> {
  await run(tx, [`alter table ${quoteIdent(table)} add column ${await columnSql(tx, schemaName, spec)}`])
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

export const ColumnChange = z
  .object({
    type: z.enum(SPEC_TYPES).optional(),
    /** With type `custom`. */
    sqlType: CustomType.optional(),
    /** With type `foreignKey` (or alone, to point an existing foreign key elsewhere); null removes it. */
    references: ColumnReference.nullable().optional(),
    /** The enum's values; null makes it plain text again. */
    enumValues: EnumValues.nullable().optional(),
    nullable: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: ColumnDefault.optional(),
  })
  .superRefine((change, ctx) => {
    const problem = specProblem(change)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
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
  // The type after the change. Choosing the type it already has (a numeric(10,2) staying a decimal) changes nothing.
  let pgType = current.sqlType
  if (change.type !== undefined && !(change.type === current.type && change.type in COLUMN_TYPES)) {
    pgType = await pgTypeOf(tx, schemaName, change as { type: SpecType })
  } else if (change.references) {
    pgType = await pgTypeOf(tx, schemaName, { type: 'foreignKey', references: change.references })
  }
  const retypes = pgType !== current.sqlType

  const constraints = await tx<ConstraintRow[]>`
    select con.conrelid::int as table, con.contype::text as type, con.conname as name,
           array(select a.attname from unnest(con.conkey) k join pg_attribute a
                 on a.attrelid = con.conrelid and a.attnum = k)::text[] as columns,
           case when con.contype = 'c' then pg_get_constraintdef(con.oid) end as definition,
           ref.relname as ref_table,
           (select a.attname from pg_attribute a
            where a.attrelid = con.confrelid and a.attnum = con.confkey[1]) as ref_column,
           con.confdeltype::text as on_delete
    from pg_constraint con
    join pg_class r on r.oid = con.conrelid join pg_namespace n on n.oid = r.relnamespace
    left join pg_class ref on ref.oid = con.confrelid
    where n.nspname = ${schemaName} and r.relname = ${table} and con.contype in ('c', 'f')`
  const enumNow = enumConstraint(constraints, column)
  const keyNow = foreignKey(constraints, column)
  // The enum and the foreign key after the change: given, kept (an enum while the column stays text, a key while
  // the type isn't changed to something else), or gone.
  const enumAfter =
    change.enumValues !== undefined ? change.enumValues : pgType === 'text' ? (enumNow?.values ?? null) : null
  if (enumAfter && pgType !== 'text') throw new ManagedDbError('invalid', 'Only a text column can be an enum')
  const keyAfter =
    change.references !== undefined
      ? change.references
      : change.type !== undefined && change.type !== 'foreignKey'
        ? null
        : (keyNow?.references ?? null)
  // Dropped first (they may not hold through the type change) and added back last, when anything about them changes.
  const enumChanges = retypes || JSON.stringify(enumNow?.values ?? null) !== JSON.stringify(enumAfter)
  const keyChanges = retypes || JSON.stringify(keyNow?.references ?? null) !== JSON.stringify(keyAfter)
  if (enumNow && enumChanges) statements.push(`alter table ${t} drop constraint ${quoteIdent(enumNow.name)}`)
  if (keyNow && keyChanges) statements.push(`alter table ${t} drop constraint ${quoteIdent(keyNow.name)}`)

  // The old default may not convert to the new type: one the editor understands is dropped first and set again
  // after; one made in SQL is left for Postgres to convert (or refuse).
  const resetDefault = retypes && current.default.kind !== 'other'
  const nextDefault = change.default ?? (resetDefault ? current.default : undefined)
  if (resetDefault || change.default) statements.push(`alter table ${t} alter column ${c} drop default`)
  if (retypes) {
    statements.push(
      `alter table ${t} alter column ${c} type ${pgType} using ${usingCast(c, current.sqlType, pgType)}`,
    )
  }
  if (change.nullable !== undefined && change.nullable !== current.nullable) {
    statements.push(`alter table ${t} alter column ${c} ${change.nullable ? 'drop' : 'set'} not null`)
  }
  if (nextDefault && nextDefault.kind !== 'none' && nextDefault.kind !== 'other') {
    statements.push(`alter table ${t} alter column ${c} set default ${defaultSql(nextDefault, pgType)}`)
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
  // Existing values must fit the enum and the reference, or nothing changes.
  if (enumAfter && enumChanges) statements.push(`alter table ${t} add ${enumCheck(column, enumAfter)}`)
  if (keyAfter && keyChanges)
    statements.push(`alter table ${t} add foreign key (${c}) ${referencesSql(keyAfter)}`)
  await run(tx, statements)
}

/** How existing values convert. Booleans from text accept what Postgres does (true/false, yes/no, 1/0, on/off). */
function usingCast(column: string, from: string, to: string): string {
  // jsonb has no cast to numbers or booleans except through text; text to jsonb parses the text as JSON.
  if (from === 'jsonb' && to !== 'jsonb' && to !== 'text') return `(${column} #>> '{}')::${to}`
  // Numbers and booleans to json become JSON numbers and booleans.
  if (to === 'jsonb' && from !== 'text') return `to_jsonb(${column})`
  return `${column}::${to}`
}

function assertNotKey(column: string, what: string) {
  if (column === ID_COLUMN) throw new ManagedDbError('invalid', `The id column can't be ${what}`)
}
