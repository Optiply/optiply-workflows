import { parseTemplate, renderJson, renderTemplate, renderText, TemplateError } from '@ow/expressions'
import { Agent, FormData, fetch, Headers, type Response } from 'undici'
import { z } from 'zod'
import { networkError, readBody } from './http'
import { guardedLookup, hostMatches, isPrivateAddress } from './net-guard'
import { clientCredentialsToken } from './oauth'
import { OAUTH_PROVIDERS } from './oauth-presets'
import { sshConfigSchema, sshSecretsSchema } from './ssh/settings'
import {
  type Connector,
  ConnectorError,
  type CredentialSource,
  type QueryContext,
  type QueryResult,
} from './types'

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

interface Client {
  config: Config
  secrets: Secrets
  agent: Agent
  token?: { value: string; expiresAt: number }
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ERROR_BODY_PREVIEW = 2000

export const restConnector: Connector<Config, Secrets, Query, Client> = {
  type: 'rest',
  label: 'REST API',
  configSchema,
  secretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    const agent = new Agent({
      connections: 32,
      connect: config.allowPrivateNetwork ? {} : { lookup: guardedLookup },
    })
    return { config, secrets, agent }
  },

  async destroyClient({ agent }) {
    await agent.close()
  },

  async testConnection(client, { signal, credentials }) {
    if (client.config.auth.type === 'oauth2ClientCredentials') await getToken(client, signal, true)
    const attempt = await prepareAttempt(client, { signal, credentials })
    const url = attemptUrl(new URL(client.config.baseUrl), attempt, [])
    const res = await send(
      client,
      url,
      { method: 'GET', headers: attemptHeaders(client, attempt, []) },
      signal,
      attempt.sensitive,
    )
    await res.body?.cancel()
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
    const queryHeaders: [string, string][] = []
    for (const { key, value } of query.headers) {
      // A multipart body's Content-Type carries its boundary: fetch sets it.
      if (query.body.type === 'multipart' && key.toLowerCase() === 'content-type') continue
      if (key) queryHeaders.push([key, await renderText(value, ctx.evaluate)])
    }
    const { body, contentType } = await buildBody(query, ctx)

    const started = performance.now()
    const request = async (force = false) => {
      const attempt = await prepareAttempt(client, ctx, force)
      return send(
        client,
        attemptUrl(url, attempt, params),
        { method: query.method, headers: attemptHeaders(client, attempt, queryHeaders, contentType), body },
        ctx.signal,
        attempt.sensitive,
      )
    }
    let res = await request()
    // An expired or revoked OAuth token, or a custom flow's session: get fresh ones and retry once.
    const authType = client.config.auth.type
    if (
      res.status === 401 &&
      (authType === 'oauth2ClientCredentials' ||
        authType === 'oauth2AuthorizationCode' ||
        authType === 'custom')
    ) {
      await res.body?.cancel()
      client.token = undefined
      res = await request(true)
    }

    const metadata = {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers),
      url: res.url || url.toString(),
      durationMs: Math.round(performance.now() - started),
    }
    if (query.method === 'HEAD') {
      await res.body?.cancel()
      return { data: null, metadata }
    }
    const raw = await readBody(res, client.config.maxResponseBytes)
    const data = decodeBody(raw, res.headers.get('content-type'))
    if (!res.ok) {
      const preview = typeof data.value === 'string' ? data.value : JSON.stringify(data.value)
      throw new ConnectorError('http', `HTTP ${res.status} ${res.statusText}`.trim(), {
        status: res.status,
        body: preview?.slice(0, ERROR_BODY_PREVIEW),
      })
    }
    return { data: data.value, metadata: { ...metadata, ...(data.base64 ? { encoding: 'base64' } : {}) } }
  },
}

/** The query's URL (without parameters; checked against the allowed hosts) and its rendered parameters. */
async function buildUrl(
  client: Client,
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
  checkHost(client.config, url)
  const params: [string, string][] = []
  for (const { key, value } of query.params) {
    if (key) params.push([key, await renderText(value, ctx.evaluate)])
  }
  return { url, params }
}

/** The body and the content type it implies (used unless a header sets one). */
async function buildBody(
  query: Query,
  ctx: QueryContext,
): Promise<{ body?: string | FormData; contentType?: string }> {
  const body = query.body
  switch (body.type) {
    case 'none':
      return {}
    case 'json':
      return {
        body: JSON.stringify(await renderJson(body.json, ctx.evaluate)),
        contentType: 'application/json',
      }
    case 'form': {
      const form = new URLSearchParams()
      for (const { key, value } of body.fields)
        if (key) form.append(key, await renderText(value, ctx.evaluate))
      return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' }
    }
    case 'raw':
      return { body: await renderText(body.raw, ctx.evaluate), contentType: body.contentType }
    case 'multipart': {
      // No content type here: fetch sets it, with the boundary.
      const form = new FormData()
      for (const part of body.parts) {
        if (!part.key) continue
        if (part.kind === 'text') {
          form.append(part.key, await renderText(part.value, ctx.evaluate))
          continue
        }
        const file = multipartFile(part.key, await renderTemplate(part.file, ctx.evaluate))
        const filename = (await renderText(part.filename, ctx.evaluate)) || file.filename || part.key
        const type =
          (await renderText(part.contentType, ctx.evaluate)) || file.contentType || 'application/octet-stream'
        form.append(part.key, new Blob([new Uint8Array(file.bytes)], { type }), filename)
      }
      return { body: form }
    }
  }
}

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/

/** A file part's value: base64 text, or a webhook's file object (`{ base64, filename?, contentType? }`). */
function multipartFile(
  key: string,
  value: unknown,
): { bytes: Buffer; filename?: string; contentType?: string } {
  const object = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const base64 = typeof value === 'string' ? value : object?.base64
  const text = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : null
  if (text === null || !BASE64.test(text)) {
    throw new ConnectorError(
      'query',
      `File part "${key}" needs base64 text or a file object ({ base64, filename, contentType }), like a webhook's upload`,
    )
  }
  return {
    bytes: Buffer.from(text, 'base64'),
    ...(typeof object?.filename === 'string' && { filename: object.filename }),
    ...(typeof object?.contentType === 'string' && { contentType: object.contentType }),
  }
}

/** Queries may only reach the base URL's host and `allowedHosts`, over http(s). */
function checkHost(config: Config, url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectorError('blocked', `Only http and https URLs are allowed (got ${url.protocol})`)
  }
  const baseHost = new URL(config.baseUrl).hostname
  const allowed = url.hostname === baseHost || config.allowedHosts.some((p) => hostMatches(url.hostname, p))
  if (!allowed) {
    throw new ConnectorError(
      'blocked',
      `${url.hostname} isn't allowed for this resource. Add it to the resource's allowed hosts.`,
    )
  }
  // IP literals skip DNS, so the connect-time guard never sees them.
  if (!config.allowPrivateNetwork && isPrivateAddress(url.hostname)) {
    throw new ConnectorError('blocked', `${url.hostname} is a private address`)
  }
}

/**
 * Sends a request, following redirects by hand so every hop is checked against the allowed hosts. Credentials
 * are dropped when a redirect leaves the original origin.
 */
async function send(
  client: Client,
  url: URL,
  init: { method: string; headers: Headers; body?: string | FormData },
  signal: AbortSignal,
  /** Headers carrying credentials besides the usual ones (a custom auth flow's), dropped like them. */
  sensitive: string[] = [],
): Promise<Response> {
  let current = url
  let previous: URL | undefined
  let { method, body } = init
  const headers = new Headers(init.headers)
  for (let hop = 0; ; hop++) {
    try {
      checkHost(client.config, current)
    } catch (err) {
      // Say that the server sent us there: a refused redirect otherwise reads like a mistyped base URL. The target
      // is shown without its query string, which may carry tokens.
      if (!previous || !(err instanceof ConnectorError)) throw err
      throw new ConnectorError(
        err.code,
        `${previous.host} redirected to ${current.origin}${current.pathname}. ${err.message}`,
      )
    }
    let res: Response
    try {
      res = await fetch(current, {
        method,
        headers,
        body,
        signal,
        redirect: 'manual',
        dispatcher: client.agent,
      })
    } catch (err) {
      throw networkError(err, current)
    }
    const location = res.headers.get('location')
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res
    await res.body?.cancel()
    if (hop >= MAX_REDIRECTS)
      throw new ConnectorError('http', `Too many redirects (more than ${MAX_REDIRECTS})`)

    const next = new URL(location, current)
    if (next.origin !== url.origin) {
      for (const name of [
        'authorization',
        'cookie',
        'proxy-authorization',
        ...Object.keys(client.secrets.headers),
        ...sensitive,
      ]) {
        headers.delete(name)
      }
      const auth = client.config.auth
      if (auth.type === 'apiKey' && auth.in === 'header') headers.delete(auth.name)
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
      headers.delete('content-type')
    }
    previous = current
    current = next
  }
}

/**
 * What one attempt of a request sends besides the query's own parts. Every auth type is assembled the same way
 * (attemptHeaders, attemptUrl): the resource's defaults, then the secret headers, then the query's own, then the
 * credentials. A custom flow only changes how the defaults are rendered (with `auth`).
 */
interface Attempt {
  defaultHeaders: [string, string][]
  defaultParams: [string, string][]
  authHeaders: Record<string, string>
  authParams: [string, string][]
  /** Headers dropped on a cross-origin redirect besides the usual ones: credentials, and defaults using `auth`. */
  sensitive: string[]
}

/** A template that reads the custom flow's variables. */
const USES_AUTH = /\{\{[^}]*\bauth\b/

async function prepareAttempt(
  client: Client,
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
  force = false,
): Promise<Attempt> {
  const auth = client.config.auth
  const attempt: Attempt = {
    defaultHeaders: [],
    defaultParams: [],
    authHeaders: {},
    authParams: [],
    sensitive: [],
  }
  let render = async (text: string) => text
  switch (auth.type) {
    case 'oauth2ClientCredentials':
      attempt.authHeaders.authorization = `Bearer ${await getToken(client, ctx.signal)}`
      break
    case 'oauth2AuthorizationCode': {
      if (!ctx.credentials?.accessToken) {
        throw new ConnectorError('auth_required', 'Connect an account to this resource before using it')
      }
      const token = await ctx.credentials.accessToken({ signal: ctx.signal, force })
      attempt.authHeaders.authorization = `Bearer ${token}`
      break
    }
    case 'custom': {
      if (!ctx.credentials?.authVariables) {
        throw new ConnectorError(
          'auth_required',
          "This resource signs in with a custom auth flow, which can't run here",
        )
      }
      const { evaluate } = await ctx.credentials.authVariables({ signal: ctx.signal, force })
      render = (text) => renderText(text, evaluate)
      break
    }
    case 'apiKey':
      if (auth.in === 'query')
        attempt.authParams.push([auth.name, requireSecret(client.secrets.apiKey, 'API key')])
      else Object.assign(attempt.authHeaders, authHeaders(client))
      break
    default:
      Object.assign(attempt.authHeaders, authHeaders(client))
  }
  for (const { key, value } of client.config.headers) {
    if (!key) continue
    attempt.defaultHeaders.push([key, await render(value)])
    if (auth.type === 'custom' && USES_AUTH.test(value)) attempt.sensitive.push(key)
  }
  for (const { key, value } of client.config.params) {
    if (key) attempt.defaultParams.push([key, await render(value)])
  }
  attempt.sensitive.push(...Object.keys(attempt.authHeaders))
  return attempt
}

function attemptHeaders(
  client: Client,
  attempt: Attempt,
  queryHeaders: [string, string][],
  contentType?: string,
): Headers {
  const headers = new Headers()
  for (const [key, value] of attempt.defaultHeaders) headers.set(key, value)
  for (const [key, value] of Object.entries(client.secrets.headers)) headers.set(key, value)
  for (const [key, value] of queryHeaders) headers.set(key, value)
  if (contentType && !headers.has('content-type')) headers.set('content-type', contentType)
  for (const [key, value] of Object.entries(attempt.authHeaders)) headers.set(key, value)
  return headers
}

function attemptUrl(base: URL, attempt: Attempt, queryParams: [string, string][]): URL {
  const url = new URL(base)
  for (const [key, value] of attempt.defaultParams) url.searchParams.append(key, value)
  for (const [key, value] of queryParams) url.searchParams.append(key, value)
  for (const [key, value] of attempt.authParams) url.searchParams.set(key, value)
  return url
}

function authHeaders(client: Client): Record<string, string> {
  const { auth } = client.config
  const { secrets } = client
  switch (auth.type) {
    case 'none':
    case 'oauth2ClientCredentials':
    case 'oauth2AuthorizationCode':
    case 'custom':
      return {}
    case 'apiKey':
      return auth.in === 'header' ? { [auth.name]: requireSecret(secrets.apiKey, 'API key') } : {}
    case 'bearer':
      return { authorization: `Bearer ${requireSecret(secrets.bearerToken, 'Bearer token')}` }
    case 'basic': {
      const password = secrets.password ?? ''
      return { authorization: `Basic ${Buffer.from(`${auth.username}:${password}`).toString('base64')}` }
    }
  }
}

/** Client-credentials token, cached on the client until 30s before it expires. */
async function getToken(client: Client, signal: AbortSignal, force = false): Promise<string> {
  const auth = client.config.auth
  if (auth.type !== 'oauth2ClientCredentials') throw new Error('not an OAuth2 client-credentials resource')
  if (!force && client.token && client.token.expiresAt > Date.now() + 30_000) return client.token.value

  const secret = requireSecret(client.secrets.clientSecret, 'OAuth2 client secret')
  const token = await clientCredentialsToken(auth, secret, {
    signal,
    allowPrivateNetwork: client.config.allowPrivateNetwork,
    dispatcher: client.agent,
  })
  client.token = {
    value: token.accessToken,
    expiresAt: token.expiresAt?.getTime() ?? Date.now() + 3600_000,
  }
  return token.accessToken
}

/** JSON is parsed; text-like types are decoded; anything else is returned as base64. */
function decodeBody(raw: Buffer, contentType: string | null): { value: unknown; base64?: boolean } {
  const type = (contentType ?? '').toLowerCase()
  if (raw.length === 0) return { value: null }
  if (type.includes('json')) {
    const text = raw.toString('utf8')
    try {
      return { value: JSON.parse(text) }
    } catch {
      return { value: text }
    }
  }
  if (!type || /^text\/|xml|javascript|x-www-form-urlencoded|csv/.test(type))
    return { value: raw.toString('utf8') }
  return { value: raw.toString('base64'), base64: true }
}

function requireSecret(value: string | undefined, label: string): string {
  if (!value) throw new ConnectorError('invalid_config', `The ${label} isn't set for this resource`)
  return value
}
