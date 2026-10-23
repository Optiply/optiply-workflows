import { configureIap, type ServerIdentity, serverIdentity } from '@ow/connectors'
import type { Config } from '../config'

const IAP_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

type IapConfig = Pick<Config, 'GOOGLE_SERVER_IDENTITY' | 'GOOGLE_IAP_URL' | 'GOOGLE_TOKEN_URL'>

/**
 * This process's server identity for Google Cloud IAP (M18); null unless GOOGLE_SERVER_IDENTITY=allow. Set up once at
 * startup (the API and the worker both call `configureGoogleIap`), like Python's executor.
 */
let identity: ServerIdentity | null = null

/** Hands the connectors their IAP settings. `env` is where the identity's credentials are looked up (tests). */
export function configureGoogleIap(config: IapConfig, env?: Record<string, string | undefined>): void {
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
