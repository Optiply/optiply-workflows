/** Resource types whose queries are `{ sql }`; every other type is a REST API. */
const SQL_TYPES = new Set(['postgres', 'mysql'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

/** The short badge and colours for each type, in the resources list and pages. */
export const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  postgres: { label: 'PG', className: 'bg-sky-100 text-sky-700' },
  mysql: { label: 'MY', className: 'bg-teal-100 text-teal-700' },
  rest: { label: 'API', className: 'bg-amber-100 text-amber-700' },
}
