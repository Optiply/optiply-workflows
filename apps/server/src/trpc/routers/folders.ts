import { folders, permissions } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { loadAccess } from '../../services/permissions'
import { uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
const Name = z.string().trim().min(1).max(80)

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** Resource folders are managed by whoever may create resources. */
async function assertCanManage(ctx: AuthedContext) {
  const access = await loadAccess(ctx.db, ctx.user)
  if (!access.canCreateResources) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need edit access to all resources to manage folders',
    })
  }
}

const duplicate = 'A folder with that name already exists here'

export const foldersRouter = router({
  list: authedProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.objectType, 'resource'))
      .orderBy(asc(folders.name)),
  ),

  create: authedProcedure
    .input(z.object({ name: Name, parentId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      await assertCanManage(ctx)
      const [folder] = await uniqueOr(duplicate, () =>
        ctx.db
          .insert(folders)
          .values({ objectType: 'resource', name: input.name, parentId: input.parentId ?? null })
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
    await assertCanManage(ctx)
    await uniqueOr(duplicate, () =>
      ctx.db.update(folders).set({ name: input.name }).where(eq(folders.id, input.id)),
    )
    await ctx.audit({ action: 'folder.renamed', objectType: 'folder', objectId: input.id, metadata: input })
  }),

  /** Resources in the folder move to the top level; a folder with subfolders can't be deleted. */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    await assertCanManage(ctx)
    const [folder] = await ctx.db.select().from(folders).where(eq(folders.id, input.id))
    if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' })
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
      metadata: { name: folder.name },
    })
  }),
})
