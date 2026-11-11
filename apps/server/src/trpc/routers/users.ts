import { groupMembers, groups, sessions, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { adminProcedure, authedProcedure, router } from '../init'

export const usersRouter = router({
  /** Everyone who can sign in, by name: whom an owner can give access to (any signed-in person may look). */
  directory: authedProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(isNull(users.disabledAt))
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
