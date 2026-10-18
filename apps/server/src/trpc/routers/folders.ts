import { folders, permissions } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { loadAccess } from '../../services/permissions'
import { uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
const Name = z.string().trim().min(1).max(80)
/** What a folder holds: resources, workflows, apps or library queries (never a mix: a folder's grants mean one kind of access). */
const FolderType = z.enum(['resource', 'workflow', 'app', 'library_query', 'module'])
type FolderType = z.infer<typeof FolderType>

type AuthedContext = Context & { user: NonNullable<Context['user']> }

const PLURAL: Record<FolderType, string> = {
  resource: 'resources',
  workflow: 'workflows',
  app: 'apps',
  library_query: 'library queries',
  module: 'modules',
}

/** Whether the person may manage folders of a type: whoever may create that type. */
async function canManage(ctx: AuthedContext, type: FolderType): Promise<boolean> {
  const access = await loadAccess(ctx.db, ctx.user)
  return type === 'resource' ? access.canCreateResources : access.canCreate(type)
}

async function assertCanManage(ctx: AuthedContext, type: FolderType) {
  if (!(await canManage(ctx, type))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You need edit access to all ${PLURAL[type]} to manage their folders`,
    })
  }
}

/** A folder by id, or NOT_FOUND. */
async function folderById(ctx: AuthedContext, id: string) {
  const [folder] = await ctx.db.select().from(folders).where(eq(folders.id, id))
  if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' })
  return folder
}

const duplicate = 'A folder with that name already exists here'

export const foldersRouter = router({
  /** One type's folders (resources' when no type is given), and whether the caller may manage them. */
  list: authedProcedure
    .input(z.object({ type: FolderType.default('resource') }).optional())
    .query(async ({ ctx, input }) => {
      const type = input?.type ?? 'resource'
      const list = await ctx.db
        .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.objectType, type))
        .orderBy(asc(folders.name))
      return { folders: list, canManage: await canManage(ctx, type) }
    }),

  create: authedProcedure
    .input(z.object({ name: Name, parentId: Id.nullish(), type: FolderType.default('resource') }))
    .mutation(async ({ ctx, input }) => {
      await assertCanManage(ctx, input.type)
      if (input.parentId && (await folderById(ctx, input.parentId)).objectType !== input.type) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `No ${input.type} folder has that id` })
      }
      const [folder] = await uniqueOr(duplicate, () =>
        ctx.db
          .insert(folders)
          .values({ objectType: input.type, name: input.name, parentId: input.parentId ?? null })
          .returning(),
      )
      await ctx.audit({
        action: 'folder.created',
        objectType: 'folder',
        objectId: folder!.id,
        metadata: input,
      })
      return folder!
    }),

  rename: authedProcedure.input(z.object({ id: Id, name: Name })).mutation(async ({ ctx, input }) => {
    await assertCanManage(ctx, (await folderById(ctx, input.id)).objectType)
    await uniqueOr(duplicate, () =>
      ctx.db.update(folders).set({ name: input.name }).where(eq(folders.id, input.id)),
    )
    await ctx.audit({ action: 'folder.renamed', objectType: 'folder', objectId: input.id, metadata: input })
  }),

  /**
   * What's in the folder moves to the top level (and loses the folder's grants); a folder with subfolders can't be
   * deleted.
   */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const folder = await folderById(ctx, input.id)
    await assertCanManage(ctx, folder.objectType)
    const [child] = await ctx.db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.parentId, input.id))
      .limit(1)
    if (child) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Delete or move the subfolders first' })
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'folder'), eq(permissions.objectId, input.id)))
      await tx.delete(folders).where(eq(folders.id, input.id))
    })
    await ctx.audit({
      action: 'folder.deleted',
      objectType: 'folder',
      objectId: input.id,
      metadata: { name: folder.name, type: folder.objectType },
    })
  }),
})
