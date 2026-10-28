import { users, workflowReleases } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireRollbackAllowed, requireUnprotected } from '../../services/git/protection'
import { publishRelease, setLiveRelease } from '../../services/releases'
import { authedProcedure, router } from '../init'
import { visibleWorkflow } from './workflows'

const Id = z.string().uuid()

/**
 * A workflow's releases: immutable, semver-numbered copies of the draft. The live one is what webhooks, schedules
 * and live manual runs execute. Publishing and rollback need Edit on the workflow and Use on every resource it
 * queries in every environment (see `services/releases.ts`).
 */
export const releasesRouter = router({
  /** Newest first, without definitions. */
  list: authedProcedure.input(z.object({ workflowId: Id })).query(async ({ ctx, input }) => {
    const { workflow } = await visibleWorkflow(ctx, input.workflowId)
    const rows = await ctx.db
      .select({ release: workflowReleases, author: { id: users.id, name: users.name, email: users.email } })
      .from(workflowReleases)
      .leftJoin(users, eq(users.id, workflowReleases.createdBy))
      .where(eq(workflowReleases.workflowId, workflow.id))
      .orderBy(desc(workflowReleases.createdAt), desc(workflowReleases.id))
    return rows.map(({ release, author }) => ({
      id: release.id,
      version: release.version,
      notes: release.notes,
      definitionHash: release.definitionHash,
      createdAt: release.createdAt,
      createdBy: author,
      /** Set on releases deployed from Git (made by Git sync: `createdBy` is null). */
      gitCommit: release.gitCommit,
      live: release.id === workflow.liveReleaseId,
    }))
  }),

  /** One release with its definition, e.g. to view it or compare it with the draft. */
  get: authedProcedure.input(z.object({ workflowId: Id, id: Id })).query(async ({ ctx, input }) => {
    const { workflow } = await visibleWorkflow(ctx, input.workflowId)
    const [release] = await ctx.db
      .select()
      .from(workflowReleases)
      .where(and(eq(workflowReleases.id, input.id), eq(workflowReleases.workflowId, workflow.id)))
    if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
    return { ...release, live: release.id === workflow.liveReleaseId }
  }),

  /**
   * Releases the draft at `draftRevision` and makes it live. Give `version`, or `bump` from the latest release
   * (default patch; the first release is 1.0.0).
   */
  publish: authedProcedure
    .input(
      z.object({
        workflowId: Id,
        draftRevision: z.number().int().positive(),
        version: z.string().max(40).optional(),
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.workflowId)
      requireUnprotected(workflow, 'workflow', 'publish it')
      const release = await publishRelease(ctx.db, access, ctx.user, {
        workflow,
        draftRevision: input.draftRevision,
        version: input.version,
        bump: input.bump,
        notes: input.notes,
      })
      await ctx.audit({
        action: 'workflow.release_published',
        objectType: 'workflow',
        objectId: workflow.id,
        metadata: { releaseId: release.id, version: release.version, definitionHash: release.definitionHash },
      })
      return { id: release.id, version: release.version, definitionHash: release.definitionHash }
    }),

  /** Makes another release live (rollback, or forward again). */
  setLive: authedProcedure
    .input(z.object({ workflowId: Id, releaseId: Id }))
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.workflowId)
      requireRollbackAllowed(workflow, 'workflow', ctx.user)
      const release = await setLiveRelease(ctx.db, access, {
        workflow,
        releaseId: input.releaseId,
        actorUserId: ctx.user.id,
      })
      await ctx.audit({
        action: 'workflow.release_live',
        objectType: 'workflow',
        objectId: workflow.id,
        metadata: {
          releaseId: release.id,
          version: release.version,
          previousReleaseId: workflow.liveReleaseId,
          ...(workflow.gitProtected ? { emergency: true } : {}),
        },
      })
      return { id: release.id, version: release.version }
    }),
})
