/** Resource types whose queries are `{ sql }`; every other type is a REST API. */
const SQL_TYPES = new Set(['postgres', 'mysql', 'bigquery'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

/** How `{{ }}` values appear in each SQL dialect, for hints. */
export const PLACEHOLDERS: Record<string, string> = { postgres: '$1, $2…', mysql: '?', bigquery: '@p1, @p2…' }

/** The short badge and colours for each type, in the resources list and pages. */
export const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  postgres: { label: 'PG', className: 'bg-sky-100 text-sky-700' },
  mysql: { label: 'MY', className: 'bg-teal-100 text-teal-700' },
  bigquery: { label: 'BQ', className: 'bg-indigo-100 text-indigo-700' },
  rest: { label: 'API', className: 'bg-warning-soft text-warning-strong' },
}
