import {
  environments,
  permissions,
  type Workflow,
  workflowReleases,
  workflows,
  workflowTriggers,
} from '@ow/db'
import {
  definitionHash,
  validateDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { type Access, loadAccess, requireLevel } from '../../services/permissions'
import { invalidInput, uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
/** Appears in webhook URLs (M4), so it's a stable identifier. */
const Slug = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{1,62}$/,
    'Use 2–63 lowercase letters, digits, dashes or underscores, starting with a letter',
  )
const Name = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).nullish()

const NEW_DEFINITION: WorkflowDefinition = {
  schemaVersion: 1,
  blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
  edges: [],
}

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** The workflow and the caller's access; workflows the caller can't see are NOT_FOUND. */
export async function visibleWorkflow(
  ctx: AuthedContext,
  id: string,
): Promise<{ access: Access; workflow: Workflow }> {
  const access = await loadAccess(ctx.db, ctx.user)
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, id))
  if (!workflow || access.workflowLevel(workflow) === null) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found' })
  }
  return { access, workflow }
}

const summary = (w: Workflow, access: Access) => ({
  id: w.id,
  slug: w.slug,
  name: w.name,
  description: w.description,
  folderId: w.folderId,
  liveReleaseId: w.liveReleaseId,
  maxConcurrentRuns: w.maxConcurrentRuns,
  updatedAt: w.updatedAt,
  level: access.workflowLevel(w)!,
})

export const workflowsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const rows = await ctx.db.select().from(workflows).orderBy(asc(workflows.name))
    return rows.filter((w) => access.workflowLevel(w) !== null).map((w) => summary(w, access))
  }),

  /**
   * The workflow with its draft, the draft's diagnostics (drafts may be saved while still invalid), and the live
   * release. `draftHash` equals the live release's `definitionHash` when the draft has no unpublished changes.
   */
  get: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const { access, workflow } = await visibleWorkflow(ctx, input.id)
    const [live] = workflow.liveReleaseId
      ? await ctx.db
          .select({
            id: workflowReleases.id,
            version: workflowReleases.version,
            definitionHash: workflowReleases.definitionHash,
            createdAt: workflowReleases.createdAt,
          })
          .from(workflowReleases)
          .where(eq(workflowReleases.id, workflow.liveReleaseId))
      : []
    return {
      ...summary(workflow, access),
      draftDefinition: workflow.draftDefinition,
      draftRevision: workflow.draftRevision,
      draftHash: await definitionHash(workflow.draftDefinition),
      diagnostics: validateDefinition(workflow.draftDefinition).diagnostics,
      liveRelease: live ?? null,
    }
  }),

  /** The live release's triggers as projected for the scheduler and webhooks, with their next fire times. */
  triggers: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const { workflow } = await visibleWorkflow(ctx, input.id)
    const rows = await ctx.db
      .select({ trigger: workflowTriggers, environment: environments.slug })
      .from(workflowTriggers)
      .leftJoin(environments, eq(environments.id, workflowTriggers.environmentId))
      .where(eq(workflowTriggers.workflowId, workflow.id))
      .orderBy(asc(workflowTriggers.kind), asc(workflowTriggers.name))
    return rows.map(({ trigger, environment }) => ({
      id: trigger.id,
      kind: trigger.kind,
      name: trigger.name,
      enabled: trigger.enabled,
      config: trigger.config,
      environment,
      releaseId: trigger.releaseId,
      nextFireAt: trigger.nextFireAt,
      lastFiredAt: trigger.lastFiredAt,
    }))
  }),

  create: authedProcedure
    .input(z.object({ slug: Slug, name: Name, description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateWorkflows) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all workflows to create one',
        })
      }
      const [workflow] = await uniqueOr('A workflow with that slug already exists', () =>
        ctx.db
          .insert(workflows)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: NEW_DEFINITION,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'workflow.created',
        objectType: 'workflow',
        objectId: workflow!.id,
        metadata: { slug: input.slug },
      })
      return summary(workflow!, access)
    }),

  /** `maxConcurrentRuns` caps the workflow's runs executing at once (null = no limit); it isn't versioned. */
  update: authedProcedure
    .input(
      z.object({
        id: Id,
        name: Name.optional(),
        description: Description,
        folderId: Id.nullish(),
        maxConcurrentRuns: z.number().int().min(1).max(1000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.id)
      requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
      const { id, ...changes } = input
      const [updated] = await ctx.db
        .update(workflows)
        .set({ ...changes, updatedBy: ctx.user.id })
        .where(eq(workflows.id, id))
        .returning()
      await ctx.audit({ action: 'workflow.updated', objectType: 'workflow', objectId: id, metadata: changes })
      return summary(updated!, access)
    }),

  /**
   * Saves the draft if nobody saved since `revision` (optimistic concurrency); a stale revision is CONFLICT. The
   * draft must match the schema but may otherwise be invalid while it's being edited: the diagnostics come back.
   */
  saveDraft: authedProcedure
    .input(z.object({ id: Id, revision: z.number().int().positive(), definition: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.id)
      requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
      const parsed = workflowDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw invalidInput('workflow definition', parsed.error.issues)
      const [saved] = await ctx.db
        .update(workflows)
        .set({ draftDefinition: parsed.data, draftRevision: input.revision + 1, updatedBy: ctx.user.id })
        .where(and(eq(workflows.id, input.id), eq(workflows.draftRevision, input.revision)))
        .returning({ revision: workflows.draftRevision })
      if (!saved) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Someone else saved this workflow since revision ${input.revision}; reload to get their changes`,
        })
      }
      return { revision: saved.revision, diagnostics: validateDefinition(parsed.data).diagnostics }
    }),

  /** Deletes the workflow with its releases and run history. */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, workflow } = await visibleWorkflow(ctx, input.id)
    requireLevel(access.workflowLevel(workflow), 'own', 'this workflow')
    await ctx.db.transaction(async (tx) => {
      await tx.delete(workflows).where(eq(workflows.id, input.id))
      // Grants reference objects polymorphically, so they're removed here rather than by a foreign key.
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'workflow'), eq(permissions.objectId, input.id)))
    })
    await ctx.audit({
      action: 'workflow.deleted',
      objectType: 'workflow',
      objectId: input.id,
      metadata: { slug: workflow.slug },
    })
    return { ok: true }
  }),
})
