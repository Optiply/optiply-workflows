import { createHash } from 'node:crypto'
import {
  type AuthorizationCodeSettings,
  ConnectorError,
  type CredentialSource,
  type FlowSandbox,
  flowAsksEachPerson,
  httpConfigFor,
  OAuthGrantError,
  type ResolvedResource,
  type RestAuth,
  refreshAccessToken,
  restConnector,
  revokeToken,
  type TokenSet,
} from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import { type Db, type OAuthToken, oauthTokens } from '@ow/db'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { recordAudit } from '../audit'
import { customAuthCredentials, customFlowHash } from './custom-auth'
import { withRefreshLock } from './refresh-lock'
import { decryptForRow, encryptForRow } from './secrets'

/** What `oauth_tokens.tokens` holds once decrypted. */
interface StoredTokens {
  accessToken: string
  refreshToken: string | null
}

/** Access tokens this close to expiring are refreshed before use, so they don't expire mid-request. */
const EXPIRY_MARGIN_MS = 60_000

export type AuthorizationCodeAuth = Extract<RestAuth, { type: 'oauth2AuthorizationCode' }>

/**
 * What connected accounts and signed-in variables were granted under: the consent settings of an
 * authorization-code resource, or a custom auth flow. Null for any other config. When it changes, they go.
 */
export function authFingerprint(type: string, config: unknown): string | null {
  const http = httpConfigFor(type, config)
  if (!http) return null
  if (http.auth.type === 'oauth2AuthorizationCode') return consentHash({ ...http, auth: http.auth })
  if (http.auth.type === 'custom') return customFlowHash(http)
  return null
}

/**
 * Whether queries on this config use each person's own credentials: a per-user OAuth account, or a custom flow with a
 * form step. What's cached from them (a GraphQL schema, HubSpot's properties) is then per person, and a live run
 * (nobody behind it) can't use the resource.
 */
export function usesOwnCredentials(type: string, config: unknown): boolean {
  if (authorizationCode(type, config)?.tokens === 'perUser') return true
  const http = httpConfigFor(type, config)
  return http?.auth.type === 'custom' && flowAsksEachPerson(http.auth.steps)
}

/**
 * Whether a person's own connection keeps working with nobody there to sign in again (a live run acting as its
 * publisher): it doesn't run out, or it can be renewed (an OAuth refresh token, a custom flow's refresh steps).
 */
export function renewable(keyring: Keyring, type: string, config: unknown, row: OAuthToken): boolean {
  if (!row.expiresAt) return true
  const http = httpConfigFor(type, config)
  if (http?.auth.type === 'custom') return http.auth.refreshSteps.length > 0
  return !!decryptTokens(keyring, row).refreshToken
}

/**
 * The authorization-code settings of an HTTP resource config (REST's, or what another type connects with; defaults
 * applied), or null for any other config.
 */
export function authorizationCode(type: string, config: unknown): AuthorizationCodeAuth | null {
  const http = httpConfigFor(type, config)
  return http?.auth.type === 'oauth2AuthorizationCode' ? http.auth : null
}

/**
 * Identifies what an account consented to and where its tokens go: the client, the URLs, what the consent screen
 * asked for, whose account it is (shared or per-user), and the hosts requests may reach (the base URL's origin and
 * the allowed hosts). Tokens granted under other settings aren't used or sent anywhere: the account has to be
 * connected again. So someone who may edit the resource can't point it, or a test of unsaved settings, at a host
 * of their own and receive the connected account's token.
 */
export function consentHash(config: {
  baseUrl: string
  allowedHosts: readonly string[]
  auth: AuthorizationCodeSettings & { tokens?: 'shared' | 'perUser' }
}): string {
  const { auth } = config
  const byKey = ([a]: string[], [b]: string[]) => (a! < b! ? -1 : a! > b! ? 1 : 0)
  const params = auth.authorizeParams
    .filter((p) => p.key)
    .map((p) => [p.key, p.value])
    .sort(byKey)
  const consent = [
    auth.authorizeUrl,
    auth.tokenUrl,
    auth.clientId,
    auth.scope.trim(),
    params,
    auth.tokens ?? 'shared',
    new URL(config.baseUrl).origin,
    config.allowedHosts.map((h) => h.trim().toLowerCase()).sort(),
  ]
  return createHash('sha256').update(JSON.stringify(consent)).digest('base64url')
}

/** The advisory lock serializing refreshes and replacements of one owner's connection. */
const ownerLock = (resourceConfigId: string, userId: string | null) =>
  `ow_oauth:${resourceConfigId}:${userId ?? 'shared'}`

const ownedBy = (userId: string | null) =>
  userId === null ? isNull(oauthTokens.userId) : eq(oauthTokens.userId, userId)

function decryptTokens(keyring: Keyring, row: OAuthToken): StoredTokens {
  return decryptForRow<StoredTokens>(keyring, 'oauth_tokens', row, row.tokens)
}

/** Stores a newly connected account, replacing the one the same owner had connected before. */
export async function saveTokens(
  db: Db,
  keyring: Keyring,
  input: {
    resourceConfigId: string
    environmentId: string
    /** Null for the shared account. */
    userId: string | null
    tokens: TokenSet
    consentHash: string
    connectedBy: string
  },
): Promise<void> {
  const stored: StoredTokens = {
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
  }
  const values = {
    expiresAt: input.tokens.expiresAt,
    scope: input.tokens.scope,
    account: input.tokens.account,
    status: 'active' as const,
    lastError: null,
    consentHash: input.consentHash,
    connectedBy: input.connectedBy,
    refreshedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  // The owner's lock (the one refreshes take): two connects finishing at once replace each other in turn.
  const lock = ownerLock(input.resourceConfigId, input.userId)
  await withRefreshLock(db, lock, AbortSignal.timeout(30_000), async (tx) => {
    const [existing] = await tx
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.resourceConfigId, input.resourceConfigId), ownedBy(input.userId)))
    // The row id is part of the encryption AAD, so a replacement keeps the existing row's id.
    const row = { id: existing?.id ?? uuidv7(), environmentId: input.environmentId }
    const tokens = encryptForRow(keyring, 'oauth_tokens', row, stored)
    if (existing) {
      await tx
        .update(oauthTokens)
        .set({ ...values, tokens })
        .where(eq(oauthTokens.id, existing.id))
    } else {
      await tx.insert(oauthTokens).values({
        ...row,
        resourceConfigId: input.resourceConfigId,
        userId: input.userId,
        tokens,
        ...values,
      })
    }
  })
}

/** Removes connected accounts: one owner's (null = the shared one), or every account when `userId` is omitted. */
export async function deleteTokens(
  db: Pick<Db, 'delete'>,
  resourceConfigId: string,
  userId?: string | null,
): Promise<number> {
  const rows = await db
    .delete(oauthTokens)
    .where(
      userId === undefined
        ? eq(oauthTokens.resourceConfigId, resourceConfigId)
        : and(eq(oauthTokens.resourceConfigId, resourceConfigId), ownedBy(userId)),
    )
    .returning({ id: oauthTokens.id })
  return rows.length
}

/** What Disconnect told the provider: `none` when there was nothing to tell (no URL, no tokens). */
export type Revocation = { revoked: 'yes' | 'none' } | { revoked: 'failed'; reason: string }

/**
 * Disconnects one owner's account: revokes it at the provider when the auth settings have a revocation URL and the
 * tokens were granted under the current consent settings (so they only go back where they came from), then forgets
 * them here whatever the provider answered.
 */
export async function disconnectAccount(
  db: Db,
  keyring: Keyring,
  target: {
    resourceConfigId: string
    userId: string | null
    auth: AuthorizationCodeSettings
    clientSecret: string | undefined
    allowPrivateNetwork: boolean
    consent: string | null
  },
): Promise<{ removed: number } & Revocation> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, target.resourceConfigId), ownedBy(target.userId)))
  let revocation: Revocation = { revoked: 'none' }
  if (row && target.auth.revokeUrl && row.consentHash === target.consent) {
    const stored = decryptTokens(keyring, row)
    const token = stored.refreshToken
      ? { value: stored.refreshToken, type: 'refresh_token' as const }
      : { value: stored.accessToken, type: 'access_token' as const }
    try {
      await revokeToken(target.auth, target.clientSecret, token, {
        signal: AbortSignal.timeout(10_000),
        allowPrivateNetwork: target.allowPrivateNetwork,
      })
      revocation = { revoked: 'yes' }
    } catch (err) {
      revocation = { revoked: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }
  }
  const removed = await deleteTokens(db, target.resourceConfigId, target.userId)
  return { removed, ...revocation }
}

export type ConnectionStatus =
  | { connected: false }
  | {
      connected: true
      /** `reconnect` when the provider refused the connection or the resource's consent settings changed. */
      status: 'active' | 'reconnect'
      reason: string | null
      account: string | null
      scope: string | null
      expiresAt: Date | null
      connectedAt: Date
      refreshedAt: Date | null
    }

/** What the UI shows about one owner's connection; never the tokens. */
export async function connectionStatus(
  db: Db,
  resourceConfigId: string,
  userId: string | null,
  currentConsent: string,
): Promise<ConnectionStatus> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, resourceConfigId), ownedBy(userId)))
  if (!row) return { connected: false }
  const problem = problemOf(row, currentConsent)
  return {
    connected: true,
    status: problem ? 'reconnect' : 'active',
    reason: problem,
    account: row.account,
    scope: row.scope,
    expiresAt: row.expiresAt,
    connectedAt: row.createdAt,
    refreshedAt: row.refreshedAt,
  }
}

/** Why a connection can't be used, or null when it can. */
function problemOf(row: OAuthToken, currentConsent: string): string | null {
  if (row.consentHash !== currentConsent) return 'settings_changed'
  if (row.status === 'reconnect') return row.lastError ?? 'refused'
  return null
}

export interface CredentialTarget {
  resourceId: string
  resourceConfigId: string
  environmentId: string
  /** Whose account to use: null for the shared one. */
  userId: string | null
  auth: AuthorizationCodeSettings
  clientSecret: string | undefined
  allowPrivateNetwork: boolean
  /** The resource's current `consentHash`: tokens stored under another aren't used. */
  consent: string
}

/**
 * Access tokens for one owner's connection, refreshed when they're about to expire or an API refused them.
 * Refreshes happen under the owner's advisory lock (`withRefreshLock`: waiters hold no database connection):
 * with providers that rotate refresh tokens (Microsoft, HubSpot), two workers refreshing at once would otherwise
 * spend the same refresh token twice and lose the connection. Whoever waited uses the token the other one stored.
 */
export function oauthCredentials(
  deps: { db: Db; keyring: Keyring },
  target: CredentialTarget,
): Required<Pick<CredentialSource, 'accessToken'>> {
  const { db, keyring } = deps
  const currentConsent = target.consent
  /** The token this source last handed out: a forced refresh replaces it unless someone already has. */
  let lastToken: string | undefined

  const fresh = (row: OAuthToken) => !row.expiresAt || row.expiresAt.getTime() > Date.now() + EXPIRY_MARGIN_MS

  const check = (row: OAuthToken | undefined): OAuthToken => {
    if (!row) throw notConnected(target)
    const problem = problemOf(row, currentConsent)
    if (problem) throw mustReconnect(target, problem)
    return row
  }

  async function refresh(refused: string | undefined, signal: AbortSignal): Promise<string> {
    let refusal: OAuthGrantError | undefined
    const token = await withRefreshLock(
      db,
      ownerLock(target.resourceConfigId, target.userId),
      signal,
      async (tx) => {
        const [locked] = await tx
          .select()
          .from(oauthTokens)
          .where(and(eq(oauthTokens.resourceConfigId, target.resourceConfigId), ownedBy(target.userId)))
        const row = check(locked)
        const stored = decryptTokens(keyring, row)
        // Someone refreshed while this waited for the lock.
        if (fresh(row) && (refused === undefined || stored.accessToken !== refused)) return stored.accessToken

        if (!stored.refreshToken) {
          // An API refused a token we can't refresh: let the request fail with the API's own answer.
          if (refused !== undefined && fresh(row)) return stored.accessToken
          refusal = new OAuthGrantError(
            'The access token expired and the provider gave no refresh token',
            'expired',
          )
          await tx
            .update(oauthTokens)
            .set({ status: 'reconnect', lastError: refusal.reason })
            .where(eq(oauthTokens.id, row.id))
          return undefined
        }

        let tokens: TokenSet
        try {
          tokens = await refreshAccessToken(target.auth, target.clientSecret, stored.refreshToken, {
            signal,
            allowPrivateNetwork: target.allowPrivateNetwork,
          })
        } catch (err) {
          if (!(err instanceof OAuthGrantError)) throw err
          // Committed (not rolled back): every later query should ask for a reconnect without calling the provider.
          refusal = err
          await tx
            .update(oauthTokens)
            .set({ status: 'reconnect', lastError: err.reason })
            .where(eq(oauthTokens.id, row.id))
          return undefined
        }
        const next: StoredTokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
        await tx
          .update(oauthTokens)
          .set({
            tokens: encryptForRow(keyring, 'oauth_tokens', row, next),
            expiresAt: tokens.expiresAt,
            scope: tokens.scope ?? row.scope,
            account: tokens.account ?? row.account,
            refreshedAt: new Date(),
          })
          .where(eq(oauthTokens.id, row.id))
        return tokens.accessToken
      },
    )
    if (token !== undefined) return token

    await recordAudit(db, {
      actorUserId: null,
      action: 'resource.oauth_refresh_failed',
      objectType: 'resource',
      objectId: target.resourceId,
      environmentId: target.environmentId,
      metadata: {
        reason: refusal!.reason,
        account: target.userId === null ? 'shared' : 'user',
        userId: target.userId,
      },
    })
    throw mustReconnect(target, refusal!.reason)
  }

  return {
    async accessToken({ signal, force }) {
      let token: string
      if (force) {
        token = await refresh(lastToken, signal)
      } else {
        const [row] = await db
          .select()
          .from(oauthTokens)
          .where(and(eq(oauthTokens.resourceConfigId, target.resourceConfigId), ownedBy(target.userId)))
        const usable = check(row)
        token = fresh(usable) ? decryptTokens(keyring, usable).accessToken : await refresh(undefined, signal)
      }
      lastToken = token
      return token
    },
  }
}

/**
 * The credentials a query against this resource config uses, or undefined when it doesn't connect accounts. A
 * shared account is everyone's; on per-user resources, `actingUserId`'s own account is used (a live workflow run's
 * is whoever published it), and a query nobody is behind fails.
 */
export function credentialsFor(
  deps: { db: Db; keyring: Keyring; sandbox: FlowSandbox },
  type: string,
  resource: ResolvedResource,
  actingUserId: string | null,
  opts: { store?: boolean } = {},
): CredentialSource | undefined {
  const http = httpConfigFor(type, resource.config)
  if (!http) return undefined
  if (http.auth.type === 'custom') {
    // Only REST-shaped secrets have the values a flow reads (REST, GraphQL). A flow with a form step keeps each
    // person's own variables: the person behind the query's.
    return customAuthCredentials(deps, {
      resourceId: resource.resourceId,
      userId: flowAsksEachPerson(http.auth.steps) ? actingUserId : null,
      resourceConfigId: resource.id,
      environmentId: resource.environmentId,
      config: http,
      secrets: restConnector.secretsSchema.parse(resource.secrets ?? {}),
      store: opts.store ?? true,
    })
  }
  if (http.auth.type !== 'oauth2AuthorizationCode') return undefined
  const auth = http.auth
  if (auth.tokens === 'perUser' && actingUserId === null) {
    return {
      async accessToken() {
        throw new ConnectorError(
          'auth_required',
          "This resource uses each person's own account, and nobody is behind this run: a live run uses the account of whoever published the workflow, and this release has none (published before that, from Git, or that person can no longer sign in). Make it live again as you (Publish ▾ → Make live again), or use a resource with a shared account.",
          {
            reason: 'no_user',
            account: 'user',
            resourceId: resource.resourceId,
            environmentId: resource.environmentId,
          },
        )
      },
    }
  }
  const secrets = resource.secrets as { clientSecret?: unknown }
  return oauthCredentials(deps, {
    resourceId: resource.resourceId,
    resourceConfigId: resource.id,
    environmentId: resource.environmentId,
    userId: auth.tokens === 'shared' ? null : actingUserId,
    auth,
    clientSecret: typeof secrets.clientSecret === 'string' ? secrets.clientSecret : undefined,
    allowPrivateNetwork: http.allowPrivateNetwork,
    consent: consentHash({ ...http, auth }),
  })
}

/** What the UI needs to offer a Connect button: whose account, and for which resource and environment. */
function authDetails(target: CredentialTarget, reason: string) {
  return {
    reason,
    account: target.userId === null ? 'shared' : 'user',
    resourceId: target.resourceId,
    environmentId: target.environmentId,
  }
}

function notConnected(target: CredentialTarget): ConnectorError {
  return new ConnectorError(
    'auth_required',
    target.userId === null
      ? "No account is connected to this resource in this environment. Connect one in the resource's settings."
      : 'Connect your account to this resource to use it.',
    authDetails(target, 'not_connected'),
  )
}

function mustReconnect(target: CredentialTarget, reason: string): ConnectorError {
  const why =
    reason === 'settings_changed'
      ? "the resource's OAuth settings changed since it was connected"
      : `the provider no longer accepts it (${reason})`
  return new ConnectorError(
    'auth_required',
    target.userId === null
      ? `The account connected to this resource must be connected again: ${why}.`
      : `Connect your account to this resource again: ${why}.`,
    authDetails(target, reason),
  )
}
