import type { PoolManager } from './pool'
import { runQuery } from './run'
import type { AnyConnector, CredentialSource, ResolvedResource } from './types'

// SQL schema loading (session 57): a database resource's tables and columns for the editor's browser and completions.
// Each SQL connector gives one read-only catalog query in its dialect (`schemaSql`), run through the connector itself,
// so it gets the resource's tunnels, sign-in, read-only mode and timeouts like any query.

/** At most this many columns are read; past it the schema says it's cut short. */
export const SQL_SCHEMA_COLUMNS = 20_000

export interface SqlSchemaColumn {
  name: string
  type: string
  nullable: boolean
}

export interface SqlSchemaTable {
  /** The schema, dataset or database the table is in (as the database names it). */
  schema: string
  name: string
  columns: SqlSchemaColumn[]
}

export interface SqlSchema {
  tables: SqlSchemaTable[]
  /** More columns than were read: the browser and completions show what was. */
  truncated: boolean
}

/**
 * A catalog query's rows as tables, in the order read. Rows carry `s`, `t`, `c`, `d`, `n` (schema, table, column, type,
 * nullable), in any case (Oracle and Snowflake fold unquoted names to capitals); nullable as YES/Y/1/true.
 */
export function groupSchema(rows: Record<string, unknown>[], limit: number): SqlSchema {
  const tables: SqlSchemaTable[] = []
  const byKey = new Map<string, SqlSchemaTable>()
  for (const raw of rows.slice(0, limit)) {
    const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]))
    const schema = String(row.s ?? '')
    const name = String(row.t ?? '')
    if (!name) continue
    const key = `${schema}\u0000${name}`
    let table = byKey.get(key)
    if (!table) {
      table = { schema, name, columns: [] }
      byKey.set(key, table)
      tables.push(table)
    }
    const nullable = row.n
    table.columns.push({
      name: String(row.c ?? ''),
      type: String(row.d ?? ''),
      nullable:
        nullable === true ||
        nullable === 1 ||
        ['YES', 'Y', '1', 'TRUE'].includes(String(nullable).toUpperCase()),
    })
  }
  return { tables, truncated: rows.length > limit }
}

/**
 * A resource's tables and columns, by its connector's catalog query; null when the connector has none (an uploaded
 * JDBC driver's dialect is unknown). Fails as a query would (a ConnectorError).
 */
export async function describeSqlSchema(
  pool: PoolManager,
  connector: AnyConnector,
  resource: ResolvedResource,
  opts: { timeoutMs?: number; credentials?: CredentialSource } = {},
): Promise<SqlSchema | null> {
  if (!connector.schemaSql) return null
  const config = connector.configSchema.parse(resource.config) as { maxRows?: number }
  // One more than shown, to tell a cut-short schema; never past the resource's own row limit (it would fail).
  const limit = Math.min(SQL_SCHEMA_COLUMNS, Math.max(1, (config.maxRows ?? Number.POSITIVE_INFINITY) - 1))
  const sql = connector.schemaSql(config, limit + 1)
  if (!sql) return null
  const result = await runQuery(
    pool,
    connector,
    resource,
    { sql },
    {
      evaluate: async () => undefined,
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      ...(opts.credentials && { credentials: opts.credentials }),
      labels: { ow_source: 'schema' },
    },
  )
  const rows = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : []
  return groupSchema(rows, limit)
}
