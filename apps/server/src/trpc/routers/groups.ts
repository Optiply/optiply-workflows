import { type Db, groupMembers, groups, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, count, eq } from 'drizzle-orm'
import { z } from 'zod'
import { adminProcedure, authedProcedure, router } from '../init'

const GroupName = z.string().trim().min(1).max(80)

async function getGroup(db: Db, id: string) {
  const [group] = await db.select().from(groups).where(eq(groups.id, id)).limit(1)
  if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
  return group
}

function assertNotSystem(group: { systemKind: string | null }, what: string) {
  if (group.systemKind)
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Built-in groups cannot be ${what}` })
}

/** Maps unique-violation on groups.name to a friendly error. */
async function withUniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const code =
      (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code
    if (code === '23505')
      throw new TRPCError({ code: 'CONFLICT', message: 'A group with that name already exists' })
    throw err
  }
}

export const groupsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        systemKind: groups.systemKind,
        memberCount: count(groupMembers.userId),
      })
      .from(groups)
      .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .groupBy(groups.id)
      .orderBy(asc(groups.systemKind), asc(groups.name))
  }),

  get: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const group = await getGroup(ctx.db, input.id)
    const members = await ctx.db
      .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, group.id))
      .orderBy(asc(users.email))
    return { ...group, members }
  }),

  create: adminProcedure
    .input(z.object({ name: GroupName, description: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [group] = await withUniqueName(() =>
        ctx.db.insert(groups).values({ name: input.name, description: input.description }).returning(),
      )
      await ctx.audit({ action: 'group.created', objectType: 'group', objectId: group!.id, metadata: input })
      return group!
    }),

  update: adminProcedure
    .input(z.object({ id: z.string().uuid(), name: GroupName, description: z.string().max(500).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const group = await getGroup(ctx.db, input.id)
      if (group.systemKind && input.name !== group.name) assertNotSystem(group, 'renamed')
      await withUniqueName(() =>
        ctx.db
          .update(groups)
          .set({ name: input.name, description: input.description })
          .where(eq(groups.id, input.id)),
      )
      await ctx.audit({
        action: 'group.updated',
        objectType: 'group',
        objectId: input.id,
        metadata: { from: { name: group.name, description: group.description }, to: input },
      })
    }),

  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const group = await getGroup(ctx.db, input.id)
    assertNotSystem(group, 'deleted')
    await ctx.db.delete(groups).where(eq(groups.id, input.id))
    await ctx.audit({
      action: 'group.deleted',
      objectType: 'group',
      objectId: input.id,
      metadata: { name: group.name },
    })
  }),

  addMember: adminProcedure
    .input(z.object({ groupId: z.string().uuid(), userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const group = await getGroup(ctx.db, input.groupId)
      if (group.systemKind === 'all_users') assertNotSystem(group, 'edited — every user is a member')
      const [user] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, input.userId))
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' })
      await ctx.db.insert(groupMembers).values(input).onConflictDoNothing()
      await ctx.audit({
        action: 'group.member_added',
        objectType: 'group',
        objectId: group.id,
        metadata: { group: group.name, user: user.email },
      })
    }),

  removeMember: adminProcedure
    .input(z.object({ groupId: z.string().uuid(), userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const group = await getGroup(ctx.db, input.groupId)
      if (group.systemKind === 'all_users') assertNotSystem(group, 'edited — every user is a member')
      await ctx.db.transaction(async (tx) => {
        if (group.systemKind === 'admins') {
          // Lock the admins' membership rows so two concurrent removals can't both pass the check.
          const admins = await tx
            .select({ userId: groupMembers.userId })
            .from(groupMembers)
            .where(eq(groupMembers.groupId, group.id))
            .for('update')
          if (admins.length <= 1 && admins.some((a) => a.userId === input.userId)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot remove the last admin' })
          }
        }
        await tx
          .delete(groupMembers)
          .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
      })
      const [user] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, input.userId))
      await ctx.audit({
        action: 'group.member_removed',
        objectType: 'group',
        objectId: group.id,
        metadata: { group: group.name, user: user?.email },
      })
    }),
})
