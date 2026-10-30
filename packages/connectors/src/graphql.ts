import { parseTemplate, renderJson, TemplateError } from '@ow/expressions'
import { GraphQLError, getIntrospectionQuery, type IntrospectionQuery, parse } from 'graphql'
import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, httpError, httpRequest } from './http-core'
import { keyValues, renderHeaders, responseMetadata, restConfigSchema, restSecretsSchema } from './rest'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from './types'

// GraphQL (M27): a REST resource's settings (the endpoint is the base URL), queries posted as `{query, variables}`.

const querySchema = z.object({
  /** The operation text; no `{{ }}` (values go in variables, so nothing is pasted into GraphQL). */
  query: z.string().default(''),
  /** JSON with `{{ }}`, or empty. */
  variables: z.string().default(''),
  /** Which operation to run when the text has several. */
  operationName: z.string().default(''),
  headers: keyValues,
})

type Config = z.output<typeof restConfigSchema>
type Secrets = z.output<typeof restSecretsSchema>
type Query = z.output<typeof querySchema>
export type GraphqlQuery = Query

interface GraphqlResponse {
  data?: unknown
  errors?: { message?: unknown; path?: unknown; locations?: unknown; extensions?: unknown }[]
  extensions?: unknown
}

export const graphqlConnector: Connector<Config, Secrets, Query, HttpClient> = {
  type: 'graphql',
  label: 'GraphQL',
  configSchema: restConfigSchema,
  secretsSchema: restSecretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    return createHttpClient(config, secrets)
  },

  destroyClient: destroyHttpClient,

  httpConfig: (config) => config,

  async testConnection(client, { signal, credentials }) {
    const ctx = { signal, credentials }
    try {
      const schema = await graphqlIntrospect(client, ctx)
      return {
        message: `GraphQL, ${schema.__schema.types.filter((t) => !t.name.startsWith('__')).length} types`,
      }
    } catch (err) {
      // Some servers turn introspection off in production: the endpoint still answers.
      if (!(err instanceof ConnectorError) || err.code !== 'query') throw err
      await post(client, { query: '{ __typename }' }, [], ctx)
      return { message: 'GraphQL (introspection is turned off, so the editor has no schema)' }
    }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    const at = query.query.indexOf('{{')
    if (at >= 0) {
      errors.push(
        new TemplateError(
          'Put values in the variables ($name in the query), not {{ }} in the query',
          at,
          at + 2,
        ),
      )
    } else if (query.query.trim()) {
      try {
        parse(query.query)
      } catch (err) {
        if (!(err instanceof GraphQLError)) throw err
        const pos = err.positions?.[0] ?? 0
        errors.push(new TemplateError(err.message.replace(/^Syntax Error: /, ''), pos, pos + 1))
      }
    }
    for (const template of [query.variables, ...query.headers.map((h) => h.value)]) {
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
    if (!query.query.trim()) throw new ConnectorError('invalid_query', 'Write a query')
    const variables = query.variables.trim() ? await renderJson(query.variables, ctx.evaluate) : undefined
    if (
      variables !== undefined &&
      (variables === null || typeof variables !== 'object' || Array.isArray(variables))
    ) {
      throw new ConnectorError('invalid_query', 'Variables must be a JSON object')
    }
    const { body, res } = await post(
      client,
      {
        query: query.query,
        ...(variables !== undefined && { variables }),
        ...(query.operationName.trim() && { operationName: query.operationName.trim() }),
      },
      await renderHeaders(query, ctx),
      ctx,
    )
    return {
      data: body.data ?? null,
      metadata: {
        ...responseMetadata(res),
        ...(body.extensions !== undefined && { extensions: body.extensions }),
      },
    }
  },
}

/**
 * Posts an operation. A response with `errors` fails with the first one's message and path (all of them, and any
 * partial data, in the details); a non-JSON or non-2xx answer without them fails as REST's.
 */
async function post(
  client: HttpClient,
  payload: { query: string; variables?: unknown; operationName?: string },
  headers: [string, string][],
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
) {
  const res = await httpRequest(
    client,
    {
      method: 'POST',
      url: new URL(client.config.baseUrl),
      headers: [['accept', 'application/graphql-response+json, application/json'], ...headers],
      body: JSON.stringify(payload),
      contentType: 'application/json',
    },
    ctx,
  )
  const body = (res.data !== null && typeof res.data === 'object' ? res.data : null) as GraphqlResponse | null
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const [first] = body.errors
    const path = Array.isArray(first?.path) ? first.path.join('.') : ''
    const message =
      typeof first?.message === 'string' ? first.message : 'The GraphQL server answered with an error'
    throw new ConnectorError('query', path ? `${message} (at ${path})` : message, {
      status: res.status,
      errors: body.errors,
      ...(body.data !== undefined && body.data !== null && { data: body.data }),
    })
  }
  if (!res.ok) throw httpError(res)
  if (!body) {
    throw new ConnectorError('query', "The endpoint didn't answer with GraphQL's JSON", {
      status: res.status,
      body: typeof res.data === 'string' ? res.data.slice(0, 2000) : null,
    })
  }
  return { body, res }
}

/** The endpoint's schema, by the standard introspection query (for the editor's completions and checks). */
export async function graphqlIntrospect(
  client: HttpClient,
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
): Promise<IntrospectionQuery> {
  const { body } = await post(client, { query: getIntrospectionQuery({ descriptions: true }) }, [], ctx)
  const schema = body.data as IntrospectionQuery | undefined
  if (!schema?.__schema?.types)
    throw new ConnectorError('query', 'The endpoint answered introspection without a schema')
  return schema
}
