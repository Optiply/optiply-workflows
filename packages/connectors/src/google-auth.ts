import { createSign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Dispatcher, fetch } from 'undici'
import { z } from 'zod'
import { networkError, readBody } from './http'
import { ConnectorError } from './types'

/** Google's OAuth token endpoint. A key's own `token_uri` is ignored, so a key can't send tokens elsewhere. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const serviceAccountKeySchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
})

export type ServiceAccountKey = z.output<typeof serviceAccountKeySchema>

/** Access tokens for one Google identity, cached and refreshed a minute before they expire. */
export interface GoogleTokens {
  /** A valid access token; `force` fetches a new one (after a 401). */
  token(signal: AbortSignal, force?: boolean): Promise<string>
}

export function isServiceAccountKey(text: string): boolean {
  try {
    return serviceAccountKeySchema.safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}

/** A service account's JSON key file; errors name `field` (and the key's fields), never the content. */
export function parseServiceAccountKey(text: string, field: string): ServiceAccountKey {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Never quote the text: it's a private key.
    throw new ConnectorError('invalid_config', "The service account key isn't valid JSON", {
      issues: [{ path: field }],
    })
  }
  const key = serviceAccountKeySchema.safeParse(json)
  if (!key.success) {
    throw new ConnectorError('invalid_config', 'The service account key is missing fields', {
      issues: key.error.issues.map((i) => ({ path: [field, ...i.path].join('.') })),
    })
  }
  return key.data
}

export interface ServiceAccountTokenOptions {
  scope: string
  /** Where the key is set, for errors (`serviceAccountKey`). */
  field: string
  tokenUrl?: string
  dispatcher?: Dispatcher
}

/** Tokens for a service account from a signed JWT (RFC 7523). */
export function serviceAccountTokens(
  key: ServiceAccountKey,
  options: ServiceAccountTokenOptions,
): GoogleTokens {
  return cachedTokens((signal) => fetchServiceAccountToken(key, options, signal))
}

interface Token {
  value: string
  expiresAt: number
}

function cachedTokens(fetchToken: (signal: AbortSignal) => Promise<Token>): GoogleTokens {
  let current: Promise<Token> | undefined
  return {
    async token(signal, force = false) {
      const cached = force ? undefined : await current?.catch(() => undefined)
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value
      const fresh = fetchToken(signal)
      current = fresh
      return (await fresh).value
    },
  }
}

async function fetchServiceAccountToken(
  key: ServiceAccountKey,
  { scope, field, tokenUrl = GOOGLE_TOKEN_URL, dispatcher }: ServiceAccountTokenOptions,
  signal: AbortSignal,
): Promise<Token> {
  const now = Math.floor(Date.now() / 1000)
  const b64 = (json: object) => Buffer.from(JSON.stringify(json)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope,
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  })}`
  let signature: string
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')
  } catch {
    throw new ConnectorError('invalid_config', "The service account key's private key can't sign", {
      issues: [{ path: `${field}.private_key` }],
    })
  }
  return requestToken(
    tokenUrl,
    { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` },
    { signal, dispatcher, refused: 'Google refused the service account key' },
  )
}

/** A token from Google's token endpoint for `form` (a JWT or a refresh token). */
async function requestToken(
  tokenUrl: string,
  form: Record<string, string>,
  { signal, dispatcher, refused }: { signal: AbortSignal; dispatcher?: Dispatcher; refused: string },
): Promise<Token> {
  const url = new URL(tokenUrl)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal,
      dispatcher,
    })
  } catch (err) {
    throw networkError(err, url)
  }
  return tokenFrom(res, refused)
}

/** `{access_token, expires_in}` from the token endpoint or the metadata server. */
async function tokenFrom(res: Awaited<ReturnType<typeof fetch>>, refused: string): Promise<Token> {
  const text = (await readBody(res, 1024 * 1024)).toString('utf8')
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
  try {
    json = JSON.parse(text)
  } catch {
    // Reported below.
  }
  if (!res.ok || !json.access_token) {
    throw new ConnectorError(
      'connection',
      `${refused}: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
      { status: res.status, error: json.error },
    )
  }
  return { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 }
}

const authorizedUserSchema = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
})

/** The server's own Google identity: tokens, and who they're for. */
export interface ServerIdentity extends GoogleTokens {
  /** A service account's email, or what the credentials are where there's no email to show. */
  describe(signal: AbortSignal): Promise<string>
}

export interface ServerIdentityOptions {
  scope: string
  /** `process.env` by default: `GOOGLE_APPLICATION_CREDENTIALS`, `GCE_METADATA_HOST`, `HOME`. */
  env?: Record<string, string | undefined>
  tokenUrl?: string
  dispatcher?: Dispatcher
  /** How long the metadata server may take to answer. */
  metadataTimeoutMs?: number
}

interface IdentitySource {
  fetchToken(signal: AbortSignal): Promise<Token>
  describe(signal: AbortSignal): Promise<string>
}

/**
 * Application Default Credentials, in Google's order: the file `GOOGLE_APPLICATION_CREDENTIALS` names (a service
 * account key or an `authorized_user` file from `gcloud auth application-default login`), gcloud's own
 * application-default file under `HOME`, and otherwise the metadata server (on Google Cloud). The source is found on
 * first use, and again after a token couldn't be had (a file mounted later, a metadata server that was slow).
 */
export function serverIdentity(options: ServerIdentityOptions): ServerIdentity {
  let source: Promise<IdentitySource> | undefined
  const found = () => {
    source ??= findSource(options).catch((err) => {
      source = undefined
      throw err
    })
    return source
  }
  const tokens = cachedTokens(async (signal) => {
    try {
      return await (await found()).fetchToken(signal)
    } catch (err) {
      // Look again next time: no metadata server answering may mean a credentials file is the way now.
      source = undefined
      throw err
    }
  })
  return {
    token: tokens.token,
    async describe(signal) {
      return (await found()).describe(signal)
    },
  }
}

async function findSource(options: ServerIdentityOptions): Promise<IdentitySource> {
  const env = options.env ?? process.env
  const named = env.GOOGLE_APPLICATION_CREDENTIALS
  if (named) return fileSource(named, 'GOOGLE_APPLICATION_CREDENTIALS', options)
  const gcloud = env.HOME && join(env.HOME, '.config', 'gcloud', 'application_default_credentials.json')
  if (gcloud && existsSync(gcloud)) return fileSource(gcloud, gcloud, options)
  return metadataSource(env.GCE_METADATA_HOST || 'metadata.google.internal', options)
}

async function fileSource(
  path: string,
  field: string,
  options: ServerIdentityOptions,
): Promise<IdentitySource> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new ConnectorError(
      'invalid_config',
      `The server's Google credentials file (${path}) can't be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    )
  }
  let json: { type?: unknown } = {}
  try {
    json = JSON.parse(text)
  } catch {
    // Reported below; never quote the text.
  }
  const { tokenUrl = GOOGLE_TOKEN_URL, dispatcher, scope } = options
  if (json.type === 'service_account') {
    const key = parseServiceAccountKey(text, field)
    return {
      fetchToken: (signal) => fetchServiceAccountToken(key, { scope, field, tokenUrl, dispatcher }, signal),
      describe: async () => key.client_email,
    }
  }
  const user = authorizedUserSchema.safeParse(json)
  if (user.success) {
    const { client_id, client_secret, refresh_token } = user.data
    return {
      // Google's endpoint, whatever the file says, as for keys.
      fetchToken: (signal) =>
        requestToken(
          tokenUrl,
          { grant_type: 'refresh_token', client_id, client_secret, refresh_token },
          { signal, dispatcher, refused: "Google refused the server's user credentials" },
        ),
      describe: async () => 'gcloud application-default credentials (a user)',
    }
  }
  throw new ConnectorError(
    'invalid_config',
    `The server's Google credentials file (${path}) isn't a service account key or an authorized_user file`,
  )
}

function metadataSource(host: string, options: ServerIdentityOptions): IdentitySource {
  const base = `http://${host}/computeMetadata/v1/instance/service-accounts/default`
  const get = async (path: string, signal: AbortSignal) => {
    const url = new URL(base + path)
    try {
      return await fetch(url, {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(options.metadataTimeoutMs ?? 3000)]),
        dispatcher: options.dispatcher,
      })
    } catch (err) {
      if (signal.aborted) throw err
      throw new ConnectorError(
        'connection',
        "The server has no Google identity: GOOGLE_APPLICATION_CREDENTIALS isn't set, there's no gcloud " +
          `application-default login, and no Google Cloud metadata server answered at ${host}`,
        { cause: (err as Error).message },
      )
    }
  }
  return {
    fetchToken: async (signal) =>
      tokenFrom(
        await get(`/token?scopes=${encodeURIComponent(options.scope)}`, signal),
        "The metadata server refused the server's token",
      ),
    async describe(signal) {
      const res = await get('/email', signal)
      const text = (await readBody(res, 64 * 1024)).toString('utf8').trim()
      return res.ok && text ? text : 'the Google Cloud service account of this server'
    },
  }
}
