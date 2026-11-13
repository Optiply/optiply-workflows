import {
  configureIap,
  configurePubSub,
  configureSheets,
  IAP_SCOPE,
  type ServerIdentity,
  SHEETS_SCOPE,
  serverIdentity,
} from '@ow/connectors'
import type { Config } from '../config'

type GoogleConfig = Pick<
  Config,
  'GOOGLE_SERVER_IDENTITY' | 'GOOGLE_IAP_URL' | 'GOOGLE_PUBSUB_URL' | 'GOOGLE_TOKEN_URL'
>

/**
 * This process's own Google identity, for Google Cloud IAP (M18) and Pub/Sub resources (M19); null unless
 * GOOGLE_SERVER_IDENTITY=allow. Set up once at startup (the API and the worker both call `configureGoogle`), like
 * Python's executor. Its scope (`cloud-platform`) covers both.
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
  configurePubSub({
    ...(identity ? { serverIdentity: identity } : {}),
    ...(config.GOOGLE_PUBSUB_URL ? { url: config.GOOGLE_PUBSUB_URL } : {}),
    ...tokenUrl,
  })
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
 * Why a Pub/Sub resource's settings (M19) couldn't sign in, checked on save as an SSH tunnel's are (M17, M18): a key
 * for `identity: 'key'`; for the server's identity, the instance allowing it and a project named. Null when fine.
 */
export function pubsubSettingsProblem(config: unknown, secrets: Record<string, unknown>): string | null {
  const c = (config ?? {}) as { identity?: string; project?: string }
  if (c.identity === 'server') {
    if (!identity)
      return "This instance doesn't let resources use its own Google identity; use a service account key"
    if (!c.project) return "Name the project: the server's identity has none of its own"
    return null
  }
  return secrets.serviceAccountKey ? null : 'Add the service account key'
}

/** Why a Google Sheets resource's settings (M27) couldn't sign in, checked on save like Pub/Sub's. */
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
