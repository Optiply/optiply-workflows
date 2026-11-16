import { type Db, groupMembers, groups, type UserAccess, type UserStatus, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, count, eq, or, sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Arbitrary constant: serializes user provisioning so "first user becomes admin" can't race. */
const PROVISION_LOCK_ID = 727_002
/** Arbitrary constant: serializes changes to who is in Admins or apps only, so the rule between them can't race. */
const ADMINS_APPS_ONLY_LOCK_ID = 727_003

/**
 * Admins always have the whole platform: someone apps only can't be in Admins. Checks the person as they'll be after a
 * change (their access, set or kept; their groups, added to), inside the change's transaction and under a lock, so two
 * admins changing the same person at once (one making them apps only, the other an admin) can't both pass.
 */
export async function refuseAdminAndAppsOnly(
  tx: Tx,
  change: { userId: string | null; email: string; access?: UserAccess; addGroupIds?: string[] },
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMINS_APPS_ONLY_LOCK_ID})`)
  const adminsId = await systemGroupId(tx, 'admins')
  const [current] = change.userId
    ? await tx.select({ access: users.access }).from(users).where(eq(users.id, change.userId))
    : []
  const access = change.access ?? current?.access ?? 'full'
  if (access !== 'apps_only') return
  const joining = (change.addGroupIds ?? []).includes(adminsId)
  const [member] =
    !joining && change.userId
      ? await tx
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(and(eq(groupMembers.groupId, adminsId), eq(groupMembers.userId, change.userId)))
      : []
  if (joining || member) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${change.email} can't be in Admins and have access to apps only: admins always have the whole platform`,
    })
  }
}

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
  opts: {
    makeAdmin?: boolean
    status?: 'active' | 'pending'
    /**
     * Whether this person may get in at all (Google's sign-in: `signInDecision`), asked inside the lock about the very
     * row about to be used, so an invitation cancelled meanwhile can't turn into a request. Refusing throws
     * `SignInRefused` and changes nothing.
     */
    admit?: (existing: ExistingUser | null) => SignInVerdict
  } = {},
): Promise<{ id: string; created: boolean; disabled: boolean; status: UserStatus }> {
  const email = input.email.trim().toLowerCase()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROVISION_LOCK_ID})`)

    const match = input.oidcSubject
      ? or(eq(users.oidcSubject, input.oidcSubject), eq(users.email, email))
      : eq(users.email, email)
    // The Google account's own row first, when the subject and the email point at different rows.
    const [existing] = await tx
      .select()
      .from(users)
      .where(match)
      .orderBy(
        input.oidcSubject ? sql`(${users.oidcSubject} = ${input.oidcSubject}) desc nulls last` : users.id,
      )
      .limit(1)
    if (opts.admit) {
      const verdict = opts.admit(
        existing
          ? {
              status: existing.status,
              disabled: existing.disabledAt !== null,
              oidcSubject: existing.oidcSubject,
            }
          : null,
      )
      if (!verdict.ok) throw new SignInRefused(verdict.reason)
    }

    let id: string
    let created = false
    let disabled = false
    let status: UserStatus
    if (existing) {
      id = existing.id
      disabled = existing.disabledAt !== null
      // An invitation is an admin's yes: the first sign-in takes it up.
      // The CLI's break-glass admin is let in too, even over a request still waiting (or turned down).
      status = existing.status === 'invited' || opts.makeAdmin ? 'active' : existing.status
      await tx
        .update(users)
        .set({
          email,
          name: input.name || existing.name,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl,
          oidcSubject: input.oidcSubject ?? existing.oidcSubject,
          passwordHash: input.passwordHash ?? existing.passwordHash,
          status,
          // The CLI's break-glass admin always has the whole platform.
          ...(opts.makeAdmin ? { access: 'full' as const } : {}),
          ...(status !== existing.status && existing.status !== 'invited' ? { decidedAt: new Date() } : {}),
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

export interface ExistingUser {
  status: UserStatus
  disabled: boolean
  oidcSubject: string | null
}
export type SignInVerdict = { ok: true } | { ok: false; reason: string }

/** `provisionUser`'s `admit` said no: the reason is for the sign-in page. */
export class SignInRefused extends Error {}

/**
 * Who may get in through Google: anyone inside the allowed domain (`hd` matching when Google sends it); outside it,
 * only someone an admin invited, or who signed in with this same Google account before (an invitation taken up).
 * Never a disabled or rejected account. A password-only account outside the domain (a break-glass admin) doesn't
 * open to whoever holds that Google address. Pending people pass here and are stopped after provisioning (no
 * session, the waiting page).
 */
export function signInDecision(input: {
  email: string
  domain: string
  hd?: string
  /** Google's subject for this account. */
  sub: string
  existing: ExistingUser | null
}): SignInVerdict {
  const { email, domain, hd, sub, existing } = input
  if (existing?.disabled) return { ok: false, reason: 'Your account has been disabled' }
  if (existing?.status === 'rejected') {
    return { ok: false, reason: 'Your request to use Optiply Workflows was not approved' }
  }
  const inDomain = email.endsWith(`@${domain}`) && (hd === undefined || hd === domain)
  const knownOutsider =
    existing?.status === 'invited' || (existing?.oidcSubject != null && existing.oidcSubject === sub)
  if (!inDomain && !knownOutsider) {
    return { ok: false, reason: `Only @${domain} accounts or invited people can sign in` }
  }
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
