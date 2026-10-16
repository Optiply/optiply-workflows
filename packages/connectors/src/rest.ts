import { parseTemplate, renderJson, renderText, TemplateError } from '@ow/expressions'
import { Agent, fetch, Headers, type Response } from 'undici'
import { z } from 'zod'
import { networkError, readBody } from './http'
import { guardedLookup, hostMatches, isPrivateAddress } from './net-guard'
import { clientCredentialsToken } from './oauth'
import { OAUTH_PROVIDERS } from './oauth-presets'
import {
  type Connector,
  ConnectorError,
  type CredentialSource,
  type QueryContext,
  type QueryResult,
} from './types'

const keyValues = z.array(z.object({ key: z.string(), value: z.string() })).default([])

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
  ])
  .default({ type: 'none' })

const configSchema = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  /** Sent with every request; values are plain text (secret headers belong in the secrets). */
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
})

const secretsSchema = z.object({
  apiKey: z.string().optional(),
  bearerToken: z.string().optional(),
  password: z.string().optional(),
  clientSecret: z.string().optional(),
  /** Header name → value, for credentials sent as custom headers. */
  headers: z.record(z.string(), z.string()).default({}),
})

const bodySchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    /** JSON text with `{{ }}`; see `renderJson`. */
    z.object({ type: z.literal('json'), json: z.string() }),
    z.object({ type: z.literal('form'), fields: keyValues }),
    z.object({ type: z.literal('raw'), raw: z.string(), contentType: z.string().default('text/plain') }),
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

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

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
    const headers = new Headers(await authorize(client, { signal, credentials }))
    const res = await send(client, new URL(client.config.baseUrl), { method: 'GET', headers }, signal)
    await res.body?.cancel()
    return { message: `HTTP ${res.status} ${res.statusText}`.trim() }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    const templates = [
      query.path,
      ...query.params.map((p) => p.value),
      ...query.headers.map((h) => h.value),
      ...(query.body.type === 'json' ? [query.body.json] : []),
      ...(query.body.type === 'form' ? query.body.fields.map((f) => f.value) : []),
      ...(query.body.type === 'raw' ? [query.body.raw] : []),
    ]
    for (const template of templates) {
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
    const url = await buildUrl(client, query, ctx)
    const headers = new Headers()
    for (const { key, value } of client.config.headers) if (key) headers.set(key, value)
    for (const [key, value] of Object.entries(client.secrets.headers)) headers.set(key, value)
    for (const { key, value } of query.headers)
      if (key) headers.set(key, await renderText(value, ctx.evaluate))
    const body = await buildBody(query, headers, ctx)

    const started = performance.now()
    const request = async (force = false) => {
      const auth = await authorize(client, ctx, force)
      for (const [k, v] of Object.entries(auth)) headers.set(k, v)
      return send(client, url, { method: query.method, headers, body }, ctx.signal)
    }
    let res = await request()
    // An expired or revoked OAuth token: get a fresh one and retry once.
    const authType = client.config.auth.type
    if (
      res.status === 401 &&
      (authType === 'oauth2ClientCredentials' || authType === 'oauth2AuthorizationCode')
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

async function buildUrl(client: Client, query: Query, ctx: QueryContext): Promise<URL> {
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
  for (const { key, value } of client.config.params) if (key) url.searchParams.append(key, value)
  for (const { key, value } of query.params) {
    if (key) url.searchParams.append(key, await renderText(value, ctx.evaluate))
  }
  const auth = client.config.auth
  if (auth.type === 'apiKey' && auth.in === 'query') {
    url.searchParams.set(auth.name, requireSecret(client.secrets.apiKey, 'API key'))
  }
  return url
}

async function buildBody(query: Query, headers: Headers, ctx: QueryContext): Promise<string | undefined> {
  const body = query.body
  const setType = (type: string) => headers.has('content-type') || headers.set('content-type', type)
  switch (body.type) {
    case 'none':
      return undefined
    case 'json':
      setType('application/json')
      return JSON.stringify(await renderJson(body.json, ctx.evaluate))
    case 'form': {
      setType('application/x-www-form-urlencoded')
      const form = new URLSearchParams()
      for (const { key, value } of body.fields)
        if (key) form.append(key, await renderText(value, ctx.evaluate))
      return form.toString()
    }
    case 'raw':
      setType(body.contentType)
      return renderText(body.raw, ctx.evaluate)
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
  init: { method: string; headers: Headers; body?: string },
  signal: AbortSignal,
): Promise<Response> {
  let current = url
  let { method, body } = init
  const headers = new Headers(init.headers)
  for (let hop = 0; ; hop++) {
    checkHost(client.config, current)
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
    current = next
  }
}

async function authorize(
  client: Client,
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
  force = false,
): Promise<Record<string, string>> {
  switch (client.config.auth.type) {
    case 'oauth2ClientCredentials':
      return { authorization: `Bearer ${await getToken(client, ctx.signal)}` }
    case 'oauth2AuthorizationCode': {
      if (!ctx.credentials) {
        throw new ConnectorError('auth_required', 'Connect an account to this resource before using it')
      }
      return { authorization: `Bearer ${await ctx.credentials.accessToken({ signal: ctx.signal, force })}` }
    }
    default:
      return authHeaders(client)
  }
}

function authHeaders(client: Client): Record<string, string> {
  const { auth } = client.config
  const { secrets } = client
  switch (auth.type) {
    case 'none':
    case 'oauth2ClientCredentials':
    case 'oauth2AuthorizationCode':
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
