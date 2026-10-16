import { createHash } from 'node:crypto'
import {
  type AuthorizationCodeSettings,
  ConnectorError,
  type CredentialSource,
  OAuthGrantError,
  refreshAccessToken,
  type TokenSet,
} from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import { type Db, type OAuthToken, oauthTokens } from '@ow/db'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { recordAudit } from '../audit'
import { decryptForRow, encryptForRow } from './secrets'

/** What `oauth_tokens.tokens` holds once decrypted. */
interface StoredTokens {
  accessToken: string
  refreshToken: string | null
}

/** Access tokens this close to expiring are refreshed before use, so they don't expire mid-request. */
const EXPIRY_MARGIN_MS = 60_000

/** The authorization-code settings of a REST resource config, or null when it uses another kind of auth. */
export function authorizationCode(config: unknown): AuthorizationCodeSettings | null {
  const auth = (config as { auth?: { type?: string } } | null)?.auth
  return auth?.type === 'oauth2AuthorizationCode' ? (auth as AuthorizationCodeSettings) : null
}

/**
 * Identifies what an account consented to: the client, the URLs and what the consent screen asked for. Tokens
 * granted under other settings can't be used (the account has to be connected again).
 */
export function consentHash(auth: AuthorizationCodeSettings): string {
  const params = auth.authorizeParams
    .filter((p) => p.key)
    .map((p) => [p.key, p.value])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
  const consent = [auth.authorizeUrl, auth.tokenUrl, auth.clientId, auth.scope.trim(), params]
  return createHash('sha256').update(JSON.stringify(consent)).digest('base64url')
}

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
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.resourceConfigId, input.resourceConfigId), ownedBy(input.userId)))
      .for('update')
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
}

/**
 * Access tokens for one owner's connection, refreshed when they're about to expire or an API refused them.
 * Refreshes happen under the token row's lock: with providers that rotate refresh tokens (Microsoft, HubSpot),
 * two workers refreshing at once would otherwise spend the same refresh token twice and lose the connection.
 * Whoever waited for the lock uses the token the other one stored.
 */
export function oauthCredentials(
  deps: { db: Db; keyring: Keyring },
  target: CredentialTarget,
): CredentialSource {
  const { db, keyring } = deps
  const currentConsent = consentHash(target.auth)
  /** The token this source last handed out: a forced refresh replaces it unless someone already has. */
  let lastToken: string | undefined

  const fresh = (row: OAuthToken) => !row.expiresAt || row.expiresAt.getTime() > Date.now() + EXPIRY_MARGIN_MS

  const check = (row: OAuthToken | undefined): OAuthToken => {
    if (!row) throw notConnected(target.userId)
    const problem = problemOf(row, currentConsent)
    if (problem) throw mustReconnect(target.userId, problem)
    return row
  }

  async function refresh(refused: string | undefined, signal: AbortSignal): Promise<string> {
    let refusal: OAuthGrantError | undefined
    const token = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(oauthTokens)
        .where(and(eq(oauthTokens.resourceConfigId, target.resourceConfigId), ownedBy(target.userId)))
        .for('update')
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
    })
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
    throw mustReconnect(target.userId, refusal!.reason)
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

function notConnected(userId: string | null): ConnectorError {
  return new ConnectorError(
    'auth_required',
    userId === null
      ? "No account is connected to this resource in this environment. Connect one in the resource's settings."
      : 'Connect your account to this resource to use it.',
    { reason: 'not_connected', account: userId === null ? 'shared' : 'user' },
  )
}

function mustReconnect(userId: string | null, reason: string): ConnectorError {
  const why =
    reason === 'settings_changed'
      ? "the resource's OAuth settings changed since it was connected"
      : `the provider no longer accepts it (${reason})`
  return new ConnectorError(
    'auth_required',
    userId === null
      ? `The account connected to this resource must be connected again: ${why}.`
      : `Connect your account to this resource again: ${why}.`,
    { reason, account: userId === null ? 'shared' : 'user' },
  )
}
