import {
  apps,
  type Db,
  environments,
  folders,
  groups,
  PERMISSION_LEVELS,
  permissions,
  resources,
  workflows,
} from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { loadAccess, requireLevel } from '../../services/permissions'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()

/** Grants on one resource, workflow or app, on one folder, or (`objectId` null) on all objects of a type. */
const Target = z.object({
  objectType: z.enum(['resource', 'workflow', 'app', 'folder']),
  objectId: Id.nullable(),
})

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/**
 * Owners of a resource (in every environment), a workflow or an app manage its grants; folder grants and grants on all
 * resources or workflows are admin-only, since they reach many objects at once.
 */
async function assertCanManage(ctx: AuthedContext, target: z.infer<typeof Target>): Promise<void> {
  if (ctx.user.isAdmin) return
  if (target.objectType === 'folder' || target.objectId === null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins manage folder-wide and type-wide access' })
  }
  if (target.objectType === 'workflow') {
    const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, target.objectId)).limit(1)
    const access = await loadAccess(ctx.db, ctx.user)
    if (!workflow || access.workflowLevel(workflow) === null) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found' })
    }
    requireLevel(access.workflowLevel(workflow), 'own', 'this workflow')
    return
  }
  if (target.objectType === 'app') {
    const [app] = await ctx.db.select().from(apps).where(eq(apps.id, target.objectId)).limit(1)
    const access = await loadAccess(ctx.db, ctx.user)
    if (!app || access.appLevel(app) === null)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'App not found' })
    requireLevel(access.appLevel(app), 'own', 'this app')
    return
  }
  const [resource] = await ctx.db.select().from(resources).where(eq(resources.id, target.objectId)).limit(1)
  if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' })
  const access = await loadAccess(ctx.db, ctx.user)
  const envIds = (await ctx.db.select({ id: environments.id }).from(environments)).map((e) => e.id)
  requireLevel(access.levelEverywhere(resource, envIds), 'own', 'this resource in every environment')
}

function targetWhere(target: z.infer<typeof Target>) {
  return and(
    eq(permissions.objectType, target.objectType),
    target.objectId === null ? isNull(permissions.objectId) : eq(permissions.objectId, target.objectId),
  )
}

async function describeTarget(db: Db, target: z.infer<typeof Target>): Promise<string> {
  if (target.objectId === null) return `all ${target.objectType}s`
  if (target.objectType === 'folder') {
    const [folder] = await db
      .select({ name: folders.name })
      .from(folders)
      .where(eq(folders.id, target.objectId))
    return `folder ${folder?.name ?? target.objectId}`
  }
  return `${target.objectType} ${target.objectId}`
}

export const permissionsRouter = router({
  list: authedProcedure.input(Target).query(async ({ ctx, input }) => {
    await assertCanManage(ctx, input)
    return ctx.db
      .select({
        id: permissions.id,
        groupId: permissions.groupId,
        groupName: groups.name,
        environmentId: permissions.environmentId,
        level: permissions.level,
      })
      .from(permissions)
      .innerJoin(groups, eq(groups.id, permissions.groupId))
      .where(targetWhere(input))
      .orderBy(asc(groups.name))
  }),

  /** Sets (or with `level: null`, removes) one group's grant on a target, for one environment or all (`null`). */
  set: authedProcedure
    .input(
      Target.extend({
        groupId: Id,
        environmentId: Id.nullable(),
        level: z.enum(PERMISSION_LEVELS).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanManage(ctx, input)
      if ((input.objectType === 'workflow' || input.objectType === 'app') && input.environmentId !== null) {
        const what = input.objectType === 'app' ? 'App' : 'Workflow'
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${what} access applies to every environment` })
      }
      // Likewise for their folders: a grant for one environment would never count.
      if (input.objectType === 'folder' && input.objectId !== null && input.environmentId !== null) {
        const [folder] = await ctx.db
          .select({ objectType: folders.objectType })
          .from(folders)
          .where(eq(folders.id, input.objectId))
        if (folder && folder.objectType !== 'resource') {
          const what = folder.objectType === 'app' ? 'App' : 'Workflow'
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `${what} folder access applies to every environment`,
          })
        }
      }
      const [group] = await ctx.db
        .select({ name: groups.name })
        .from(groups)
        .where(eq(groups.id, input.groupId))
      if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
      await ctx.db.transaction(async (tx) => {
        await tx
          .delete(permissions)
          .where(
            and(
              targetWhere(input),
              eq(permissions.groupId, input.groupId),
              input.environmentId === null
                ? isNull(permissions.environmentId)
                : eq(permissions.environmentId, input.environmentId),
            ),
          )
        if (input.level) {
          await tx.insert(permissions).values({
            groupId: input.groupId,
            objectType: input.objectType,
            objectId: input.objectId,
            environmentId: input.environmentId,
            level: input.level,
          })
        }
      })
      await ctx.audit({
        action: input.level ? 'permission.granted' : 'permission.revoked',
        objectType: input.objectType,
        objectId: input.objectId ?? undefined,
        environmentId: input.environmentId ?? undefined,
        metadata: { group: group.name, target: await describeTarget(ctx.db, input), level: input.level },
      })
    }),
})
