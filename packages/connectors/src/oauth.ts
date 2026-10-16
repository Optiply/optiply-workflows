import { createHash, randomBytes } from 'node:crypto'
import { Agent, type Dispatcher, fetch, Headers, type Response } from 'undici'
import { networkError } from './http'
import { guardedLookup, isPrivateAddress } from './net-guard'
import type { OAuthProviderId } from './oauth-presets'
import { ConnectorError } from './types'

/** The settings of an authorization-code resource that the flow itself needs. */
export interface AuthorizationCodeSettings {
  provider: OAuthProviderId
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  scope: string
  authorizeParams: { key: string; value: string }[]
  clientAuth: 'body' | 'basic'
  pkce: boolean
}

export interface TokenSet {
  accessToken: string
  /** Null when the provider issued none (the connection then lasts as long as the access token). */
  refreshToken: string | null
  /** Null when the provider didn't say: the token is used until an API refuses it. */
  expiresAt: Date | null
  /** The scopes the provider says it granted, as it wrote them. */
  scope: string | null
  /** Who was connected, for display: an email, a workspace name… Null when the response doesn't say. */
  account: string | null
}

export interface TokenRequestOptions {
  signal: AbortSignal
  /** The resource's own flag: token URLs on private addresses are refused unless it's set. */
  allowPrivateNetwork: boolean
  /** Used instead of the module's shared agents (the REST connector passes its client's). */
  dispatcher?: Dispatcher
  now?: Date
}

/** The provider no longer accepts the grant (revoked, expired, or a rotated refresh token reused): reconnect. */
export class OAuthGrantError extends ConnectorError {
  override name = 'OAuthGrantError'
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super('auth_required', message, { reason })
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function createState(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * The provider's consent URL. Extra parameters go in first, so they can't replace the ones the flow depends on
 * (state, redirect URI, PKCE).
 */
export function buildAuthorizeUrl(
  auth: AuthorizationCodeSettings,
  opts: { redirectUri: string; state: string; codeChallenge?: string },
): URL {
  const url = new URL(auth.authorizeUrl)
  for (const { key, value } of auth.authorizeParams) if (key) url.searchParams.set(key, value)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', auth.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  if (auth.scope.trim()) url.searchParams.set('scope', auth.scope.trim())
  else url.searchParams.delete('scope')
  url.searchParams.set('state', opts.state)
  if (opts.codeChallenge) {
    url.searchParams.set('code_challenge', opts.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  } else {
    url.searchParams.delete('code_challenge')
    url.searchParams.delete('code_challenge_method')
  }
  return url
}

/** Trades the code from the callback for tokens. */
export async function exchangeCode(
  auth: AuthorizationCodeSettings,
  clientSecret: string | undefined,
  grant: { code: string; redirectUri: string; codeVerifier?: string },
  opts: TokenRequestOptions,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
  })
  if (grant.codeVerifier) form.set('code_verifier', grant.codeVerifier)
  const body = await requestToken(auth.tokenUrl, form, { ...auth, clientSecret }, opts)
  return parseTokenSet(auth.provider, body, opts.now ?? new Date())
}

/**
 * Gets a new access token. Providers that rotate refresh tokens return a new one; the others keep the old one,
 * which is returned unchanged. `account` is null unless the response says (callers keep the one they have).
 */
export async function refreshAccessToken(
  auth: AuthorizationCodeSettings,
  clientSecret: string | undefined,
  refreshToken: string,
  opts: TokenRequestOptions,
): Promise<TokenSet> {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  // Entra ID wants the scopes again on a refresh; elsewhere the original grant's scopes apply.
  if (auth.provider === 'microsoft' && auth.scope.trim()) form.set('scope', auth.scope.trim())
  const body = await requestToken(auth.tokenUrl, form, { ...auth, clientSecret }, opts)
  const tokens = parseTokenSet(auth.provider, body, opts.now ?? new Date())
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

/** Client-credentials grant (no user involved), as the REST connector's `oauth2ClientCredentials` uses it. */
export async function clientCredentialsToken(
  settings: {
    tokenUrl: string
    clientId: string
    scope?: string
    audience?: string
    clientAuth: 'body' | 'basic'
  },
  clientSecret: string,
  opts: TokenRequestOptions,
): Promise<TokenSet> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (settings.scope) form.set('scope', settings.scope)
  if (settings.audience) form.set('audience', settings.audience)
  const body = await requestToken(settings.tokenUrl, form, { ...settings, clientSecret }, opts)
  return parseTokenSet('custom', body, opts.now ?? new Date())
}

/** Grant errors that mean the connection is gone: reconnecting is the only way back. */
const GRANT_ERRORS = new Set([
  'invalid_grant',
  // Slack's names for the same thing.
  'invalid_refresh_token',
  'invalid_code',
  'token_revoked',
  'token_expired',
  'code_already_used',
])

const ERROR_BODY_PREVIEW = 2000

let guardedAgent: Agent | undefined
let openAgent: Agent | undefined

/** Token requests made outside a resource's pooled client (the connect flow, refreshes) share these. */
function sharedAgent(allowPrivateNetwork: boolean): Agent {
  if (allowPrivateNetwork) {
    openAgent ??= new Agent({ connections: 8 })
    return openAgent
  }
  guardedAgent ??= new Agent({ connections: 8, connect: { lookup: guardedLookup } })
  return guardedAgent
}

async function requestToken(
  tokenUrl: string,
  form: URLSearchParams,
  client: { clientId: string; clientSecret: string | undefined; clientAuth: 'body' | 'basic' },
  opts: TokenRequestOptions,
): Promise<Record<string, unknown>> {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  })
  if (client.clientAuth === 'basic' && client.clientSecret !== undefined) {
    const credentials = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`
    headers.set('authorization', `Basic ${Buffer.from(credentials).toString('base64')}`)
  } else {
    form.set('client_id', client.clientId)
    if (client.clientSecret !== undefined) form.set('client_secret', client.clientSecret)
  }

  const url = new URL(tokenUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConnectorError('invalid_config', 'The OAuth2 token URL must be http or https')
  }
  // IP literals skip DNS, so the connect-time guard never sees them.
  if (!opts.allowPrivateNetwork && isPrivateAddress(url.hostname)) {
    throw new ConnectorError('blocked', `${url.hostname} is a private address`)
  }
  const dispatcher = opts.dispatcher ?? sharedAgent(opts.allowPrivateNetwork)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: opts.signal,
      redirect: 'error',
      dispatcher,
    })
  } catch (err) {
    throw networkError(err, url)
  }
  const text = await res.text()
  const body = parseBody(text, res.headers.get('content-type'))

  const error = body && typeof body.error === 'string' ? body.error : undefined
  // Slack answers 200 with `ok: false`.
  if (!res.ok || body?.ok === false) {
    const description = typeof body?.error_description === 'string' ? `: ${body.error_description}` : ''
    if (error && GRANT_ERRORS.has(error)) {
      throw new OAuthGrantError(`The provider refused the connection (${error}${description})`, error)
    }
    throw new ConnectorError(
      'http',
      res.ok
        ? `OAuth2 token request failed: ${error ?? 'not ok'}${description}`
        : `OAuth2 token request failed: HTTP ${res.status}`,
      { status: res.status, body: text.slice(0, ERROR_BODY_PREVIEW) },
    )
  }
  if (!body) throw new ConnectorError('http', 'OAuth2 token response is not JSON')
  return body
}

function parseBody(text: string, contentType: string | null): Record<string, unknown> | undefined {
  // A few older providers answer form-encoded even when asked for JSON.
  if ((contentType ?? '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Reads a token response, including Slack's (a user token sits in `authed_user`). */
export function parseTokenSet(provider: OAuthProviderId, body: Record<string, unknown>, now: Date): TokenSet {
  let source = body
  if (provider === 'slack' && typeof body.access_token !== 'string' && isObject(body.authed_user)) {
    source = body.authed_user
  }
  const accessToken = source.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new ConnectorError('http', 'OAuth2 token response has no access_token')
  }
  const expiresIn = Number(source.expires_in)
  return {
    accessToken,
    refreshToken:
      typeof source.refresh_token === 'string' && source.refresh_token ? source.refresh_token : null,
    expiresAt:
      source.expires_in !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(now.getTime() + expiresIn * 1000)
        : null,
    scope: typeof source.scope === 'string' ? source.scope : null,
    account: accountOf(provider, body),
  }
}

/**
 * The connected account, for display only: read from the ID token's claims without verifying its signature,
 * which is fine because it came straight from the token endpoint over the connection we opened.
 */
function accountOf(provider: OAuthProviderId, body: Record<string, unknown>): string | null {
  if (provider === 'slack' && isObject(body.team) && typeof body.team.name === 'string') return body.team.name
  if (typeof body.id_token === 'string') {
    try {
      const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'))
      for (const claim of ['email', 'preferred_username', 'upn', 'name']) {
        if (typeof claims?.[claim] === 'string' && claims[claim]) return claims[claim]
      }
    } catch {
      // Not a JWT we can read: no account label.
    }
  }
  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
