import { createHash, randomBytes } from 'node:crypto'
import { hashApiKey } from '@ow/crypto'
import {
  type AccessTokenScope,
  type Db,
  groupMembers,
  groups,
  personalAccessTokens,
  sessions,
  users,
} from '@ow/db'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'

export const SESSION_COOKIE = 'ow_session'

export interface SessionUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  isAdmin: boolean
  sessionId: string
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Creates a session and returns the opaque token for the cookie. Only its hash is stored. */
export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000)
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 500),
  })
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId))
  return { token, expiresAt }
}

const isAdminSql = sql<boolean>`exists (
  select 1 from ${groupMembers} gm join ${groups} g on g.id = gm.group_id
  where gm.user_id = ${users.id} and g.system_kind = 'admins'
)`

export async function lookupSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const isAdmin = isAdminSql
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      isAdmin,
      sessionId: sessions.id,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        isNull(users.disabledAt),
        eq(users.status, 'active'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function deleteSession(db: Db, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

/** A personal access token a request presents (M33): `Authorization: Bearer owpat_…`. */
export function presentedAccessToken(headers: Record<string, unknown>): string | null {
  const auth = headers.authorization
  if (typeof auth !== 'string') return null
  const bearer = /^Bearer\s+(owpat_\S+)$/i.exec(auth.trim())
  return bearer ? bearer[1]! : null
}

/** The user a token acts as and what it may do: its user active, the token neither revoked nor expired. */
export interface TokenUser {
  user: SessionUser
  token: { id: string; prefix: string; scopes: AccessTokenScope[] }
}

/**
 * The user behind an access token, or null (unknown, revoked, expired, or its user disabled). Looked up by the
 * token's sha256 (256 random bits: indexed equality is enough). Records the use at most once a minute, unawaited.
 */
export async function lookupAccessToken(db: Db, token: string): Promise<TokenUser | null> {
  if (!token.startsWith('owpat_') || token.length > 200) return null
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      isAdmin: isAdminSql,
      tokenId: personalAccessTokens.id,
      prefix: personalAccessTokens.prefix,
      scopes: personalAccessTokens.scopes,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(
      and(
        eq(personalAccessTokens.hash, hashApiKey(token)),
        isNull(personalAccessTokens.revokedAt),
        or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, new Date())),
        isNull(users.disabledAt),
        eq(users.status, 'active'),
      ),
    )
    .limit(1)
  if (!row) return null
  void db
    .execute(sql`
      update personal_access_tokens set last_used_at = now()
      where id = ${row.tokenId} and (last_used_at is null or last_used_at < now() - interval '1 minute')`)
    .catch(() => {})
  const { tokenId, prefix, scopes, ...user } = row
  return { user: { ...user, sessionId: `token:${tokenId}` }, token: { id: tokenId, prefix, scopes } }
}
