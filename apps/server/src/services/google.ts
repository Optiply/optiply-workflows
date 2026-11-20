import {
  configureGemini,
  configureGmail,
  configureIap,
  configureSheets,
  IAP_SCOPE,
  type ServerIdentity,
  SHEETS_SCOPE,
  serverIdentity,
} from '@ow/connectors'
import type { Config } from '../config'

type GoogleConfig = Pick<Config, 'GOOGLE_SERVER_IDENTITY' | 'GOOGLE_IAP_URL' | 'GOOGLE_TOKEN_URL'>

/**
 * This process's own Google identity, for Google Cloud IAP (M18) and the Google resources; null unless
 * GOOGLE_SERVER_IDENTITY=allow. Set up once at startup (the API and the worker both call `configureGoogle`), like
 * Python's executor. Its scope (`cloud-platform`) covers IAP and Vertex AI.
 */
let identity: ServerIdentity | null = null

/** Hands the connectors their Google settings. `env` is where the identity's credentials are looked up (tests). */
export function configureGoogle(config: GoogleConfig, env?: Record<string, string | undefined>): void {
  const tokenUrl = config.GOOGLE_TOKEN_URL ? { tokenUrl: config.GOOGLE_TOKEN_URL } : {}
  identity =
    config.GOOGLE_SERVER_IDENTITY === 'allow'
      ? serverIdentity({ scope: IAP_SCOPE, ...tokenUrl, ...(env ? { env } : {}) })
      : null
  configureIap({
    ...(identity ? { serverIdentity: identity } : {}),
    ...(config.GOOGLE_IAP_URL ? { url: config.GOOGLE_IAP_URL } : {}),
    ...tokenUrl,
  })
  // Gemini on Vertex AI (M37): `cloud-platform` covers it, so the same identity.
  configureGemini({ ...(identity ? { serverIdentity: identity } : {}), ...tokenUrl })
  // Gmail (M37): a delegated service account's tokens come from the same endpoint.
  configureGmail(tokenUrl)
  // Google Sheets (M27): the same credentials, asked for the Sheets and Drive scopes (`cloud-platform` covers neither).
  configureSheets({
    ...(identity
      ? { serverIdentity: serverIdentity({ scope: SHEETS_SCOPE, ...tokenUrl, ...(env ? { env } : {}) }) }
      : {}),
    ...tokenUrl,
  })
}

/** What the settings form shows of the server's identity: whether resources may use it, and whose it is (a service account's email, or what the credentials are). */
export type ServerIdentityView =
  | { allowed: false }
  | { allowed: true; canChoose: boolean; identity: string | null; error: string | null }

const DESCRIBE_TIMEOUT_MS = 5_000

export async function serverIdentityView(user: { isAdmin: boolean }): Promise<ServerIdentityView> {
  if (!identity) return { allowed: false }
  try {
    const name = await identity.describe(AbortSignal.timeout(DESCRIBE_TIMEOUT_MS))
    return { allowed: true, canChoose: user.isAdmin, identity: name, error: null }
  } catch (err) {
    // No credentials found (yet): say so, so an admin can fix the instance; a tunnel would fail the same way.
    return { allowed: true, canChoose: user.isAdmin, identity: null, error: (err as Error).message }
  }
}

/**
 * Why a Gemini resource's settings (M37) couldn't sign in: the API key, or for Vertex the service account's key, or
 * (the server's identity) the instance allowing it and a project named. Null when fine.
 */
export function geminiSettingsProblem(config: unknown, secrets: Record<string, unknown>): string | null {
  const c = (config ?? {}) as { platform?: string; identity?: string; project?: string }
  if ((c.platform ?? 'gemini') === 'gemini') return secrets.apiKey ? null : 'Add the Gemini API key'
  if (c.identity === 'server') {
    if (!identity)
      return "This instance doesn't let resources use its own Google identity; use a service account key"
    return c.project ? null : "Name the project: the server's identity has none of its own"
  }
  return secrets.serviceAccountKey ? null : 'Add the service account key'
}

/**
 * Why a Gmail resource's settings (M37) couldn't sign in: the OAuth app's client id and secret, or a delegated
 * service account's key. Null when fine.
 */
export function gmailSettingsProblem(config: unknown, secrets: Record<string, unknown>): string | null {
  const auth = ((config ?? {}) as { auth?: { type?: string; clientId?: string } }).auth ?? { type: 'oauth' }
  if (auth.type === 'delegation') return secrets.serviceAccountKey ? null : 'Add the service account key'
  if (!auth.clientId) return 'Add the OAuth app’s client id'
  return secrets.clientSecret ? null : 'Add the OAuth app’s client secret'
}

/**
 * Why a BigQuery resource's settings couldn't sign in, checked on save: a service account needs its key; OAuth sign-in
 * needs the Google OAuth client (id and secret) and the project queries run in (there's no key to take it from).
 */
export function bigquerySettingsProblem(config: unknown, secrets: Record<string, unknown>): string | null {
  const c = (config ?? {}) as { auth?: { type?: string; clientId?: string }; projectId?: string }
  if ((c.auth?.type ?? 'serviceAccount') === 'serviceAccount') {
    return secrets.serviceAccountKey ? null : 'Add the service account key'
  }
  if (!c.auth?.clientId?.trim()) return 'Add the OAuth app’s client id'
  if (!secrets.clientSecret) return 'Add the OAuth app’s client secret'
  return c.projectId?.trim() ? null : 'Set the project queries run in'
}

/** Why a Google Sheets resource's settings (M27) couldn't sign in, checked on save as an SSH tunnel's are. */
export function sheetsSettingsProblem(config: unknown, secrets: Record<string, unknown>): string | null {
  const auth = ((config ?? {}) as { auth?: { type?: string } }).auth?.type ?? 'serviceAccount'
  if (auth === 'server') {
    return identity
      ? null
      : "This instance doesn't let resources use its own Google identity; use a service account key"
  }
  if (auth === 'serviceAccount') return secrets.serviceAccountKey ? null : 'Add the service account key'
  return null
}
