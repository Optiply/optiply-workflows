import {
  apps,
  componentLibraries,
  type Db,
  environments,
  folders,
  groups,
  libraryQueries,
  modules,
  PERMISSION_LEVELS,
  permissions,
  resources,
  users,
  workflows,
} from '@ow/db'
import { KIND_LABELS } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { kindTitle } from '../../services/git/kinds'
import { loadAccess, type ObjectKind, requireEnvironment, requireLevel } from '../../services/permissions'
import { adminProcedure, authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()

/** Grants on one resource, workflow, app or library query, on one folder, or (`objectId` null) on all objects of a type. */
const Target = z.object({
  objectType: z.enum([
    'resource',
    'workflow',
    'app',
    'library_query',
    'module',
    'component_library',
    'folder',
  ]),
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
  if (
    target.objectType === 'app' ||
    target.objectType === 'library_query' ||
    target.objectType === 'module' ||
    target.objectType === 'component_library'
  ) {
    const table = {
      app: apps,
      library_query: libraryQueries,
      module: modules,
      component_library: componentLibraries,
    }[target.objectType]
    const [object] = await ctx.db.select().from(table).where(eq(table.id, target.objectId)).limit(1)
    const access = await loadAccess(ctx.db, ctx.user)
    const label = KIND_LABELS[target.objectType]
    if (!object || access.objectLevel(target.objectType, object) === null) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `${kindTitle(target.objectType)} not found` })
    }
    requireLevel(access.objectLevel(target.objectType, object), 'own', `this ${label}`)
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
  if (target.objectId === null) {
    if (target.objectType === 'library_query') return 'all library queries'
    if (target.objectType === 'component_library') return 'all component libraries'
    return `all ${target.objectType}s`
  }
  if (target.objectType === 'folder') {
    const [folder] = await db
      .select({ name: folders.name })
      .from(folders)
      .where(eq(folders.id, target.objectId))
    return `folder ${folder?.name ?? target.objectId}`
  }
  return `${target.objectType} ${target.objectId}`
}

/** Who a grant is for: a group or one person, never both. */
const SUBJECT_MESSAGE = { message: 'Give access to a group or to a person' }
const oneSubject = (s: { groupId?: string; userId?: string }) =>
  (s.groupId === undefined) !== (s.userId === undefined)
const Subject = z
  .object({ groupId: Id.optional(), userId: Id.optional() })
  .refine(oneSubject, SUBJECT_MESSAGE)

function subjectWhere(s: { groupId?: string; userId?: string }) {
  return s.groupId ? eq(permissions.groupId, s.groupId) : eq(permissions.userId, s.userId!)
}

/** The subject for the audit log: `{ group }` or `{ user }` (an email), checked to exist. */
async function subjectName(db: Db, s: { groupId?: string; userId?: string }, granting: boolean) {
  if (s.groupId) {
    const [group] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, s.groupId))
    if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
    return { group: group.name }
  }
  const [user] = await db
    .select({ email: users.email, status: users.status, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, s.userId!))
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Person not found' })
  // Only people who are in: a grant mustn't wait unseen for someone pending, rejected or disabled.
  if (granting && (user.status !== 'active' || user.disabledAt)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${user.email} can't sign in, so can't be given access`,
    })
  }
  return { user: user.email }
}

/** Names (and slugs, for links) of granted objects and folders, by id. */
async function targetNames(db: Db, targets: { objectType: string; objectId: string }[]) {
  const out = new Map<string, { name: string | null; slug: string | null; folderType: string | null }>()
  const ids = (type: string) => targets.filter((t) => t.objectType === type).map((t) => t.objectId)
  const tables = [
    ['workflow', workflows],
    ['app', apps],
    ['resource', resources],
    ['library_query', libraryQueries],
    ['module', modules],
    ['component_library', componentLibraries],
  ] as const
  for (const [type, table] of tables) {
    const wanted = ids(type)
    if (!wanted.length) continue
    const rows = await db
      .select({ id: table.id, name: table.name, slug: table.slug })
      .from(table)
      .where(inArray(table.id, wanted))
    for (const r of rows) out.set(r.id, { name: r.name, slug: r.slug, folderType: null })
  }
  const folderIds = ids('folder')
  if (folderIds.length) {
    const rows = await db
      .select({ id: folders.id, name: folders.name, objectType: folders.objectType })
      .from(folders)
      .where(inArray(folders.id, folderIds))
    for (const r of rows) out.set(r.id, { name: r.name, slug: null, folderType: r.objectType })
  }
  return out
}

export const permissionsRouter = router({
  list: authedProcedure.input(Target).query(async ({ ctx, input }) => {
    await assertCanManage(ctx, input)
    const rows = await ctx.db
      .select({
        id: permissions.id,
        groupId: permissions.groupId,
        groupName: groups.name,
        userId: permissions.userId,
        userName: users.name,
        userEmail: users.email,
        environmentId: permissions.environmentId,
        level: permissions.level,
      })
      .from(permissions)
      .leftJoin(groups, eq(groups.id, permissions.groupId))
      .leftJoin(users, eq(users.id, permissions.userId))
      .where(targetWhere(input))
    // Groups first, then people, each by name.
    return rows
      .map((r) => ({ ...r, subject: r.groupId ? ('group' as const) : ('user' as const) }))
      .sort(
        (a, b) =>
          (a.subject === 'group' ? 0 : 1) - (b.subject === 'group' ? 0 : 1) ||
          (a.groupName ?? a.userName ?? '').localeCompare(b.groupName ?? b.userName ?? ''),
      )
  }),

  /**
   * Everything one group or one person is granted directly (not through their groups), with what each target is:
   * the Access sections of a group's and a person's settings pages. Admins only.
   */
  forSubject: adminProcedure.input(Subject).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({
        id: permissions.id,
        objectType: permissions.objectType,
        objectId: permissions.objectId,
        environmentId: permissions.environmentId,
        level: permissions.level,
      })
      .from(permissions)
      .where(subjectWhere(input))
    const names = await targetNames(
      ctx.db,
      rows.flatMap((r) => (r.objectId ? [{ objectType: r.objectType, objectId: r.objectId }] : [])),
    )
    return rows.map((r) => ({
      ...r,
      ...(r.objectId ? (names.get(r.objectId) ?? { name: null, slug: null, folderType: null }) : {}),
    }))
  }),

  /**
   * Sets (or with `level: null`, removes) one group's or one person's grant on a target, for one environment or all
   * (`null`).
   */
  set: authedProcedure
    .input(
      Target.extend({
        groupId: Id.optional(),
        userId: Id.optional(),
        environmentId: Id.nullable(),
        level: z.enum(PERMISSION_LEVELS).nullable(),
      }).refine(oneSubject, SUBJECT_MESSAGE),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanManage(ctx, input)
      // An environment only admins may use: only they may grant anything in it (it would never count for others).
      if (input.environmentId !== null)
        requireEnvironment(await loadAccess(ctx.db, ctx.user), input.environmentId)
      if (input.objectType !== 'resource' && input.objectType !== 'folder' && input.environmentId !== null) {
        const what = kindTitle(input.objectType)
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${what} access applies to every environment` })
      }
      // Likewise for their folders: a grant for one environment would never count.
      if (input.objectType === 'folder' && input.objectId !== null && input.environmentId !== null) {
        const [folder] = await ctx.db
          .select({ objectType: folders.objectType })
          .from(folders)
          .where(eq(folders.id, input.objectId))
        if (folder && folder.objectType !== 'resource') {
          const what = kindTitle(folder.objectType as ObjectKind)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `${what} folder access applies to every environment`,
          })
        }
      }
      const subject = await subjectName(ctx.db, input, input.level !== null)
      await ctx.db.transaction(async (tx) => {
        await tx
          .delete(permissions)
          .where(
            and(
              targetWhere(input),
              subjectWhere(input),
              input.environmentId === null
                ? isNull(permissions.environmentId)
                : eq(permissions.environmentId, input.environmentId),
            ),
          )
        if (input.level) {
          await tx.insert(permissions).values({
            groupId: input.groupId ?? null,
            userId: input.userId ?? null,
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
        metadata: { ...subject, target: await describeTarget(ctx.db, input), level: input.level },
      })
    }),
})
