import { parseTemplate, renderText, TemplateError } from '@ow/expressions'
import { z } from 'zod'
import {
  buildBody,
  createHttpClient,
  destroyHttpClient,
  type HttpClient,
  httpError,
  httpRequest,
} from './http-core'
import {
  type RestConfig,
  renderHeaders,
  responseMetadata,
  restConfigSchema,
  restQuerySchema,
  restQueryTemplates,
  restSecretsSchema,
} from './rest'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from './types'

// The built-in REST API resource (M27, `rest_api`): no settings, any public URL, auth typed per request.

/** A request's own credentials; every value is a template (a workflow reads secrets as `{{ configVars.NAME }}`). */
const requestAuthSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('bearer'), token: z.string().default('') }),
    z.object({
      type: z.literal('basic'),
      username: z.string().default(''),
      password: z.string().default(''),
    }),
    z.object({
      type: z.literal('apiKey'),
      in: z.enum(['header', 'query']).default('header'),
      name: z.string().default(''),
      value: z.string().default(''),
    }),
  ])
  .default({ type: 'none' })

const querySchema = restQuerySchema.omit({ path: true }).extend({
  /** A full http(s) URL; may contain `{{ }}`. */
  url: z.string().default(''),
  auth: requestAuthSchema,
})

type Query = z.output<typeof querySchema>
export type RestApiQuery = Query

/** Instance settings (the server's `REST_API_PRIVATE_HOSTS`): private hosts the built-in resource may still reach. */
let privateHosts: readonly string[] = []

export function configureRestApi(opts: { privateHosts: readonly string[] }): void {
  privateHosts = [...opts.privateHosts]
}

/** Nothing here is used to reach anything: requests name their own hosts. */
const CONFIG: RestConfig = restConfigSchema.parse({ baseUrl: 'https://rest-api.invalid' })

function authTemplates(auth: Query['auth']): string[] {
  switch (auth.type) {
    case 'none':
      return []
    case 'bearer':
      return [auth.token]
    case 'basic':
      return [auth.username, auth.password]
    case 'apiKey':
      return [auth.name, auth.value]
  }
}

/** Scheme and host typed out and ended by a `/`, `?` or `#` before the first `{{ }}` (else a value could extend it). */
const LITERAL_ORIGIN = /^https?:\/\/[^/?#\s{}]+[/?#]/i

export const restApiConnector: Connector<Record<string, never>, Record<string, never>, Query, HttpClient> = {
  type: 'restapi',
  label: 'REST API (built-in)',
  configSchema: z.object({}).transform(() => ({})),
  secretsSchema: z.object({}).transform(() => ({})),
  querySchema,
  scrubResultData: true,

  createClient() {
    return createHttpClient(CONFIG, restSecretsSchema.parse({}), { anyPublicHost: true, privateHosts })
  },

  destroyClient: destroyHttpClient,

  async testConnection() {
    return { message: 'Ready: each query gives its full URL' }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    for (const template of [
      ...restQueryTemplates({ ...query, path: query.url }),
      ...authTemplates(query.auth),
    ]) {
      try {
        parseTemplate(template)
      } catch (err) {
        if (err instanceof TemplateError) errors.push(err)
        else throw err
      }
    }
    if ((query.method === 'GET' || query.method === 'HEAD') && query.body.type !== 'none') {
      errors.push(new TemplateError(`${query.method} requests can't have a body`, 0, 0))
    }
    return errors
  },

  async execute(client, query, ctx): Promise<QueryResult> {
    const url = await buildUrl(query.url, ctx)
    const params: [string, string][] = []
    for (const { key, value } of query.params) {
      if (key) params.push([key, await renderText(value, ctx.evaluate)])
    }
    const headers = await renderHeaders(query, ctx)
    const sensitive: string[] = []
    const auth = query.auth
    if (auth.type === 'bearer') {
      headers.push(['authorization', `Bearer ${await renderText(auth.token, ctx.evaluate)}`])
      sensitive.push('authorization')
    } else if (auth.type === 'basic') {
      const user = await renderText(auth.username, ctx.evaluate)
      const password = await renderText(auth.password, ctx.evaluate)
      headers.push(['authorization', `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`])
      sensitive.push('authorization')
    } else if (auth.type === 'apiKey') {
      const name = (await renderText(auth.name, ctx.evaluate)).trim()
      if (!name) throw new ConnectorError('invalid_query', 'Name the API key’s header or parameter')
      const value = await renderText(auth.value, ctx.evaluate)
      if (auth.in === 'query') params.push([name, value])
      else {
        headers.push([name, value])
        sensitive.push(name)
      }
    }
    const res = await httpRequest(
      client,
      { method: query.method, url, params, headers, sensitive, ...(await buildBody(query, ctx)) },
      ctx,
    )
    if (!res.ok) throw httpError(res)
    return { data: res.data, metadata: responseMetadata(res) }
  },
}

/**
 * The query's URL. An app viewer's values (`untrustedValues`) can't choose the host: the scheme and host must be typed
 * out in the query, and each value fills one encoded segment, as in a REST resource's paths.
 */
async function buildUrl(template: string, ctx: QueryContext): Promise<URL> {
  if (ctx.untrustedValues) {
    const first = parseTemplate(template).find((p) => p.type === 'expression')
    if (first && !LITERAL_ORIGIN.test(template.slice(0, first.start).trim())) {
      throw new ConnectorError(
        'blocked',
        'In apps, type the URL’s scheme and host out (https://api.example.com/…): values can only fill in its path and parameters',
      )
    }
  }
  const evaluate: QueryContext['evaluate'] = ctx.untrustedValues
    ? async (code) => {
        const value = await ctx.evaluate(code)
        if (value === null || value === undefined) return value
        return encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
    : ctx.evaluate
  const text = (await renderText(template, evaluate)).trim()
  if (!/^https?:\/\//i.test(text)) {
    throw new ConnectorError('invalid_query', 'Enter a full URL, starting with https:// or http://')
  }
  try {
    return new URL(text)
  } catch {
    throw new ConnectorError('invalid_query', `"${text.slice(0, 200)}" isn't a valid URL`)
  }
}
