import { type AppQuery, instanceKeys } from '@ow/app-definition'
import { type AuthorizationCodeSettings, restConnector } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import {
  appReleases,
  apps,
  type Db,
  type Resource,
  type ResourceConfig,
  resourceConfigs,
  resources,
} from '@ow/db'
import { and, eq } from 'drizzle-orm'
import type { Config } from '../config'
import { resolveLibraryRelease } from './library-queries'
import { moduleReleasesByKey } from './modules'
import { type Access, atLeast, loadAccess } from './permissions'
import { decryptConfigSecrets } from './resources'

/** Whose account a connect or disconnect is about: the resource's shared one, or the signed-in person's. */
export type AccountKind = 'shared' | 'mine'

export class OAuthConnectError extends Error {
  override name = 'OAuthConnectError'
  constructor(
    readonly status: 400 | 401 | 403 | 404,
    message: string,
  ) {
    super(message)
  }
}

/** The one redirect URI to register with every provider. */
export function oauthRedirectUri(config: Pick<Config, 'PUBLIC_URL'>): string {
  return new URL('/api/oauth/callback', config.PUBLIC_URL).toString()
}

export interface ConnectTarget {
  resource: Resource
  config: ResourceConfig
  auth: AuthorizationCodeSettings
  clientSecret: string | undefined
  allowPrivateNetwork: boolean
  /** The owner of the tokens: null for the shared account. */
  userId: string | null
}

/**
 * Checks that `user` may connect (or disconnect) this account and returns what the flow needs. The shared account
 * needs Edit on the resource in the environment (it acts for everyone); one's own account needs Use, or Use on an
 * app (`appId`) whose live release queries the resource: app viewers run its queries without access to the
 * resource, so they must be able to connect the account those queries use. The resource must be a REST resource
 * using the authorization code with the matching kind of tokens.
 */
export async function connectTarget(
  db: Db,
  keyring: Keyring,
  user: { id: string; isAdmin: boolean },
  input: { resourceId: string; environmentId: string; account: AccountKind; appId?: string | undefined },
): Promise<ConnectTarget> {
  const access = await loadAccess(db, user)
  const [resource] = await db.select().from(resources).where(eq(resources.id, input.resourceId))
  const level = resource ? access.level(resource, input.environmentId) : null
  const throughApp =
    !!resource &&
    !level &&
    input.account === 'mine' &&
    !!input.appId &&
    (await liveAppQueries(db, access, input.appId, resource.slug))
  if (!resource || (!level && !throughApp)) throw new OAuthConnectError(404, 'Resource not found')
  if (resource.type !== restConnector.type) {
    throw new OAuthConnectError(400, 'Only REST resources connect accounts')
  }
  const [config] = await db
    .select()
    .from(resourceConfigs)
    .where(
      and(
        eq(resourceConfigs.resourceId, resource.id),
        eq(resourceConfigs.environmentId, input.environmentId),
      ),
    )
  if (!config) throw new OAuthConnectError(400, 'This resource is not configured in this environment')
  const parsed = restConnector.configSchema.safeParse(config.config)
  const auth = parsed.success ? parsed.data.auth : undefined
  if (!parsed.success || auth?.type !== 'oauth2AuthorizationCode') {
    throw new OAuthConnectError(400, "This resource doesn't use OAuth 2.0 sign-in in this environment")
  }
  if (input.account === 'shared' && auth.tokens !== 'shared') {
    throw new OAuthConnectError(400, 'On this resource each person connects their own account')
  }
  if (input.account === 'mine' && auth.tokens !== 'perUser') {
    throw new OAuthConnectError(400, 'This resource uses one shared account')
  }
  if (input.account === 'shared' && !atLeast(level, 'edit')) {
    throw new OAuthConnectError(
      403,
      'You need edit access to this resource in this environment to connect its shared account',
    )
  }
  const secrets = decryptConfigSecrets(keyring, config) as { clientSecret?: unknown }
  return {
    resource,
    config,
    auth,
    clientSecret: typeof secrets.clientSecret === 'string' ? secrets.clientSecret : undefined,
    allowPrivateNetwork: parsed.data.allowPrivateNetwork,
    userId: input.account === 'shared' ? null : user.id,
  }
}

/**
 * Whether the user may use the app and its live release queries the resource (by slug): in a resource query, through
 * a library query whose release (pinned, or live now) runs on it, or in a module instance's release, the same way
 * (M14).
 */
async function liveAppQueries(db: Db, access: Access, appId: string, resourceSlug: string): Promise<boolean> {
  const [app] = await db.select().from(apps).where(eq(apps.id, appId))
  if (!app?.liveReleaseId || !access.appLevel(app)) return false
  const [release] = await db.select().from(appReleases).where(eq(appReleases.id, app.liveReleaseId))
  if (!release) return false
  if (await queriesResource(db, release.definition.queries, resourceSlug)) return true
  const instances = Object.values(await moduleReleasesByKey(db, instanceKeys(release.definition)))
  for (const instance of instances) {
    if (await queriesResource(db, instance.definition.queries, resourceSlug)) return true
  }
  return false
}

/** Whether these queries run on the resource: as resource queries, or through a library query's release. */
async function queriesResource(db: Db, queries: AppQuery[], resourceSlug: string): Promise<boolean> {
  if (queries.some((q) => q.kind === 'resource' && q.resource === resourceSlug)) return true
  for (const q of queries) {
    if (q.kind !== 'library') continue
    const used = await resolveLibraryRelease(db, q.library, q.version).catch(() => null)
    if (used?.release.definition.resource === resourceSlug) return true
  }
  return false
}

/** What the start route keeps (signed, in a cookie of its own) for the callback. */
export interface PendingConnect {
  state: string
  /** The PKCE verifier, when the resource uses PKCE. */
  verifier?: string
  resourceId: string
  environmentId: string
  account: AccountKind
  /** The app the person connects through, when they have no access to the resource itself. */
  appId?: string
  /** Who started: the callback must come back in the same person's session. */
  userId: string
  /** The consent settings at the start: if they change before the callback, the code is for other settings. */
  consent: string
}

export const PENDING_COOKIE_PREFIX = 'ow_oauth_'
export const PENDING_COOKIE_PATH = '/api/oauth'
export const PENDING_MAX_AGE_S = 600

/** One cookie per flow (named after its state), so two connects in two tabs don't overwrite each other. */
export function pendingCookieName(state: string): string {
  return `${PENDING_COOKIE_PREFIX}${state.replace(/[^\w-]/g, '').slice(0, 16)}`
}

export interface ConnectResult {
  ok: boolean
  message: string
  resourceId?: string
  environmentId?: string
  account?: AccountKind
}

/**
 * The page the popup ends on: it tells the page that opened it how it went (`ow:oauth`, to our own origin only)
 * and closes; opened directly, it shows the outcome with a way back.
 */
export function resultPage(config: Pick<Config, 'PUBLIC_URL'>, result: ConnectResult): string {
  const origin = new URL(config.PUBLIC_URL).origin
  const message = { type: 'ow:oauth', ...result }
  // JSON inside <script>: `<` escaped so the data can't close the tag.
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  const back = result.resourceId ? `/resources/${encodeURIComponent(result.resourceId)}` : '/resources'
  const title = result.ok ? 'Account connected' : 'Could not connect the account'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 24px; color: #1f2328; background: #fff; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #59636e; }
  a { color: #0969da; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(result.message)}</p>
<p><a href="${escapeHtml(back)}">Back to the resource</a></p>
</main>
<script>
  if (window.opener) {
    try { window.opener.postMessage(${json(message)}, ${json(origin)}) } catch (e) {}
    window.close()
  }
</script>
</body>
</html>
`
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
