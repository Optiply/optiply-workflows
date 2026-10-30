import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { renderJson, renderTemplate, renderText } from '@ow/expressions'
import { Agent, type buildConnector, FormData, fetch, Headers, type Response } from 'undici'
import { networkError, readBody } from './http'
import { guardedLookup, hostMatches, isPrivateAddress } from './net-guard'
import { clientCredentialsToken } from './oauth'
import type { RestConfig, RestQuery, RestSecrets } from './rest'
import { sshConnectionError, tunnelFor } from './ssh/client'
import type { SshTunnel } from './ssh/tunnel'
import { ConnectorError, type CredentialSource, type QueryContext } from './types'

// The HTTP half of the REST connector (M27): auth, redirects, host checks, limits and decoding, shared by every
// connector that talks HTTP (REST, the built-in REST API, GraphQL, Slack, HubSpot, SendGrid, Google Sheets). Each
// builds a client from a REST-shaped config: its base URL, auth, allowed hosts and network settings.

type Config = RestConfig
type Secrets = RestSecrets
type Query = RestQuery

export interface HttpClient {
  config: Config
  secrets: Secrets
  agent: Agent
  token?: { value: string; expiresAt: number }
  /** The SSH tunnel every request goes through (M17), if the resource has one. */
  tunnel?: SshTunnel
  /** Any public host may be reached, not just the base URL's and `allowedHosts` (the built-in REST API resource). */
  anyPublicHost?: boolean
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ERROR_BODY_PREVIEW = 2000

export function createHttpClient(
  config: Config,
  secrets: Secrets,
  opts: { anyPublicHost?: boolean } = {},
): HttpClient {
  const tunnel = tunnelFor(config, secrets)
  const agent = new Agent({
    connections: 32,
    connect: tunnel ? tunnelConnector(tunnel) : config.allowPrivateNetwork ? {} : { lookup: guardedLookup },
  })
  return {
    config,
    secrets,
    agent,
    ...(tunnel ? { tunnel } : {}),
    ...(opts.anyPublicHost ? { anyPublicHost: true } : {}),
  }
}

export async function destroyHttpClient({ agent, tunnel }: HttpClient): Promise<void> {
  await agent.close()
  await tunnel?.close()
}

/** One request, built by a connector: an absolute URL (checked against the client's hosts when sent). */
export interface HttpRequest {
  method: string
  url: URL
  params?: [string, string][]
  headers?: [string, string][]
  body?: string | FormData
  /** Used unless a header sets one. */
  contentType?: string
}

export interface HttpResponse {
  status: number
  statusText: string
  ok: boolean
  headers: Record<string, string>
  url: string
  durationMs: number
  /** JSON parsed, text decoded, anything else base64 (`base64: true`); null for HEAD and empty bodies. */
  data: unknown
  base64?: boolean
}

/**
 * Sends a request with the client's auth (a fresh token and one retry when an OAuth or custom-flow resource gets a
 * 401) and reads the response. Any status comes back: callers decide what an error is (`httpError` for REST's).
 */
export async function httpRequest(
  client: HttpClient,
  request: HttpRequest,
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
): Promise<HttpResponse> {
  const started = performance.now()
  const send1 = async (force = false) => {
    const attempt = await prepareAttempt(client, ctx, force)
    return send(
      client,
      attemptUrl(request.url, attempt, request.params ?? []),
      {
        method: request.method,
        headers: attemptHeaders(client, attempt, request.headers ?? [], request.contentType),
        ...(request.body !== undefined ? { body: request.body } : {}),
      },
      ctx.signal,
      attempt.sensitive,
    )
  }
  let res = await send1()
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
    res = await send1(true)
  }
  const response = {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    headers: Object.fromEntries(res.headers),
    url: res.url || request.url.toString(),
    durationMs: 0,
    data: null as unknown,
  }
  if (request.method === 'HEAD') {
    await res.body?.cancel()
  } else {
    const decoded = decodeBody(
      await readBody(res, client.config.maxResponseBytes),
      res.headers.get('content-type'),
    )
    response.data = decoded.value
    if (decoded.base64) Object.assign(response, { base64: true })
  }
  response.durationMs = Math.round(performance.now() - started)
  return response
}

/** REST's error for a response that isn't 2xx: the status, and the start of the body. */
export function httpError(res: HttpResponse): ConnectorError {
  const preview = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  return new ConnectorError('http', `HTTP ${res.status} ${res.statusText}`.trim(), {
    status: res.status,
    body: preview?.slice(0, ERROR_BODY_PREVIEW),
  })
}

/** A request to the base URL with the resource's auth: REST's Test connection. */
export async function testHttp(
  client: HttpClient,
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
): Promise<{ status: number; statusText: string }> {
  if (client.config.auth.type === 'oauth2ClientCredentials') await getToken(client, ctx.signal, true)
  const attempt = await prepareAttempt(client, ctx)
  const res = await send(
    client,
    attemptUrl(new URL(client.config.baseUrl), attempt, []),
    { method: 'GET', headers: attemptHeaders(client, attempt, []) },
    ctx.signal,
    attempt.sensitive,
  )
  await res.body?.cancel()
  return { status: res.status, statusText: res.statusText }
}

/** The body and the content type it implies (used unless a header sets one). */
export async function buildBody(
  query: Pick<Query, 'body'>,
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
export function multipartFile(
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

/**
 * Whether private addresses may be reached: when allowed, or through an SSH tunnel (M17), where what's reached is the
 * SSH server's network, which is the point (the guard protects this machine's network).
 */
export function privateNetworkAllowed(config: Config): boolean {
  return config.allowPrivateNetwork || config.ssh !== undefined
}

/**
 * Connects undici's requests through an SSH tunnel: a channel to the host and port from the last SSH server, and for
 * https TLS over it, with the hostname for SNI and the certificate check. Every request of the resource goes this
 * way, an OAuth2 client-credentials token included.
 */
function tunnelConnector(tunnel: SshTunnel): buildConnector.connector {
  return ({ hostname, protocol, port, servername }, callback) => {
    const https = protocol === 'https:'
    tunnel.open(hostname, Number(port) || (https ? 443 : 80)).then(
      (channel) => {
        if (!https) return callback(null, channel as never)
        const socket = tlsConnect({
          socket: channel,
          servername: servername || (isIP(hostname) ? undefined : hostname),
          ALPNProtocols: ['http/1.1'],
        })
        const failed = (err: Error) => callback(err, null)
        socket.once('error', failed)
        socket.once('secureConnect', () => {
          socket.off('error', failed)
          callback(null, socket)
        })
      },
      (err) => callback(sshConnectionError(err) ?? err, null),
    )
  }
}

/**
 * Queries may only reach the base URL's host and `allowedHosts` (or any public host, for the built-in REST API), over
 * http(s).
 */
export function checkHost(client: Pick<HttpClient, 'config' | 'anyPublicHost'>, url: URL): void {
  const { config } = client
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectorError('blocked', `Only http and https URLs are allowed (got ${url.protocol})`)
  }
  const baseHost = new URL(config.baseUrl).hostname
  const allowed =
    client.anyPublicHost ||
    url.hostname === baseHost ||
    config.allowedHosts.some((p) => hostMatches(url.hostname, p))
  if (!allowed) {
    throw new ConnectorError(
      'blocked',
      `${url.hostname} isn't allowed for this resource. Add it to the resource's allowed hosts.`,
    )
  }
  // IP literals skip DNS, so the connect-time guard never sees them.
  if (!privateNetworkAllowed(config) && isPrivateAddress(url.hostname)) {
    throw new ConnectorError('blocked', `${url.hostname} is a private address`)
  }
}

/**
 * Sends a request, following redirects by hand so every hop is checked against the allowed hosts. Credentials
 * are dropped when a redirect leaves the original origin.
 */
async function send(
  client: HttpClient,
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
      checkHost(client, current)
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
  client: HttpClient,
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
  client: HttpClient,
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

function authHeaders(client: HttpClient): Record<string, string> {
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
async function getToken(client: HttpClient, signal: AbortSignal, force = false): Promise<string> {
  const auth = client.config.auth
  if (auth.type !== 'oauth2ClientCredentials') throw new Error('not an OAuth2 client-credentials resource')
  if (!force && client.token && client.token.expiresAt > Date.now() + 30_000) return client.token.value

  const secret = requireSecret(client.secrets.clientSecret, 'OAuth2 client secret')
  const token = await clientCredentialsToken(auth, secret, {
    signal,
    allowPrivateNetwork: privateNetworkAllowed(client.config),
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

export function requireSecret(value: string | undefined, label: string): string {
  if (!value) throw new ConnectorError('invalid_config', `The ${label} isn't set for this resource`)
  return value
}
