import { getConnector } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import {
  configVars,
  configVarValues,
  type Db,
  environments,
  resourceConfigs,
  resources,
  type Workflow,
  type WorkflowRun,
  workflowDraftSnapshots,
  workflowReleases,
  workflowRuns,
  workflows,
} from '@ow/db'
import { buildGraph, type Diagnostic, validateDefinition, type WorkflowDefinition } from '@ow/definition'
import {
  BlockFailure,
  enqueueRun,
  loadCheckpoints,
  type ResourceProvider,
  type RunContextProvider,
} from '@ow/engine'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { type Access, atLeast } from './permissions'
import { toResolved } from './resources'
import { decryptForRow } from './secrets'

/** A refused request, with the HTTP status to answer with. */
export class RunRequestError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type RunVersion = 'draft' | 'live'

/**
 * Queues a manual run of a workflow's draft or live release in one environment.
 *
 * - Draft runs (the editor's Run button) need Edit on the workflow and, like the query playground, Use on every
 *   resource the workflow queries in that environment: they run as the person pressing Run. They execute a frozen
 *   snapshot of the draft, shared by every run of the same draft revision.
 * - Live runs need Use on the workflow. The resources were vouched for when the release was published (M4).
 * - The definition must validate (with each query checked by its connector) and every resource it queries must be
 *   configured in the environment, so mistakes surface here rather than as a failed run.
 */
export async function startManualRun(
  db: Db,
  access: Access,
  user: { id: string },
  opts: { workflow: Workflow; environmentId: string; version: RunVersion; input: unknown },
): Promise<WorkflowRun> {
  const { source } = await prepareRun(db, access, user, opts)
  return enqueueRun(db, {
    workflowId: opts.workflow.id,
    ...source,
    environmentId: opts.environmentId,
    triggerType: 'manual',
    input: { data: opts.input ?? null },
    createdBy: user.id,
  })
}

/**
 * The editor's "Run block": runs one block of the draft, reusing its ancestors' results from an earlier run
 * (`fromRunId`, or the latest finished run in that environment) instead of running them again. Ancestors that run
 * has no result for (blocks added since, or that failed) run first. Nothing after the block runs. The same checks as
 * a draft run apply. Passing `input` runs every ancestor fresh with it; otherwise the earlier run's input is reused.
 */
export async function startBlockRun(
  db: Db,
  access: Access,
  user: { id: string },
  opts: { workflow: Workflow; environmentId: string; block: string; fromRunId?: string; input?: unknown },
): Promise<WorkflowRun> {
  const { definition, source } = await prepareRun(db, access, user, { ...opts, version: 'draft' })
  if (!definition.blocks.some((b) => b.name === opts.block)) {
    throw new RunRequestError(404, 'not_found', `The draft has no block named "${opts.block}"`)
  }
  const [earlier] = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, opts.workflow.id),
        eq(workflowRuns.environmentId, opts.environmentId),
        opts.fromRunId
          ? eq(workflowRuns.id, opts.fromRunId)
          : inArray(workflowRuns.status, ['succeeded', 'failed']),
      ),
    )
    .orderBy(desc(workflowRuns.id))
    .limit(1)
  if (opts.fromRunId && !earlier) {
    throw new RunRequestError(404, 'not_found', 'That run is not a run of this workflow in this environment')
  }

  // Every block depends on the start trigger, so new input means nothing upstream can be reused.
  const ancestors = buildGraph(definition).ancestors(opts.block)
  const seed =
    earlier && opts.input === undefined
      ? (await loadCheckpoints(db, earlier.id))
          .filter((c) => ancestors.has(c.key) && c.status !== 'failed')
          .map((c) => ({
            ...c,
            metadata: { ...c.metadata, cachedFrom: c.metadata.cachedFrom ?? earlier.id },
          }))
      : []
  return enqueueRun(
    db,
    {
      workflowId: opts.workflow.id,
      ...source,
      environmentId: opts.environmentId,
      triggerType: 'manual',
      input: opts.input !== undefined ? { data: opts.input } : (earlier?.input ?? { data: null }),
      createdBy: user.id,
      targetBlocks: [opts.block],
    },
    { seed },
  )
}

/** The checks shared by every manual run; returns the definition to run and where it comes from. */
async function prepareRun(
  db: Db,
  access: Access,
  user: { id: string },
  opts: { workflow: Workflow; environmentId: string; version: RunVersion },
): Promise<{
  definition: WorkflowDefinition
  source: { releaseId: string } | { draftSnapshotId: string }
}> {
  const { workflow, environmentId, version } = opts
  const level = access.workflowLevel(workflow)
  if (level === null) throw new RunRequestError(404, 'not_found', 'Workflow not found')
  const [env] = await db.select().from(environments).where(eq(environments.id, environmentId))
  if (!env) throw new RunRequestError(404, 'not_found', 'Environment not found')

  let definition: WorkflowDefinition
  let source: { releaseId: string } | { draftSnapshotId: string }
  if (version === 'draft') {
    if (level === 'use') throw new RunRequestError(403, 'forbidden', 'You need edit access to run the draft')
    const snapshot = await draftSnapshot(db, workflow.id, user.id)
    definition = snapshot.definition
    source = { draftSnapshotId: snapshot.id }
  } else {
    if (!workflow.liveReleaseId) {
      throw new RunRequestError(409, 'no_live_release', 'This workflow has no live release yet')
    }
    const [release] = await db
      .select()
      .from(workflowReleases)
      .where(eq(workflowReleases.id, workflow.liveReleaseId))
    definition = release!.definition
    source = { releaseId: release!.id }
  }

  const slugs = [
    ...new Set(definition.blocks.flatMap((b) => (b.type === 'resourceQuery' ? [b.config.resource] : []))),
  ]
  const rows = slugs.length ? await db.select().from(resources).where(inArray(resources.slug, slugs)) : []
  const bySlug = new Map(rows.map((r) => [r.slug, r]))

  const validation = validateDefinition(definition, {
    resolveResource: (slug) => {
      const resource = bySlug.get(slug)
      return resource ? getConnector(resource.type) : undefined
    },
  })
  if (!validation.ok) {
    const errors = validation.diagnostics.filter((d) => d.severity === 'error')
    throw new RunRequestError(400, 'invalid_definition', `The workflow isn't valid: ${errors[0]!.message}`, {
      diagnostics: errors satisfies Diagnostic[],
    })
  }

  const configured = new Set(
    rows.length
      ? (
          await db
            .select({ resourceId: resourceConfigs.resourceId })
            .from(resourceConfigs)
            .where(
              and(
                inArray(
                  resourceConfigs.resourceId,
                  rows.map((r) => r.id),
                ),
                eq(resourceConfigs.environmentId, environmentId),
              ),
            )
        ).map((r) => r.resourceId)
      : [],
  )
  for (const resource of rows) {
    if (version === 'draft' && !atLeast(access.level(resource, environmentId), 'use')) {
      throw new RunRequestError(
        403,
        'forbidden',
        `You need use access to resource "${resource.slug}" in ${env.name} to run this draft`,
      )
    }
    if (!configured.has(resource.id)) {
      throw new RunRequestError(
        400,
        'resource_not_configured',
        `Resource "${resource.slug}" isn't configured in ${env.name}`,
      )
    }
  }
  return { definition, source }
}

/** The snapshot of the current draft revision, created on first use. */
async function draftSnapshot(db: Db, workflowId: string, userId: string) {
  const [current] = await db
    .select({ revision: workflows.draftRevision, definition: workflows.draftDefinition })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
  await db
    .insert(workflowDraftSnapshots)
    .values({ workflowId, revision: current!.revision, definition: current!.definition, createdBy: userId })
    .onConflictDoNothing()
  const [snapshot] = await db
    .select()
    .from(workflowDraftSnapshots)
    .where(
      and(
        eq(workflowDraftSnapshots.workflowId, workflowId),
        eq(workflowDraftSnapshots.revision, current!.revision),
      ),
    )
  return snapshot!
}

/** Resources for the worker: looked up by slug, with secrets decrypted for the run's environment. */
export function dbResourceProvider(db: Db, keyring: Keyring): ResourceProvider {
  return {
    async resolve(slug, environmentId) {
      const [resource] = await db.select().from(resources).where(eq(resources.slug, slug))
      if (!resource) throw new BlockFailure('resource', `No resource has the slug "${slug}"`)
      const connector = getConnector(resource.type)
      if (!connector) throw new BlockFailure('resource', `Resource "${slug}" has an unknown type`)
      const [row] = await db
        .select()
        .from(resourceConfigs)
        .where(
          and(eq(resourceConfigs.resourceId, resource.id), eq(resourceConfigs.environmentId, environmentId)),
        )
      if (!row) throw new BlockFailure('resource', `Resource "${slug}" isn't configured in this environment`)
      return { connector, resource: toResolved(keyring, row) }
    },
  }
}

/**
 * Config vars for a run's environment. Draft runs only see non-secret values, like the query playground, because
 * whoever edits a draft could return a secret from a code block. Runs of a release also get secret values. Secret
 * values are always scrubbed from the run's logs and errors.
 */
export function dbRunContext(db: Db, keyring: Keyring): RunContextProvider {
  return {
    async load(run) {
      const rows = await db
        .select({ name: configVars.name, isSecret: configVars.isSecret, value: configVarValues })
        .from(configVars)
        .innerJoin(
          configVarValues,
          and(
            eq(configVarValues.configVarId, configVars.id),
            eq(configVarValues.environmentId, run.environmentId),
          ),
        )
      const vars: Record<string, unknown> = {}
      const secrets: string[] = []
      for (const { name, isSecret, value } of rows) {
        if (!isSecret) {
          vars[name] = value.value
          continue
        }
        const plain = decryptForRow<string>(keyring, 'config_var_values', value, value.valueEncrypted!)
        secrets.push(plain)
        if (run.releaseId) vars[name] = plain
      }
      return { configVars: vars, secrets }
    },
  }
}
