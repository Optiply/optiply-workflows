import { defaultActionQuery, isServiceType } from '@ow/connectors/actions'

/**
 * Resource types whose queries are `{ sql }`; the rest are HTTP APIs (REST, the built-in REST API, GraphQL, the
 * services: see `queryKind`).
 */
const SQL_TYPES = new Set(['postgres', 'mysql', 'mssql', 'bigquery', 'jdbc'])

export function isSqlType(type: string | undefined): boolean {
  return type !== undefined && SQL_TYPES.has(type)
}

export type QueryKind = 'sql' | 'rest' | 'restapi' | 'graphql' | 'graphqlapi' | 'openapi' | 'service'

/**
 * The shape of a resource type's queries: SQL, REST's request, the built-in REST API's (a full URL and its
 * own auth, M27), GraphQL's, the built-in GraphQL's (GraphQL's with a URL and auth, session 57), or a service's
 * action (Slack, HubSpot, SendGrid, Google Sheets, M27).
 */
export function queryKind(type: string | undefined): QueryKind {
  if (isSqlType(type)) return 'sql'
  if (type === 'restapi' || type === 'graphql' || type === 'graphqlapi' || type === 'openapi') return type
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

/** The built-in GraphQL resource's new query (session 57): GraphQL's, with the endpoint's URL and its own auth. */
export const DEFAULT_GRAPHQLAPI_QUERY = {
  url: 'https://',
  auth: { type: 'none' },
  ...DEFAULT_GRAPHQL_QUERY,
}

/** A fresh query for a resource of `type` (switching kinds of resource starts one). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function defaultQuery(type: string | undefined, sql = 'select 1'): { [key: string]: Json } {
  const kind = queryKind(type)
  if (kind === 'sql') return { sql }
  if (kind === 'restapi') return structuredClone(DEFAULT_RESTAPI_QUERY)
  if (kind === 'graphql') return { ...DEFAULT_GRAPHQL_QUERY, headers: [] }
  if (kind === 'graphqlapi') return structuredClone(DEFAULT_GRAPHQLAPI_QUERY)
  if (kind === 'openapi') return { operationId: '', parameters: '{}', body: '', contentType: '' }
  if (kind === 'service' && isServiceType(type)) return defaultActionQuery(type)
  return { method: 'GET', path: '', params: [], headers: [], body: { type: 'none' } }
}

/** How `{{ }}` values appear in each SQL dialect, for hints. */
export const PLACEHOLDERS: Record<string, string> = {
  postgres: '$1, $2…',
  mysql: '?',
  mssql: '@p1, @p2…',
  jdbc: '?',
  bigquery: '@p1, @p2…',
}

/** The short badge and colours for each type, in the resources list and pages. */
export const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  postgres: { label: 'PG', className: 'bg-op-blue-1 text-op-blue-4' },
  mysql: { label: 'MY', className: 'bg-op-green-1 text-op-green-4' },
  mssql: { label: 'MS', className: 'bg-op-red-1 text-op-red-4' },
  jdbc: { label: 'JD', className: 'bg-op-orange-1 text-op-orange-4' },
  bigquery: { label: 'BQ', className: 'bg-op-purple-1 text-op-purple-4' },
  rest: { label: 'API', className: 'bg-op-orange-1 text-op-orange-4' },
  restapi: { label: 'API', className: 'bg-op-orange-2 text-op-orange-4' },
  graphql: { label: 'GQL', className: 'bg-op-red-1 text-op-red-4' },
  graphqlapi: { label: 'GQL', className: 'bg-op-red-2 text-op-red-4' },
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
  anthropic: { label: 'AI', className: 'bg-op-orange-2 text-op-orange-4' },
  openai_compatible: { label: 'AI', className: 'bg-op-green-2 text-op-green-4' },
  gemini: { label: 'AI', className: 'bg-op-blue-2 text-op-blue-4' },
  gmail: { label: 'GM', className: 'bg-op-orange-1 text-op-orange-4' },
  msteams: { label: 'MT', className: 'bg-op-blue-1 text-op-blue-4' },
  sdk: { label: 'SDK', className: 'bg-op-green-1 text-op-green-4' },
}
