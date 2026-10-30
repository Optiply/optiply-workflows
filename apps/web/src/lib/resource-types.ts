/**
 * Resource types whose queries are `{ sql }`; `pubsub`, `sqs` and `kafka` send messages (M19, M26); every other type
 * is a REST API.
 */
const SQL_TYPES = new Set(['postgres', 'mysql', 'bigquery'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

export type MessageKind = 'pubsub' | 'sqs' | 'kafka'

export function isMessageKind(kind: string | undefined): kind is MessageKind {
  return kind === 'pubsub' || kind === 'sqs' || kind === 'kafka'
}

/** The shape of a resource type's queries. */
export function queryKind(type: string | undefined): 'sql' | MessageKind | 'rest' {
  if (isSqlType(type)) return 'sql'
  return isMessageKind(type) ? type : 'rest'
}

/**
 * The message queries (Pub/Sub publishes, SQS sends, Kafka produces): the field naming where messages go, and its
 * help; `messages` is JSON with `{{ }}` for each.
 */
export const MESSAGE_QUERIES: Record<
  MessageKind,
  { target: 'topic' | 'queue'; label: string; hint: string; messages: string; messagesHint: string }
> = {
  pubsub: {
    target: 'topic',
    label: 'Topic',
    hint: "Its id in the resource's project, or projects/…/topics/….",
    messages: '{"data": {}}',
    messagesHint:
      'One message or an array of them: {"data": …, "attributes": {…}, "orderingKey": "…"}. Data that isn’t a string is sent as JSON.',
  },
  sqs: {
    target: 'queue',
    label: 'Queue',
    hint: "Its name in the resource's region and account, or its URL.",
    messages: '{"body": {}}',
    messagesHint:
      'One message or an array of them: {"body": …, "attributes": {…}, "groupId": "…", "deduplicationId": "…", "delaySeconds": 0}. A body that isn’t a string is sent as JSON.',
  },
  kafka: {
    target: 'topic',
    label: 'Topic',
    hint: 'The topic’s name.',
    messages: '{"key": "", "value": {}}',
    messagesHint:
      'One message or an array of them: {"key": "…", "value": …, "headers": {…}, "partition": 0}. A value that isn’t a string is sent as JSON; null is a tombstone.',
  },
}

/** A message resource's new query: one message, its payload a JSON object. */
export function defaultMessageQuery(kind: MessageKind): Record<string, string> {
  const q = MESSAGE_QUERIES[kind]
  return { [q.target]: '', messages: q.messages }
}

/** A Pub/Sub resource's new query (M19). */
export const DEFAULT_PUBSUB_QUERY = { topic: '', messages: '{"data": {}}' }

/** A fresh query for a resource of `type` (switching kinds of resource starts one). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function defaultQuery(type: string | undefined, sql = 'select 1'): { [key: string]: Json } {
  const kind = queryKind(type)
  if (kind === 'sql') return { sql }
  if (isMessageKind(kind)) return defaultMessageQuery(kind)
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
  sqs: { label: 'SQS', className: 'bg-op-red-1 text-op-red-4' },
  kafka: { label: 'KF', className: 'bg-op-purple-2 text-op-purple-4' },
}
