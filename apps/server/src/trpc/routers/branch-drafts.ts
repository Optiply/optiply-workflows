import { GIT_OBJECT_KINDS, gitBranchDrafts } from '@ow/db'
import { KIND_LABELS } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  branchDraftChanges,
  branchDraftView,
  commitBranchDraft,
  type DraftObject,
  loadBranchDraft,
  openBranchDraft,
  saveBranchDraft,
  updateBranchDraftFromBranch,
} from '../../services/git/branch-drafts'
import { draftColumn, gitObjectLevel, kindTitle, loadGitObject } from '../../services/git/kinds'
import { branchNameSchema } from '../../services/git/repo'
import { updateBranchDraftFromMain } from '../../services/git/update-from-main'
import { atLeast, loadAccess, requireLevel } from '../../services/permissions'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
const Kind = z.enum(GIT_OBJECT_KINDS)
const Name = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).nullish()

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** Edit on the object is what working on its branch drafts takes; objects the caller can't see are NOT_FOUND. */
async function requireEdit(ctx: AuthedContext, target: DraftObject): Promise<void> {
  const access = await loadAccess(ctx.db, ctx.user)
  const level = gitObjectLevel(access, target.kind, target.object)
  if (!level) throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft not found' })
  requireLevel(level, 'edit', `this ${KIND_LABELS[target.kind]}`)
}

async function objectFor(
  ctx: AuthedContext,
  kind: (typeof GIT_OBJECT_KINDS)[number],
  id: string,
): Promise<DraftObject> {
  const object = await loadGitObject(ctx.db, kind, { id })
  if (!object) throw new TRPCError({ code: 'NOT_FOUND', message: `${kindTitle(kind)} not found` })
  return { kind, object }
}

async function editableDraft(ctx: AuthedContext, id: string) {
  const loaded = await loadBranchDraft(ctx.db, id)
  await requireEdit(ctx, loaded.target)
  return loaded
}

/**
 * Protected workflows, apps, library queries and modules are edited in drafts on Git branches (M11, M14): one per object and branch, saved with
 * optimistic concurrency, run like the main draft, and committed onto the branch. Edit on the object is required.
 */
/** A merge's resolutions, by conflict id (architecture §2.23). */
const resolutionsSchema = z
  .record(
    z.string().max(64),
    z.union([
      z.enum(['ours', 'theirs']),
      z.object({ chunks: z.array(z.enum(['ours', 'theirs', 'both'])).max(10_000) }),
      z.object({ text: z.string().max(2_000_000) }),
    ]),
  )
  .refine((r) => Object.keys(r).length <= 1000, 'At most 1000 resolutions')

export const branchDraftsRouter = router({
  /** The object's open drafts, newest first. */
  list: authedProcedure.input(z.object({ kind: Kind, id: Id })).query(async ({ ctx, input }) => {
    const target = await objectFor(ctx, input.kind, input.id)
    await requireEdit(ctx, target)
    const column = draftColumn(input.kind)
    const rows = await ctx.db
      .select()
      .from(gitBranchDrafts)
      .where(eq(column, input.id))
      .orderBy(desc(gitBranchDrafts.updatedAt))
    return rows.map((d) => ({
      id: d.id,
      branch: d.branch,
      revision: d.revision,
      branchExists: d.branchExists,
      committedCommit: d.committedCommit,
      updatedAt: d.updatedAt,
    }))
  }),

  /**
   * Opens the object's draft on a branch: the one already open, or one from the branch's files. `create`: the
   * branch may not exist yet; it's made from the deploy branch on the first commit.
   */
  open: authedProcedure
    .input(z.object({ kind: Kind, id: Id, branch: branchNameSchema, create: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const target = await objectFor(ctx, input.kind, input.id)
      await requireEdit(ctx, target)
      const draft = await openBranchDraft(ctx.db, ctx.config, ctx.user, {
        target,
        branch: input.branch,
        create: input.create,
      })
      return branchDraftView(draft)
    }),

  get: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const { draft } = await editableDraft(ctx, input.id)
    return branchDraftView(draft)
  }),

  /** Saves the draft (and the name and description the repo keeps) if nobody saved since `revision`. */
  save: authedProcedure
    .input(
      z.object({
        id: Id,
        revision: z.number().int().positive(),
        definition: z.unknown(),
        name: Name.optional(),
        description: Description,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { draft } = await editableDraft(ctx, input.id)
      const saved = await saveBranchDraft(ctx.db, ctx.user, {
        draft,
        revision: input.revision,
        definition: input.definition,
        name: input.name,
        description: input.description,
      })
      const view = await branchDraftView(saved)
      return { revision: view.revision, draftHash: view.draftHash, diagnostics: view.diagnostics }
    }),

  /** Closes the draft (what's committed stays on the branch). */
  discard: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { draft } = await editableDraft(ctx, input.id)
    await ctx.db.delete(gitBranchDrafts).where(eq(gitBranchDrafts.id, draft.id))
    return { ok: true }
  }),

  /** The files a commit would change on the branch, and whether the branch moved (or conflicts) meanwhile. */
  changes: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const { draft, target } = await editableDraft(ctx, input.id)
    return branchDraftChanges(ctx.db, ctx.config, target, draft)
  }),

  /**
   * Brings the branch's files into the draft, merged with its uncommitted changes: the updated draft, or the conflicts
   * to resolve (nothing saved). Called again with `resolutions` by conflict id; `discardChanges` drops the draft's.
   */
  updateFromBranch: authedProcedure
    .input(
      z.object({
        id: Id,
        discardChanges: z.boolean().default(false),
        resolutions: resolutionsSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { draft, target } = await editableDraft(ctx, input.id)
      const result = await updateBranchDraftFromBranch(ctx.db, ctx.config, ctx.user, {
        target,
        draft,
        discardChanges: input.discardChanges,
        resolutions: input.resolutions,
      })
      return result.status === 'updated'
        ? { status: 'updated' as const, draft: await branchDraftView(result.draft) }
        : result
    }),

  /**
   * Brings the deploy branch into the draft's branch as a merge commit (then updates the draft from the branch), or
   * returns the objects' conflicts to resolve (nothing written). Called again with `resolutions` by object directory.
   */
  updateFromMain: authedProcedure
    .input(z.object({ id: Id, resolutions: z.record(z.string().max(300), resolutionsSchema).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { draft, target } = await editableDraft(ctx, input.id)
      const access = await loadAccess(ctx.db, ctx.user)
      const result = await updateBranchDraftFromMain(ctx.db, ctx.config, ctx.user, {
        target,
        draft,
        resolutions: input.resolutions,
        canEdit: async (kind, slug) => {
          const object = await loadGitObject(ctx.db, kind, { slug })
          // Not on the instance yet (new on a branch): admins only.
          return object ? atLeast(gitObjectLevel(access, kind, object), 'edit') : ctx.user.isAdmin
        },
      })
      if (result.status !== 'merged') return result
      if (result.commit) {
        await ctx.audit({
          action: 'git.merged_main',
          objectType: target.kind,
          objectId: target.object.id,
          metadata: { branch: draft.branch, commit: result.commit, objects: result.objects },
        })
      }
      const update =
        result.draft.status === 'updated'
          ? { status: 'updated' as const, draft: await branchDraftView(result.draft.draft) }
          : result.draft
      return { status: 'merged' as const, commit: result.commit, objects: result.objects, draft: update }
    }),

  /** Commits the draft at `revision` onto its branch, as the caller. */
  commit: authedProcedure
    .input(
      z.object({
        id: Id,
        revision: z.number().int().positive(),
        message: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { draft, target } = await editableDraft(ctx, input.id)
      const result = await commitBranchDraft(ctx.db, ctx.config, ctx.user, {
        target,
        draft,
        revision: input.revision,
        message: input.message,
      })
      if (result.changed) {
        await ctx.audit({
          action: 'git.committed',
          objectType: target.kind,
          objectId: target.object.id,
          metadata: { branch: draft.branch, commit: result.commit },
        })
      }
      return { commit: result.commit, changed: result.changed, draft: await branchDraftView(result.draft) }
    }),
})
