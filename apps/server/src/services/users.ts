import { type Db, groupMembers, groups, users } from '@ow/db'
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
 * the very first user of the installation an admin. Returns the user id and whether it was created.
 */
export async function provisionUser(
  db: Db,
  input: ProvisionInput,
  opts: { makeAdmin?: boolean } = {},
): Promise<{ id: string; created: boolean; disabled: boolean }> {
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
    if (existing) {
      id = existing.id
      disabled = existing.disabledAt !== null
      await tx
        .update(users)
        .set({
          email,
          name: input.name || existing.name,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl,
          oidcSubject: input.oidcSubject ?? existing.oidcSubject,
          passwordHash: input.passwordHash ?? existing.passwordHash,
        })
        .where(eq(users.id, id))
    } else {
      const [{ total }] = (await tx.select({ total: count() }).from(users)) as [{ total: number }]
      const [row] = await tx
        .insert(users)
        .values({
          email,
          name: input.name || email,
          avatarUrl: input.avatarUrl ?? null,
          oidcSubject: input.oidcSubject,
          passwordHash: input.passwordHash,
        })
        .returning({ id: users.id })
      id = row!.id
      created = true
      if (total === 0) opts = { ...opts, makeAdmin: true }
    }

    const memberships = [await systemGroupId(tx, 'all_users')]
    if (opts.makeAdmin) memberships.push(await systemGroupId(tx, 'admins'))
    await tx
      .insert(groupMembers)
      .values(memberships.map((groupId) => ({ groupId, userId: id })))
      .onConflictDoNothing()

    return { id, created, disabled }
  })
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
