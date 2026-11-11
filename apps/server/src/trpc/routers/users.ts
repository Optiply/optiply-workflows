import { type Db, groupMembers, groups, sessions, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { adminProcedure, authedProcedure, router } from '../init'

const Id = z.string().uuid()
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** The user, refused unless their status is one of `allowed` (approving someone active makes no sense). */
async function userWithStatus(db: Db, userId: string, allowed: string[]) {
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Person not found' })
  if (!allowed.includes(user.status)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${user.email} is ${user.status}` })
  }
  return user
}

/** All Users always, and the chosen groups (built-in Admins included, when an admin picks it). */
async function addToGroups(tx: Tx, userId: string, groupIds: string[]) {
  const [everyone] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.systemKind, 'all_users'))
  const ids = [...new Set([...(everyone ? [everyone.id] : []), ...groupIds])]
  const known = ids.length
    ? await tx.select({ id: groups.id }).from(groups).where(inArray(groups.id, ids))
    : []
  if (known.length !== ids.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown group' })
  await tx
    .insert(groupMembers)
    .values(ids.map((groupId) => ({ groupId, userId })))
    .onConflictDoNothing()
}

async function groupNames(db: Db, ids: string[]) {
  if (!ids.length) return []
  return (await db.select({ name: groups.name }).from(groups).where(inArray(groups.id, ids))).map(
    (g) => g.name,
  )
}

export const usersRouter = router({
  /** Everyone who can sign in, by name: whom an owner can give access to (any signed-in person may look). */
  directory: authedProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(isNull(users.disabledAt), eq(users.status, 'active')))
      .orderBy(asc(users.name)),
  ),

  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        hasPassword: users.passwordHash,
        sso: users.oidcSubject,
        disabledAt: users.disabledAt,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        status: users.status,
        requestedAt: users.requestedAt,
        decidedAt: users.decidedAt,
        invitedBy: users.invitedBy,
      })
      .from(users)
      .orderBy(asc(users.email))
    const memberships = await ctx.db
      .select({ userId: groupMembers.userId, groupId: groups.id, groupName: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    return rows.map(({ hasPassword, sso, ...u }) => ({
      ...u,
      loginMethods: [sso ? 'sso' : null, hasPassword ? 'password' : null].filter(Boolean) as string[],
      groups: memberships.filter((m) => m.userId === u.id).map((m) => ({ id: m.groupId, name: m.groupName })),
    }))
  }),

  /** How many people wait for an admin's approval: the badge on Settings and on the Users tab. */
  pendingCount: adminProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select({ n: count() }).from(users).where(eq(users.status, 'pending'))
    return row?.n ?? 0
  }),

  /**
   * Lets a waiting (or earlier rejected) person in, in the chosen groups as well as All Users. They can sign in at
   * once; their access is what those groups (and grants to them) give.
   */
  approve: adminProcedure
    .input(z.object({ userId: Id, groupIds: z.array(Id).max(50).default([]) }))
    .mutation(async ({ ctx, input }) => {
      const user = await userWithStatus(ctx.db, input.userId, ['pending', 'rejected'])
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ status: 'active', decidedAt: new Date(), decidedBy: ctx.user.id })
          .where(eq(users.id, user.id))
        await addToGroups(tx, user.id, input.groupIds)
      })
      await ctx.audit({
        action: 'user.approved',
        objectType: 'user',
        objectId: user.id,
        metadata: { email: user.email, groups: await groupNames(ctx.db, input.groupIds) },
      })
    }),

  /** Turns a waiting person down: they can't sign in, and signing in again doesn't ask again. Approve undoes it. */
  reject: adminProcedure.input(z.object({ userId: Id })).mutation(async ({ ctx, input }) => {
    const user = await userWithStatus(ctx.db, input.userId, ['pending'])
    await ctx.db
      .update(users)
      .set({ status: 'rejected', decidedAt: new Date(), decidedBy: ctx.user.id })
      .where(eq(users.id, user.id))
    await ctx.audit({
      action: 'user.rejected',
      objectType: 'user',
      objectId: user.id,
      metadata: { email: user.email },
    })
  }),

  /**
   * Invites someone by email, from any domain (people outside Optiply get in only this way): they sign in with
   * Google as that address and are in at once, in the chosen groups.
   */
  invite: adminProcedure
    .input(
      z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        name: z.string().trim().max(200).optional(),
        groupIds: z.array(Id).max(50).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.email, input.email))
      if (existing) {
        const what =
          existing.status === 'pending'
            ? 'is waiting for approval: approve them instead'
            : existing.status === 'invited'
              ? 'is invited already'
              : 'has an account already'
        throw new TRPCError({ code: 'CONFLICT', message: `${input.email} ${what}` })
      }
      const id = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            email: input.email,
            name: input.name || input.email.split('@')[0]!,
            status: 'invited',
            invitedBy: ctx.user.id,
          })
          .returning({ id: users.id })
        await addToGroups(tx, row!.id, input.groupIds)
        return row!.id
      })
      await ctx.audit({
        action: 'user.invited',
        objectType: 'user',
        objectId: id,
        metadata: { email: input.email, groups: await groupNames(ctx.db, input.groupIds) },
      })
      return { id }
    }),

  /** Withdraws an invitation nobody took up yet (the account never signed in, so it goes entirely). */
  cancelInvite: adminProcedure.input(z.object({ userId: Id })).mutation(async ({ ctx, input }) => {
    const user = await userWithStatus(ctx.db, input.userId, ['invited'])
    await ctx.db.delete(users).where(eq(users.id, user.id))
    await ctx.audit({
      action: 'user.invite_cancelled',
      objectType: 'user',
      objectId: user.id,
      metadata: { email: user.email },
    })
  }),

  setDisabled: adminProcedure
    .input(z.object({ userId: z.string().uuid(), disabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot disable your own account' })
      }
      const [updated] = await ctx.db
        .update(users)
        .set({ disabledAt: input.disabled ? new Date() : null })
        .where(eq(users.id, input.userId))
        .returning({ id: users.id, email: users.email })
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' })
      if (input.disabled) await ctx.db.delete(sessions).where(eq(sessions.userId, input.userId))
      await ctx.audit({
        action: input.disabled ? 'user.disabled' : 'user.enabled',
        objectType: 'user',
        objectId: updated.id,
        metadata: { email: updated.email },
      })
    }),
})
