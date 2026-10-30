import { parseTemplate, renderText, TemplateError } from '@ow/expressions'
import { z } from 'zod'
import {
  buildBody,
  checkHost,
  createHttpClient,
  destroyHttpClient,
  type HttpClient,
  type HttpResponse,
  httpError,
  httpRequest,
  testHttp,
} from './http-core'
import { OAUTH_PROVIDERS } from './oauth-presets'
import { sshConfigSchema, sshSecretsSchema } from './ssh/settings'
import type { Connector, QueryContext, QueryResult } from './types'

const keyValues = z.array(z.object({ key: z.string(), value: z.string() })).default([])

/**
 * One part of a multipart body. A text part's `value` is a template; a file part's `file` is a lone `{{ }}` that
 * evaluates to base64 text or to `{ base64, filename?, contentType? }` (what a webhook delivers), and `filename` and
 * `contentType` (templates) override what the value says.
 */
const multipartPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), key: z.string(), value: z.string().default('') }),
  z.object({
    kind: z.literal('file'),
    key: z.string(),
    file: z.string().default(''),
    filename: z.string().default(''),
    contentType: z.string().default(''),
  }),
])

const bodySchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    /** JSON text with `{{ }}`; see `renderJson`. */
    z.object({ type: z.literal('json'), json: z.string() }),
    z.object({ type: z.literal('form'), fields: keyValues }),
    z.object({ type: z.literal('raw'), raw: z.string(), contentType: z.string().default('text/plain') }),
    /** `multipart/form-data` (M15): text fields, and files from base64 or a webhook's file object. */
    z.object({ type: z.literal('multipart'), parts: z.array(multipartPartSchema).default([]) }),
  ])
  .default({ type: 'none' })

const querySchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  /** Appended to the base URL, or an absolute URL on an allowed host. May contain `{{ }}`. */
  path: z.string().default(''),
  params: keyValues,
  headers: keyValues,
  body: bodySchema,
})

/** Every `{{ }}` template of a REST query (or a custom auth flow's request step). */
function queryTemplates(query: z.output<typeof querySchema>): string[] {
  return [
    query.path,
    ...query.params.map((p) => p.value),
    ...query.headers.map((h) => h.value),
    ...(query.body.type === 'json' ? [query.body.json] : []),
    ...(query.body.type === 'form' ? query.body.fields.map((f) => f.value) : []),
    ...(query.body.type === 'raw' ? [query.body.raw] : []),
    ...(query.body.type === 'multipart'
      ? query.body.parts.flatMap((p) => (p.kind === 'text' ? [p.value] : [p.file, p.filename, p.contentType]))
      : []),
  ]
}

/** Names `auth` and `secrets` are the flow's own; step names must also be JS identifiers (`login.data.token`). */
const stepName = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*$/, 'Use a JavaScript name: letters, digits, _ or $, not starting with a digit')
  .refine((name) => name !== 'auth' && name !== 'secrets', { message: '"auth" and "secrets" are taken' })

/**
 * One step of a custom auth flow. A request is a REST request through the resource (base URL, allowed hosts and
 * network settings, but not its default headers and parameters, which may need `auth`); code runs in the sandbox;
 * a variable becomes `auth.<name>`. Each step's result is in scope for the next ones by its name, with `secrets`
 * (the resource's secret values) and, in a refresh flow, `auth` (the variables it refreshes).
 */
const flowStep = z.discriminatedUnion('type', [
  querySchema.extend({ type: z.literal('request'), name: stepName }),
  z.object({ type: z.literal('code'), name: stepName, code: z.string() }),
  z.object({
    type: z.literal('variable'),
    name: stepName,
    value: z.string(),
    /** Scrubbed from query results like other credentials; off for values that aren't secret (a tenant id). */
    secret: z.boolean().default(true),
  }),
])
export type AuthFlowStep = z.output<typeof flowStep>

const flowSteps = z.array(flowStep).superRefine((steps, ctx) => {
  const seen = new Set<string>()
  steps.forEach((step, i) => {
    if (seen.has(step.name)) {
      ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Another step is named "${step.name}"` })
    }
    seen.add(step.name)
    if (
      step.type === 'request' &&
      (step.method === 'GET' || step.method === 'HEAD') &&
      step.body.type !== 'none'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'body'],
        message: `${step.method} requests can't have a body`,
      })
    }
    const templates =
      step.type === 'request' ? queryTemplates(step) : step.type === 'variable' ? [step.value] : []
    for (const template of templates) {
      try {
        parseTemplate(template)
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err
        ctx.addIssue({ code: 'custom', path: [i], message: err.message })
      }
    }
  })
})

/** An http(s) URL with every `{placeholder}` of a provider preset filled in. */
const oauthUrl = z
  .url({ protocol: /^https?$/ })
  .refine((url) => !/\{\w+\}|%7B\w+%7D/i.test(url), { message: 'Fill in the {placeholders} in the URL' })

const authSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('apiKey'),
      in: z.enum(['header', 'query']).default('header'),
      name: z.string().min(1),
    }),
    z.object({ type: z.literal('bearer') }),
    z.object({ type: z.literal('basic'), username: z.string() }),
    z.object({
      type: z.literal('oauth2ClientCredentials'),
      tokenUrl: z.url({ protocol: /^https?$/ }),
      clientId: z.string().min(1),
      scope: z.string().optional(),
      audience: z.string().optional(),
      /** How the client secret is sent to the token endpoint. */
      clientAuth: z.enum(['body', 'basic']).default('body'),
    }),
    z.object({
      type: z.literal('oauth2AuthorizationCode'),
      /** A preset's quirks (Slack's token response, Entra ID's refresh); `custom` is plain RFC 6749. */
      provider: z.enum(OAUTH_PROVIDERS).default('custom'),
      authorizeUrl: oauthUrl,
      tokenUrl: oauthUrl,
      clientId: z.string().min(1),
      /** As the provider writes them: space-separated for most, comma-separated for Slack. */
      scope: z.string().default(''),
      /** Extra parameters for the consent screen (`access_type=offline`, `prompt=consent`, …). */
      authorizeParams: keyValues,
      clientAuth: z.enum(['body', 'basic']).default('body'),
      pkce: z.boolean().default(true),
      /** One connected account per environment, or each person connects their own. */
      tokens: z.enum(['shared', 'perUser']).default('shared'),
    }),
    z
      .object({
        type: z.literal('custom'),
        /** Signs in; its variable steps become `auth.<name>` in the resource's headers and parameters. */
        steps: flowSteps,
        /** Run when an API answers 401 (then the request is retried once); empty = sign in again with `steps`. */
        refreshSteps: flowSteps.default([]),
        /** How long the variables are good for; omitted = until an API answers 401. */
        ttlSeconds: z.number().int().positive().optional(),
      })
      .superRefine((auth, ctx) => {
        if (!auth.steps.some((s) => s.type === 'variable')) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps'],
            message: 'Define at least one variable for the headers or parameters to use',
          })
        }
      }),
  ])
  .default({ type: 'none' })

const configSchema = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  /**
   * Sent with every request; values are plain text (secret headers belong in the secrets). With a custom auth flow,
   * these and `params` may use `{{ auth.NAME }}`.
   */
  headers: keyValues,
  params: keyValues,
  auth: authSchema,
  /** Hosts besides the base URL's that queries (and redirects) may reach; `*.example.com` allowed. */
  allowedHosts: z.array(z.string().min(1)).default([]),
  /** Allow loopback / private / link-local addresses. Off by default (SSRF guard). */
  allowPrivateNetwork: z.boolean().default(false),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Reach the API through an SSH server (and jump hosts) rather than directly (M17). */
  ssh: sshConfigSchema.optional(),
})

const secretsSchema = z.object({
  apiKey: z.string().optional(),
  bearerToken: z.string().optional(),
  password: z.string().optional(),
  clientSecret: z.string().optional(),
  /** Header name → value, for credentials sent as custom headers. */
  headers: z.record(z.string(), z.string()).default({}),
  /** Named values a custom auth flow reads as `{{ secrets.NAME }}` (a username, a password…). */
  values: z.record(z.string(), z.string()).default({}),
  ssh: sshSecretsSchema.optional(),
})

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>
export type RestConfig = Config
export type RestSecrets = Secrets
export type RestQuery = Query
export type RestAuth = z.output<typeof authSchema>
export {
  authSchema as restAuthSchema,
  bodySchema as restBodySchema,
  configSchema as restConfigSchema,
  keyValues,
  querySchema as restQuerySchema,
  queryTemplates as restQueryTemplates,
  secretsSchema as restSecretsSchema,
}

export const restConnector: Connector<Config, Secrets, Query, HttpClient> = {
  type: 'rest',
  label: 'REST API',
  configSchema,
  secretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    return createHttpClient(config, secrets)
  },

  destroyClient: destroyHttpClient,

  httpConfig: (config) => config,

  async testConnection(client, { signal, credentials }) {
    const res = await testHttp(client, { signal, credentials })
    return { message: `HTTP ${res.status} ${res.statusText}`.trim() }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    for (const template of queryTemplates(query)) {
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
    const { url, params } = await buildUrl(client, query, ctx)
    const res = await httpRequest(
      client,
      {
        method: query.method,
        url,
        params,
        headers: await renderHeaders(query, ctx),
        ...(await buildBody(query, ctx)),
      },
      ctx,
    )
    if (!res.ok) throw httpError(res)
    return { data: res.data, metadata: responseMetadata(res) }
  },
}

/** A response's metadata, as REST queries have always returned it. */
export function responseMetadata(res: HttpResponse): Record<string, unknown> {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    url: res.url,
    durationMs: res.durationMs,
    ...(res.base64 ? { encoding: 'base64' } : {}),
  }
}

/** The query's headers, rendered; a multipart body's Content-Type is left to fetch (it carries the boundary). */
export async function renderHeaders(
  query: Pick<Query, 'headers' | 'body'>,
  ctx: QueryContext,
): Promise<[string, string][]> {
  const headers: [string, string][] = []
  for (const { key, value } of query.headers) {
    if (query.body.type === 'multipart' && key.toLowerCase() === 'content-type') continue
    if (key) headers.push([key, await renderText(value, ctx.evaluate)])
  }
  return headers
}

/** The query's URL (without parameters; checked against the allowed hosts) and its rendered parameters. */
async function buildUrl(
  client: HttpClient,
  query: Query,
  ctx: QueryContext,
): Promise<{ url: URL; params: [string, string][] }> {
  // Untrusted values can't climb out of their segment (`../admin`) or start a query string: each is encoded.
  const evaluate: QueryContext['evaluate'] = ctx.untrustedValues
    ? async (code) => {
        const value = await ctx.evaluate(code)
        if (value === null || value === undefined) return value
        return encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
    : ctx.evaluate
  const path = (await renderText(query.path, evaluate)).trim()
  let url: URL
  if (/^https?:\/\//i.test(path)) {
    url = new URL(path)
  } else {
    const base = client.config.baseUrl.replace(/\/+$/, '')
    url = new URL(path ? `${base}/${path.replace(/^\/+/, '')}` : base)
  }
  checkHost(client, url)
  const params: [string, string][] = []
  for (const { key, value } of query.params) {
    if (key) params.push([key, await renderText(value, ctx.evaluate)])
  }
  return { url, params }
}
