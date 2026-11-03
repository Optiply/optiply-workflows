import { defaultActionQuery, isServiceType } from '@ow/connectors/actions'

/**
 * Resource types whose queries are `{ sql }`; `pubsub`, `sqs` and `kafka` send messages (M19, M26); the rest are HTTP
 * APIs (REST, the built-in REST API, GraphQL, the services: see `queryKind`).
 */
const SQL_TYPES = new Set(['postgres', 'mysql', 'bigquery'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

export type MessageKind = 'pubsub' | 'sqs' | 'kafka'

export function isMessageKind(kind: string | undefined): kind is MessageKind {
  return kind === 'pubsub' || kind === 'sqs' || kind === 'kafka'
}

export type QueryKind = 'sql' | MessageKind | 'rest' | 'restapi' | 'graphql' | 'openapi' | 'service'

/**
 * The shape of a resource type's queries: SQL, a message, REST's request, the built-in REST API's (a full URL and its
 * own auth, M27), GraphQL's, or a service's action (Slack, HubSpot, SendGrid, Google Sheets, M27).
 */
export function queryKind(type: string | undefined): QueryKind {
  if (isSqlType(type)) return 'sql'
  if (isMessageKind(type)) return type
  if (type === 'restapi' || type === 'graphql' || type === 'openapi') return type
  return isServiceType(type) ? 'service' : 'rest'
}

/** The built-in REST API resource's new query (M27). */
export const DEFAULT_RESTAPI_QUERY = {
  method: 'GET',
  url: 'https://',
  params: [],
  headers: [],
  body: { type: 'none' },
  auth: { type: 'none' },
}

/** A GraphQL resource's new query (M27). */
export const DEFAULT_GRAPHQL_QUERY = { query: '{\n  \n}', variables: '', operationName: '', headers: [] }

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
  if (kind === 'restapi') return structuredClone(DEFAULT_RESTAPI_QUERY)
  if (kind === 'graphql') return { ...DEFAULT_GRAPHQL_QUERY, headers: [] }
  if (kind === 'openapi') return { operationId: '', parameters: '{}', body: '', contentType: '' }
  if (kind === 'service' && isServiceType(type)) return defaultActionQuery(type)
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
  restapi: { label: 'API', className: 'bg-op-orange-2 text-op-orange-4' },
  graphql: { label: 'GQL', className: 'bg-op-red-1 text-op-red-4' },
  slack: { label: 'SL', className: 'bg-op-purple-1 text-op-purple-4' },
  hubspot: { label: 'HS', className: 'bg-op-orange-1 text-op-orange-4' },
  sendgrid: { label: 'SG', className: 'bg-op-blue-1 text-op-blue-4' },
  googlesheets: { label: 'GS', className: 'bg-op-green-1 text-op-green-4' },
  s3: { label: 'S3', className: 'bg-op-green-2 text-op-green-4' },
  stripe: { label: 'ST', className: 'bg-op-purple-1 text-op-purple-4' },
  airtable: { label: 'AT', className: 'bg-op-yellow-1 text-op-yellow-4' },
  jira: { label: 'JI', className: 'bg-op-blue-1 text-op-blue-4' },
  notion: { label: 'NO', className: 'bg-op-purple-2 text-op-purple-4' },
  salesforce: { label: 'SF', className: 'bg-op-blue-2 text-op-blue-4' },
  openapi: { label: 'OAS', className: 'bg-op-green-1 text-op-green-4' },
  rabbitmq: { label: 'RMQ', className: 'bg-op-orange-2 text-op-orange-4' },
  sns: { label: 'SNS', className: 'bg-op-red-1 text-op-red-4' },
}
