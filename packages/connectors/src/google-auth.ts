import { createSign } from 'node:crypto'
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
  const url = new URL(tokenUrl)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      signal,
      dispatcher,
    })
  } catch (err) {
    throw networkError(err, url)
  }
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
      `Google refused the service account key: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
      { status: res.status, error: json.error },
    )
  }
  return { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 }
}
