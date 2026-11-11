import { type Db, groupMembers, groups, type UserStatus, users } from '@ow/db'
import { and, count, eq, or, sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Arbitrary constant: serializes user provisioning so "first user becomes admin" can't race. */
const PROVISION_LOCK_ID = 727_002

export async function systemGroupId(db: Db | Tx, kind: 'admins' | 'all_users'): Promise<string> {
  const [row] = await db.select({ id: groups.id }).from(groups).where(eq(groups.systemKind, kind)).limit(1)
  if (!row) throw new Error(`System group "${kind}" is missing — have migrations run?`)
  return row.id
}

export interface ProvisionInput {
  email: string
  name: string
  avatarUrl?: string | null
  oidcSubject?: string
  passwordHash?: string
}

/**
 * Creates or updates a user (matched by OIDC subject, then email), ensures All Users membership, and makes
 * the very first user of the installation an admin. A new user gets `status` (`pending` for a first sign-in that
 * waits for an admin; `active` by default, as the CLI's); the installation's first user is always an active admin.
 * Someone `invited` becomes `active` here, at their first sign-in. Returns the user id, whether it was created, and
 * their status.
 */
export async function provisionUser(
  db: Db,
  input: ProvisionInput,
  opts: { makeAdmin?: boolean; status?: 'active' | 'pending' } = {},
): Promise<{ id: string; created: boolean; disabled: boolean; status: UserStatus }> {
  const email = input.email.trim().toLowerCase()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROVISION_LOCK_ID})`)

    const match = input.oidcSubject
      ? or(eq(users.oidcSubject, input.oidcSubject), eq(users.email, email))
      : eq(users.email, email)
    const [existing] = await tx.select().from(users).where(match).limit(1)

    let id: string
    let created = false
    let disabled = false
    let status: UserStatus
    if (existing) {
      id = existing.id
      disabled = existing.disabledAt !== null
      // An invitation is an admin's yes: the first sign-in takes it up.
      status = existing.status === 'invited' ? 'active' : existing.status
      await tx
        .update(users)
        .set({
          email,
          name: input.name || existing.name,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl,
          oidcSubject: input.oidcSubject ?? existing.oidcSubject,
          passwordHash: input.passwordHash ?? existing.passwordHash,
          status,
        })
        .where(eq(users.id, id))
    } else {
      const [{ total }] = (await tx.select({ total: count() }).from(users)) as [{ total: number }]
      if (total === 0) opts = { ...opts, makeAdmin: true }
      // The installation's first person and the CLI's admins are let in; anyone else may have to wait.
      status = opts.makeAdmin ? 'active' : (opts.status ?? 'active')
      const [row] = await tx
        .insert(users)
        .values({
          email,
          name: input.name || email,
          avatarUrl: input.avatarUrl ?? null,
          oidcSubject: input.oidcSubject,
          passwordHash: input.passwordHash,
          status,
          requestedAt: status === 'pending' ? new Date() : null,
        })
        .returning({ id: users.id })
      id = row!.id
      created = true
    }

    const memberships = [await systemGroupId(tx, 'all_users')]
    if (opts.makeAdmin) memberships.push(await systemGroupId(tx, 'admins'))
    await tx
      .insert(groupMembers)
      .values(memberships.map((groupId) => ({ groupId, userId: id })))
      .onConflictDoNothing()

    return { id, created, disabled, status }
  })
}

/**
 * Who may get in through Google: inside the allowed domain (`hd` matching when Google sends it), or someone already
 * known (invited by an admin, or with an account); never a disabled or rejected account. Pending people pass here and
 * are stopped after provisioning (no session, the waiting page).
 */
export function signInDecision(input: {
  email: string
  domain: string
  hd?: string
  existing: { status: UserStatus; disabled: boolean } | null
}): { ok: true } | { ok: false; reason: string } {
  const { email, domain, hd, existing } = input
  if (existing?.disabled) return { ok: false, reason: 'Your account has been disabled' }
  if (existing?.status === 'rejected') {
    return { ok: false, reason: 'Your request to use Optiply Workflows was not approved' }
  }
  const inDomain = email.endsWith(`@${domain}`) && (hd === undefined || hd === domain)
  if (!existing && !inDomain)
    return { ok: false, reason: `Only @${domain} accounts or invited people can sign in` }
  return { ok: true }
}

/**
 * A new person asked to get in: admins see them in Settings → Users (and its badge) at once. Email comes later (the
 * user's choice for now): it plugs in here, once per request.
 */
export function notifyAdminsOfRequest(
  log: { info: (o: object, msg: string) => void },
  user: { email: string },
) {
  log.info({ email: user.email }, 'access requested: waiting for an admin')
}

export async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const adminsId = await systemGroupId(db, 'admins')
  const [row] = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, adminsId), eq(groupMembers.userId, userId)))
    .limit(1)
  return Boolean(row)
}
