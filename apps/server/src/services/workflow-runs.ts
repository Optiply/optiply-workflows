import { isDeepStrictEqual } from 'node:util'
import { getConnector } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import {
  configVars,
  configVarValues,
  type Db,
  environments,
  gitBranchDrafts,
  groups,
  type LibraryQuery,
  type Resource,
  resourceConfigs,
  resources,
  users,
  type Workflow,
  type WorkflowRun,
  workflowDraftSnapshots,
  workflowReleases,
  workflowRuns,
  workflows,
} from '@ow/db'
import {
  blockingErrors,
  buildGraph,
  calledWorkflows,
  type Diagnostic,
  literalAssignees,
  queriedResources,
  usedLibraries,
  validateDefinition,
  type WorkflowDefinition,
} from '@ow/definition'
import { checkBodySchema } from '@ow/definition/body-schema'
import {
  BlockFailure,
  enqueueRun,
  loadCheckpoints,
  type ResourceProvider,
  type RunContextProvider,
} from '@ow/engine'
import type { CodeRuntime } from '@ow/sandbox'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { libraryInfos } from './library-queries'
import { credentialsFor } from './oauth-tokens'
import { type Access, atLeast } from './permissions'
import { pythonDiagnostics } from './python'
import { toResolved } from './resources'
import { decryptForRow } from './secrets'

/** A refused request, with the HTTP status to answer with. */
export class RunRequestError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 429 | 503,
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
 *   resource the workflow queries in that environment and on every workflow it calls: they run as the person
 *   pressing Run. They execute a frozen
 *   snapshot of the draft, shared by every run of the same draft revision.
 * - Live runs need Use on the workflow. The resources were vouched for when the release was published (M4).
 * - The definition must validate (with each query checked by its connector) and every resource it queries must be
 *   configured in the environment, so mistakes surface here rather than as a failed run.
 */
export async function startManualRun(
  db: Db,
  access: Access,
  user: { id: string },
  opts: {
    workflow: Workflow
    environmentId: string
    version: RunVersion
    input: unknown
    branchDraftId?: string
  },
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
 * a draft run apply. Passing `input` runs every ancestor fresh with it. Passing `testInput` (the editor's current
 * test input) reuses the earlier run only if it ran with that input, else runs every ancestor fresh with it, so a
 * changed test input is never answered from a stale start trigger. With neither, the earlier run's input is reused.
 */
export async function startBlockRun(
  db: Db,
  access: Access,
  user: { id: string },
  opts: {
    workflow: Workflow
    environmentId: string
    block: string
    fromRunId?: string
    input?: unknown
    /** `{ value }`: the editor's test input (null when empty). */
    testInput?: { value: unknown }
    branchDraftId?: string
  },
): Promise<WorkflowRun> {
  const { definition, source } = await prepareRun(db, access, user, {
    ...opts,
    version: 'draft',
    targets: [opts.block],
  })
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
  const earlierInput = (earlier?.input as { data?: unknown } | undefined)?.data ?? null
  const input =
    opts.input !== undefined
      ? opts.input
      : opts.testInput && (!earlier || !isDeepStrictEqual(earlierInput, opts.testInput.value ?? null))
        ? (opts.testInput.value ?? null)
        : undefined
  const ancestors = buildGraph(definition).ancestors(opts.block)
  const seed =
    earlier && input === undefined
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
      input: input !== undefined ? { data: input } : (earlier?.input ?? { data: null }),
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
  opts: {
    workflow: Workflow
    environmentId: string
    version: RunVersion
    branchDraftId?: string
    /** A block run's blocks: only errors they depend on count. */
    targets?: string[]
  },
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
    const snapshot = opts.branchDraftId
      ? await branchDraftSnapshot(db, workflow.id, opts.branchDraftId, user.id)
      : await draftSnapshot(db, workflow.id, user.id)
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

  const {
    resources: rows,
    children,
    libraries,
    errors,
  } = await checkDefinition(db, definition, 'run', version === 'draft')
  // A block run needs only that block, its ancestors and what they call to be valid (M28).
  const blocking = blockingErrors(definition, errors, opts.targets)
  if (blocking.length) {
    throw new RunRequestError(
      400,
      'invalid_definition',
      `The workflow isn't valid: ${blocking[0]!.message}`,
      {
        diagnostics: blocking satisfies Diagnostic[],
      },
    )
  }
  // A draft run starts its child workflows as the person pressing Run (a release was vouched for when published).
  if (version === 'draft') {
    for (const child of children) {
      if (!atLeast(access.workflowLevel(child), 'use')) {
        throw new RunRequestError(
          403,
          'forbidden',
          `You need use access to workflow "${child.slug}" to run this draft, which calls it`,
        )
      }
    }
    // Its library queries too (not their resources: a library query's publisher vouched for those).
    for (const library of libraries) {
      if (!atLeast(access.libraryQueryLevel(library), 'use')) {
        throw new RunRequestError(
          403,
          'forbidden',
          `You need use access to library query "${library.slug}" to run this draft, which uses it`,
        )
      }
    }
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

/**
 * Validates a definition the way the server does before running or releasing it: the editor's checks plus each query
 * against its resource's connector, and each child workflow existing with a live release. Returns the resources it
 * queries, the workflows it calls and the error diagnostics.
 */
export async function checkDefinition(
  db: Db,
  definition: WorkflowDefinition,
  /** `run`: Python only needs an executor; `release` (the default): the executor checks its syntax too. */
  purpose: 'run' | 'release' = 'release',
  /**
   * Whether library queries are checked against the library (M21): not for a live release's run, which was checked
   * when it was published (a library query's newer live release may have dropped a parameter it passes: a warning
   * at that publish, ignored at run time).
   */
  checkLibraries = true,
): Promise<{
  resources: Resource[]
  children: Workflow[]
  libraries: LibraryQuery[]
  errors: Diagnostic[]
}> {
  const slugs = queriedResources(definition)
  const rows = slugs.length ? await db.select().from(resources).where(inArray(resources.slug, slugs)) : []
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  const childSlugs = calledWorkflows(definition)
  const children = childSlugs.length
    ? await db.select().from(workflows).where(inArray(workflows.slug, childSlugs))
    : []
  const childBySlug = new Map(children.map((w) => [w.slug, w]))
  // Library queries (M21): the release a reference names must exist; who may use them is the caller's to check.
  const libraries = await libraryInfos(db, usedLibraries(definition))
  const assignees = literalAssignees(definition)
  const knownEmails = new Set(
    assignees.users.length
      ? (
          await db
            .select({ email: users.email })
            .from(users)
            .where(inArray(sql`lower(${users.email})`, assignees.users))
        ).map((u) => u.email.toLowerCase())
      : [],
  )
  const knownGroups = new Set(
    assignees.groups.length
      ? (
          await db.select({ name: groups.name }).from(groups).where(inArray(groups.name, assignees.groups))
        ).map((g) => g.name)
      : [],
  )
  const validation = validateDefinition(definition, {
    checkBodySchema,
    resolveAssignee: (kind, name) =>
      kind === 'user' ? knownEmails.has(name.toLowerCase()) : knownGroups.has(name),
    resolveResource: (slug) => {
      const resource = bySlug.get(slug)
      return resource ? getConnector(resource.type) : undefined
    },
    resolveWorkflow: (slug) => {
      const child = childBySlug.get(slug)
      if (!child) return undefined
      return child.liveReleaseId ? 'published' : 'unpublished'
    },
    ...(checkLibraries && { resolveLibrary: (slug: string) => libraries.get(slug)?.info }),
  })
  const errors = validation.diagnostics.filter((d) => d.severity === 'error')
  // Python's syntax is the executor's to check (only when the rest is valid: a broken schema has no fields).
  if (!errors.some((d) => d.code === 'schema')) {
    errors.push(...(await pythonDiagnostics(definition, { syntax: purpose === 'release' })))
  }
  return { resources: rows, children, libraries: [...libraries.values()].map((l) => l.query), errors }
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
        isNull(workflowDraftSnapshots.branchDraftId),
      ),
    )
  return snapshot!
}

/** The snapshot of a Git branch draft's current revision (M11), created on first use. */
async function branchDraftSnapshot(db: Db, workflowId: string, branchDraftId: string, userId: string) {
  const [draft] = await db
    .select()
    .from(gitBranchDrafts)
    .where(and(eq(gitBranchDrafts.id, branchDraftId), eq(gitBranchDrafts.workflowId, workflowId)))
  if (!draft) throw new RunRequestError(404, 'not_found', 'This workflow has no such branch draft')
  await db
    .insert(workflowDraftSnapshots)
    .values({
      workflowId,
      branchDraftId,
      revision: draft.revision,
      definition: draft.definition as WorkflowDefinition,
      createdBy: userId,
    })
    .onConflictDoNothing()
  const [snapshot] = await db
    .select()
    .from(workflowDraftSnapshots)
    .where(
      and(
        eq(workflowDraftSnapshots.branchDraftId, branchDraftId),
        eq(workflowDraftSnapshots.revision, draft.revision),
      ),
    )
  return snapshot!
}

/** Resources for the worker: looked up by slug, with secrets decrypted for the run's environment. */
/** `sandbox` runs custom auth flows' code and templates (not the runs' own code: each run has its own). */
export function dbResourceProvider(db: Db, keyring: Keyring, sandbox: CodeRuntime): ResourceProvider {
  return {
    async resolve(slug, environmentId, opts) {
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
      const resolved = toResolved(keyring, row)
      return {
        connector,
        resource: resolved,
        credentials: credentialsFor(
          { db, keyring, sandbox },
          resource.type,
          resolved,
          opts?.actingUserId ?? null,
        ),
      }
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
    load: (run) => loadConfigVars(db, keyring, run.environmentId, { withSecrets: !!run.releaseId }),
  }
}

/**
 * An environment's config vars by name (secret ones only `withSecrets`), plus every secret value (to scrub from what
 * leaves the server). Used by runs and, since M36, by app resource queries (`{{ configVars.X }}`).
 */
export async function loadConfigVars(
  db: Db,
  keyring: Keyring,
  environmentId: string,
  opts: { withSecrets: boolean },
): Promise<{ configVars: Record<string, unknown>; secrets: string[] }> {
  const rows = await db
    .select({ name: configVars.name, isSecret: configVars.isSecret, value: configVarValues })
    .from(configVars)
    .innerJoin(
      configVarValues,
      and(eq(configVarValues.configVarId, configVars.id), eq(configVarValues.environmentId, environmentId)),
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
    if (opts.withSecrets) vars[name] = plain
  }
  return { configVars: vars, secrets }
}

/**
 * The secret config var values of an environment, as they are now. The runs API scrubs block data and stored
 * replies with them on the way out: the stored data stays as the blocks returned it, because resumed runs and
 * parent runs read it back.
 */
export async function secretConfigValues(db: Db, keyring: Keyring, environmentId: string): Promise<string[]> {
  const rows = await db
    .select({ value: configVarValues })
    .from(configVars)
    .innerJoin(
      configVarValues,
      and(eq(configVarValues.configVarId, configVars.id), eq(configVarValues.environmentId, environmentId)),
    )
    .where(eq(configVars.isSecret, true))
  return rows.map(({ value }) =>
    decryptForRow<string>(keyring, 'config_var_values', value, value.valueEncrypted!),
  )
}
