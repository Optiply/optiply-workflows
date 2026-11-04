import {
  environments,
  permissions,
  pythonEnvs,
  pythonIndexes,
  queueDeliveries,
  type Workflow,
  webhookRejections,
  workflowReleases,
  workflows,
  workflowTriggers,
} from '@ow/db'
import {
  definitionHash,
  MAX_REQUIREMENT_LENGTH,
  MAX_REQUIREMENTS,
  PYTHON_INDEX_SLUG,
  requirementProblems,
  validateDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import { checkBodySchema } from '@ow/definition/body-schema'
import { BlockFailure } from '@ow/engine'
import { SandboxError } from '@ow/sandbox'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { dependents, inUseMessage } from '../../services/dependents'
import { requireGitRepo, requireUnprotected } from '../../services/git/protection'
import {
  type Access,
  checkFolderMove,
  checkFolderType,
  loadAccess,
  requireLevel,
} from '../../services/permissions'
import { pythonRunner } from '../../services/python'
import { envForRequirements, pythonBuilder, requirementsHash } from '../../services/python-envs'
import { invalidInput, uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
/** A workflow's Python packages (M23), as the editor's field holds them. */
const requirementsInput = z.array(z.string().max(MAX_REQUIREMENT_LENGTH)).min(1).max(MAX_REQUIREMENTS)
/** A package index's slug (M32), as `settings.python.index`. */
const indexInput = z.string().regex(PYTHON_INDEX_SLUG).optional()
const NO_BUILDER =
  "This instance can't install Python packages: it has no package builder (PYTHON_BUILDER_URL)"
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
  /** Edited on Git branches and deployed from the repo (M11); main is read-only here. */
  gitProtected: w.gitProtected,
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
      diagnostics: validateDefinition(workflow.draftDefinition, { checkBodySchema }).diagnostics,
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
    // Queue triggers (Pub/Sub M19, SQS and Kafka M26): their last day's messages, from what the consumer recorded.
    const isQueue = (kind: string) =>
      kind === 'pubsub' || kind === 'sqs' || kind === 'kafka' || kind === 'rabbitmq' || kind === 'kinesis'
    const queueIds = rows.filter((r) => isQueue(r.trigger.kind)).map((r) => r.trigger.id)
    const counts = new Map(
      (queueIds.length
        ? await ctx.db
            .select({
              triggerId: queueDeliveries.triggerId,
              messages: sql<number>`count(*)::int`,
              succeeded: sql<number>`count(*) filter (where ${queueDeliveries.outcome} = 'succeeded')::int`,
              failed: sql<number>`count(*) filter (where ${queueDeliveries.outcome} in ('failed', 'dead_lettered', 'dropped'))::int`,
              deadLettered: sql<number>`count(*) filter (where ${queueDeliveries.outcome} = 'dead_lettered')::int`,
            })
            .from(queueDeliveries)
            .where(
              and(
                inArray(queueDeliveries.triggerId, queueIds),
                gt(queueDeliveries.updatedAt, sql`now() - interval '1 day'`),
              ),
            )
            .groupBy(queueDeliveries.triggerId)
        : []
      ).map((c) => [c.triggerId, c]),
    )
    const now = Date.now()
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
      ...(isQueue(trigger.kind) && {
        queue: {
          // Only a lease still current: a worker gone without a goodbye isn't pulling.
          worker:
            trigger.leaseOwner && trigger.leaseExpiresAt && trigger.leaseExpiresAt.getTime() > now
              ? trigger.leaseOwner
              : null,
          state: trigger.state ?? null,
          lastDay: {
            messages: counts.get(trigger.id)?.messages ?? 0,
            succeeded: counts.get(trigger.id)?.succeeded ?? 0,
            failed: counts.get(trigger.id)?.failed ?? 0,
            deadLettered: counts.get(trigger.id)?.deadLettered ?? 0,
          },
        },
      }),
    }))
  }),

  /**
   * The latest calls the live webhook refused (4xx), newest first, for the webhook panel. Edit access: they hold
   * callers' IP addresses.
   */
  webhookRejections: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const { access, workflow } = await visibleWorkflow(ctx, input.id)
    requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
    return ctx.db
      .select({
        id: webhookRejections.id,
        at: webhookRejections.createdAt,
        status: webhookRejections.status,
        reason: webhookRejections.reason,
        message: webhookRejections.message,
        environment: environments.name,
        ip: webhookRejections.ip,
        userAgent: webhookRejections.userAgent,
      })
      .from(webhookRejections)
      .innerJoin(workflowTriggers, eq(workflowTriggers.id, webhookRejections.triggerId))
      .leftJoin(environments, eq(environments.id, webhookRejections.environmentId))
      .where(and(eq(workflowTriggers.workflowId, workflow.id), eq(workflowTriggers.kind, 'webhook')))
      .orderBy(desc(webhookRejections.createdAt), desc(webhookRejections.id))
      .limit(50)
  }),

  /** `protected`: made in Git from the start (edited on branches; the first merge deploys it). */
  create: authedProcedure
    .input(
      z.object({
        slug: Slug,
        name: Name,
        description: Description,
        folderId: Id.nullish(),
        protected: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateWorkflows) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all workflows to create one',
        })
      }
      await checkFolderType(ctx.db, 'workflow', input.folderId)
      if (input.protected) await requireGitRepo(ctx.db, ctx.config)
      const [workflow] = await uniqueOr('A workflow with that slug already exists', () =>
        ctx.db
          .insert(workflows)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: NEW_DEFINITION,
            gitProtected: input.protected ?? false,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'workflow.created',
        objectType: 'workflow',
        objectId: workflow!.id,
        metadata: { slug: input.slug, ...(input.protected ? { protected: true } : {}) },
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
      // The name, description and folder live in the repo (the folder since M22); the concurrency limit is the instance's.
      if (input.name !== undefined || input.description !== undefined) {
        requireUnprotected(workflow, 'workflow', 'rename it or change its description')
      }
      if (input.folderId !== undefined && input.folderId !== workflow.folderId) {
        requireUnprotected(workflow, 'workflow', 'move it to another folder')
      }
      await checkFolderMove(ctx.db, {
        type: 'workflow',
        level: access.workflowLevel(workflow),
        from: workflow.folderId,
        to: input.folderId,
      })
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
      requireUnprotected(workflow, 'workflow', 'edit it')
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
      return {
        revision: saved.revision,
        /** Compared with the live release's hash to show unpublished changes. */
        draftHash: await definitionHash(parsed.data),
        diagnostics: validateDefinition(parsed.data, { checkBodySchema }).diagnostics,
      }
    }),

  /**
   * Python syntax errors for the editor's markers (M12): the executor compiles the fields without running them (in
   * slots of its own: checks never hold up runs). For people who can edit the workflow; a mutation, as code can be
   * long. `available: false` when Python isn't set up or the executor can't be reached.
   */
  checkPython: authedProcedure
    .input(
      z.object({
        workflowId: Id,
        fields: z.array(z.object({ id: z.string().min(1).max(200), code: z.string().max(200_000) })).max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.workflowId)
      requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
      const python = pythonRunner()
      if (!python)
        return { available: false as const, message: "Python isn't set up on this instance", problems: [] }
      try {
        return { available: true as const, problems: await python.check(input.fields) }
      } catch (err) {
        if (!(err instanceof SandboxError)) throw err
        return { available: false as const, message: err.message, problems: [] }
      }
    }),

  /**
   * The state of a set of Python packages (M23) for the editor: installed (the lock's packages, its size), failed
   * (pip's reason and output) or not yet. The editor sends what its field holds, saved or not.
   */
  pythonEnv: authedProcedure
    .input(z.object({ workflowId: Id, requirements: requirementsInput, index: indexInput }))
    .query(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.workflowId)
      requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
      return pythonEnvState(ctx.db, input.requirements, input.index)
    }),

  /** Installs a set of Python packages now (M23), so the next run doesn't wait; the answer is the new state. */
  installPythonEnv: authedProcedure
    .input(z.object({ workflowId: Id, requirements: requirementsInput, index: indexInput }))
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.workflowId)
      requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
      const problem = requirementProblems(input.requirements)[0]
      if (problem) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${input.requirements[problem.index]}: ${problem.message}`,
        })
      }
      const client = pythonBuilder()
      if (!client) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NO_BUILDER })
      try {
        await envForRequirements(
          ctx.db,
          client,
          input.requirements,
          { workflowId: workflow.id, actorUserId: ctx.user.id },
          input.index,
        )
      } catch (err) {
        if (!(err instanceof BlockFailure)) throw err
        // Recorded as failed (the state says why), unless the index itself is the problem (said here).
        if (input.index) {
          const state = await pythonEnvState(ctx.db, input.requirements, input.index)
          if (state.available && state.state === 'none') {
            return { ...state, state: 'failed' as const, error: err.message, log: '', at: new Date() }
          }
          return state
        }
      }
      return pythonEnvState(ctx.db, input.requirements, input.index)
    }),

  /** Deletes the workflow with its releases and run history. */
  /**
   * Deletes the workflow with its releases, runs and grants. Refused while it's kept in Git (unprotect it first) or
   * another workflow calls it (a Workflow block or loop, in its draft, live release or a Git branch draft).
   */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, workflow } = await visibleWorkflow(ctx, input.id)
    requireLevel(access.workflowLevel(workflow), 'own', 'this workflow')
    if (workflow.gitProtected) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This workflow is kept in Git: unprotect it before deleting it',
      })
    }
    const callers = (await workflowCallers(ctx.db, workflow.slug)).filter((d) => d.object.id !== workflow.id)
    if (callers.length) {
      throw new TRPCError({ code: 'CONFLICT', message: inUseMessage(access, callers, 'workflow') })
    }
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

  /**
   * A copy of a workflow's draft under a new slug and name: no releases, not in Git, and **every trigger turned off**,
   * so the copy doesn't fire schedules or webhooks, or share a queue subscription with the original, until someone
   * turns them on. Needs Use on the original (whoever can open it can copy it) and the right to create workflows.
   */
  duplicate: authedProcedure
    .input(z.object({ id: Id, slug: Slug, name: Name, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, workflow } = await visibleWorkflow(ctx, input.id)
      requireLevel(access.workflowLevel(workflow), 'use', 'this workflow')
      if (!access.canCreateWorkflows) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all workflows to create one',
        })
      }
      const folderId = input.folderId === undefined ? workflow.folderId : input.folderId
      await checkFolderType(ctx.db, 'workflow', folderId)
      const [copy] = await uniqueOr('A workflow with that slug already exists', () =>
        ctx.db
          .insert(workflows)
          .values({
            slug: input.slug,
            name: input.name,
            description: workflow.description,
            folderId,
            draftDefinition: withTriggersOff(workflow.draftDefinition),
            maxConcurrentRuns: workflow.maxConcurrentRuns,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'workflow.created',
        objectType: 'workflow',
        objectId: copy!.id,
        metadata: { slug: input.slug, duplicateOf: { id: workflow.id, slug: workflow.slug } },
      })
      return summary(copy!, access)
    }),
})

/** The definition with every trigger (schedules, webhooks, Pub/Sub, SQS, Kafka) turned off. */
function withTriggersOff(definition: WorkflowDefinition): WorkflowDefinition {
  if (!definition.triggers) return definition
  const off = (t: unknown) =>
    t && typeof t === 'object' && 'enabled' in t ? { ...(t as Record<string, unknown>), enabled: false } : t
  const triggers = Object.fromEntries(
    Object.entries(definition.triggers).map(([kind, value]) => [
      kind,
      Array.isArray(value) ? value.map(off) : off(value),
    ]),
  )
  return { ...definition, triggers } as WorkflowDefinition
}

/** The workflows calling one by its slug: a Workflow block or a loop's workflow runner (both name it `workflow`). */
const workflowCallers = (db: Context['db'], slug: string) =>
  dependents(
    db,
    (column) =>
      sql`jsonb_path_exists(${column}, '$.** ? (@.workflow == $slug)', jsonb_build_object('slug', ${slug}::text))`,
    { modules: false, workflows: true },
  ).then((found) => found.filter((d) => d.kind === 'workflow'))

/** `python_envs`' row for these requirements (from this package index, M32), as the editor shows it. */
async function pythonEnvState(db: Context['db'], requirements: string[], index?: string) {
  if (!pythonBuilder()) return { available: false as const, message: NO_BUILDER }
  let indexId: string | null = null
  if (index) {
    const [found] = await db
      .select({ id: pythonIndexes.id })
      .from(pythonIndexes)
      .where(eq(pythonIndexes.slug, index))
    if (!found) {
      return {
        available: true as const,
        state: 'failed' as const,
        error: `The package index "${index}" doesn't exist on this instance (Settings → Python)`,
        log: '',
        at: null,
      }
    }
    indexId = found.id
  }
  const [row] = await db
    .select()
    .from(pythonEnvs)
    .where(eq(pythonEnvs.requirementsHash, requirementsHash(requirements, indexId)))
  if (!row) return { available: true as const, state: 'none' as const }
  if (row.state === 'failed') {
    return {
      available: true as const,
      state: 'failed' as const,
      error: row.error?.message ?? 'The install failed',
      log: row.log ?? '',
      at: row.lastUsedAt,
    }
  }
  return {
    available: true as const,
    state: 'ready' as const,
    packages: (row.lock?.packages ?? []).map((p) => `${p.name}==${p.version}`),
    /** Each package's index and whether it was built from its sdist (M32), by position. */
    details: (row.lock?.packages ?? []).map((p) => ({
      ...(p.index && { index: p.index }),
      ...(p.source && { source: p.source }),
    })),
    sizeBytes: row.sizeBytes ?? 0,
    at: row.builtAt,
  }
}
