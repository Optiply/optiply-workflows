/** Resource types whose queries are `{ sql }`; `pubsub` publishes (M19); every other type is a REST API. */
const SQL_TYPES = new Set(['postgres', 'mysql', 'bigquery'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

/** The shape of a resource type's queries. */
export function queryKind(type: string | undefined): 'sql' | 'pubsub' | 'rest' {
  if (isSqlType(type)) return 'sql'
  return type === 'pubsub' ? 'pubsub' : 'rest'
}

/** A Pub/Sub resource's new query: one message, its data a JSON object. */
export const DEFAULT_PUBSUB_QUERY = { topic: '', messages: '{"data": {}}' }

/** A fresh query for a resource of `type` (switching kinds of resource starts one). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function defaultQuery(type: string | undefined, sql = 'select 1'): { [key: string]: Json } {
  const kind = queryKind(type)
  if (kind === 'sql') return { sql }
  if (kind === 'pubsub') return { ...DEFAULT_PUBSUB_QUERY }
  return { method: 'GET', path: '', params: [], headers: [], body: { type: 'none' } }
}

/** How `{{ }}` values appear in each SQL dialect, for hints. */
export const PLACEHOLDERS: Record<string, string> = { postgres: '$1, $2…', mysql: '?', bigquery: '@p1, @p2…' }

/** The short badge and colours for each type, in the resources list and pages. */
export const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  postgres: { label: 'PG', className: 'bg-op-blue-1 text-op-blue-4' },
  mysql: { label: 'MY', className: 'bg-op-green-1 text-op-green-4' },
  bigquery: { label: 'BQ', className: 'bg-op-purple-1 text-op-purple-4' },
  rest: { label: 'API', className: 'bg-op-orange-1 text-op-orange-4' },
  pubsub: { label: 'PS', className: 'bg-op-yellow-1 text-op-yellow-4' },
}
