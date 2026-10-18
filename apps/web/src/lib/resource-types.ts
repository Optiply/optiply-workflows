/** Resource types whose queries are `{ sql }`; every other type is a REST API. */
const SQL_TYPES = new Set(['postgres', 'mysql', 'bigquery'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

/** How `{{ }}` values appear in each SQL dialect, for hints. */
export const PLACEHOLDERS: Record<string, string> = { postgres: '$1, $2…', mysql: '?', bigquery: '@p1, @p2…' }

/** The short badge and colours for each type, in the resources list and pages. */
export const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  postgres: { label: 'PG', className: 'bg-op-blue-1 text-op-blue-4' },
  mysql: { label: 'MY', className: 'bg-op-green-1 text-op-green-4' },
  bigquery: { label: 'BQ', className: 'bg-op-purple-1 text-op-purple-4' },
  rest: { label: 'API', className: 'bg-op-orange-1 text-op-orange-4' },
}
