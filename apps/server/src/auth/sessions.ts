import { createHash, randomBytes } from 'node:crypto'
import { type Db, groupMembers, groups, sessions, users } from '@ow/db'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'

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

export async function lookupSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const isAdmin = sql<boolean>`exists (
    select 1 from ${groupMembers} gm join ${groups} g on g.id = gm.group_id
    where gm.user_id = ${users.id} and g.system_kind = 'admins'
  )`
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
      ),
    )
    .limit(1)
  return row ?? null
}

export async function deleteSession(db: Db, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}
