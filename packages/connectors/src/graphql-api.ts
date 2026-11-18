import { scrubSecretsDeep } from '@ow/crypto'
import { parseTemplate, TemplateError } from '@ow/expressions'
import type { IntrospectionQuery } from 'graphql'
import { z } from 'zod'
import { executeGraphql, graphqlIntrospect, graphqlQuerySchema, validateGraphql } from './graphql'
import { destroyHttpClient, type HttpClient } from './http-core'
import { renderHeaders } from './rest'
import {
  applyRequestAuth,
  authTemplates,
  buildUrl,
  builtInHttpClient,
  requestAuthSchema,
  scrubbedFailure,
} from './restapi'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from './types'

// The built-in GraphQL resource (`graphql`, session 57): GraphQL's queries with the built-in REST API's URL and auth
// per request, no settings; any public endpoint (and the instance's REST_API_PRIVATE_HOSTS). Its schema is read per
// endpoint, with the query's own auth (`introspectGraphqlApi`).

const querySchema = graphqlQuerySchema.extend({
  /** The endpoint's full http(s) URL; may contain `{{ }}` (in apps, after a typed-out scheme and host). */
  url: z.string().default(''),
  auth: requestAuthSchema,
})

type Query = z.output<typeof querySchema>
export type GraphqlApiQuery = Query

/** The endpoint, headers and auth of a query, ready to post to; and the credentials to scrub from what comes back. */
async function target(query: Pick<Query, 'url' | 'auth' | 'headers'>, ctx: QueryContext) {
  const url = await buildUrl(query.url, ctx)
  const headers = await renderHeaders({ headers: query.headers }, ctx)
  const params: [string, string][] = []
  const { sensitive, secrets } = await applyRequestAuth(query.auth, ctx, headers, params)
  return { url, headers, params, sensitive, secrets }
}

export const graphqlApiConnector: Connector<
  Record<string, never>,
  Record<string, never>,
  Query,
  HttpClient
> = {
  type: 'graphqlapi',
  label: 'GraphQL (built-in)',
  configSchema: z.object({}).transform(() => ({})),
  secretsSchema: z.object({}).transform(() => ({})),
  querySchema,
  scrubResultData: true,

  createClient: builtInHttpClient,

  destroyClient: destroyHttpClient,

  async testConnection() {
    return { message: 'Ready: each query gives its endpoint’s full URL' }
  },

  validateQuery(query) {
    const errors = validateGraphql(query)
    for (const template of [query.url, ...authTemplates(query.auth)]) {
      try {
        parseTemplate(template)
      } catch (err) {
        if (err instanceof TemplateError) errors.push(err)
        else throw err
      }
    }
    return errors
  },

  async execute(client, query, ctx): Promise<QueryResult> {
    const to = await target(query, ctx)
    try {
      const result = await executeGraphql(client, query, ctx, to.headers, to)
      return scrubSecretsDeep(result, to.secrets) as QueryResult
    } catch (err) {
      if (!(err instanceof ConnectorError)) throw err
      throw scrubbedFailure(err, to.secrets)
    }
  },
}

/**
 * The schema of a query's endpoint, asked with the query's own URL, headers and auth (the editor's completions). Its
 * failures are scrubbed of those credentials like a query's.
 */
export async function introspectGraphqlApi(
  client: HttpClient,
  query: Pick<Query, 'url' | 'auth' | 'headers'>,
  ctx: QueryContext,
): Promise<IntrospectionQuery> {
  const to = await target(querySchema.pick({ url: true, auth: true, headers: true }).parse(query), ctx)
  try {
    return await graphqlIntrospect(client, ctx, to.headers, to)
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err
    throw scrubbedFailure(err, to.secrets)
  }
}
