import {
  configVars,
  configVarValues,
  type Db,
  type Environment,
  environments,
  resourceConfigs,
  type Workflow,
  type WorkflowRelease,
  workflowReleases,
  workflows,
  workflowTriggers,
} from '@ow/db'
import {
  canonicalize,
  canonicalJson,
  definitionHash,
  nextScheduleFire,
  type PythonLock,
  parseWebhookAlias,
  type ResolvedWebhook,
  resolveWebhookSettings,
  type ScheduleTrigger,
  type VersionBump,
  type WorkflowDefinition,
  webhookEnvironments,
} from '@ow/definition'
import { BlockFailure } from '@ow/engine'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm'
import { uniqueOr } from '../trpc/errors'
import { type ReleaseJsBundle, releaseJsBundle } from './js-modules'
import { authorizationCode } from './oauth-tokens'
import { type Access, atLeast } from './permissions'
import { releaseLock } from './python-envs'
import { nextReleaseVersion } from './release-versions'
import { effectiveConfig } from './resources'
import { checkDefinition } from './workflow-runs'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Publishes the draft as a new release and makes it live. `draftRevision` is the revision the publisher is looking
 * at: if someone saved since, publishing refuses rather than release changes the publisher hasn't seen. The version
 * is given explicitly or bumped from the highest one, and must be higher than every existing release.
 */
export async function publishRelease(
  db: Db,
  access: Access,
  user: { id: string },
  opts: {
    workflow: Workflow
    draftRevision: number
    version?: string
    bump?: VersionBump
    notes?: string | null
    now?: Date
  },
): Promise<WorkflowRelease> {
  const { workflow } = opts
  const definition = canonicalize(workflow.draftDefinition)
  if (workflow.draftRevision !== opts.draftRevision) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `The draft changed since revision ${opts.draftRevision}; reload before publishing`,
    })
  }
  const hash = await definitionHash(definition)
  const plan = await checkReleasable(db, access, workflow, definition, { actorUserId: user.id })

  return db.transaction(async (tx) => {
    // Serializes publishing and setting the live release of one workflow.
    const [locked] = await tx.select().from(workflows).where(eq(workflows.id, workflow.id)).for('update')
    if (!locked || locked.draftRevision !== opts.draftRevision) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `The draft changed since revision ${opts.draftRevision}; reload before publishing`,
      })
    }
    const release = await insertRelease(tx, locked, definition, hash, {
      version: opts.version,
      bump: opts.bump,
      notes: opts.notes,
      createdBy: user.id,
      gitCommit: null,
      pythonLock: plan.pythonLock,
      js: plan.js,
    })
    if ('unchanged' in release) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Nothing changed since the live release, v${release.unchanged}`,
      })
    }
    await makeLive(tx, workflow.id, release, plan, opts.now ?? new Date())
    return release
  })
}

/**
 * Deploys a workflow from Git (M11): its draft, name and description become what the branch holds, and when the
 * definition differs from the live release's, a new patch release made by Git sync (`created_by` null, the commit
 * SHA) goes live. Nobody's grants are checked (writing to the branch is the right to deploy); everything else
 * publishing checks is. Returns the release, or null when the definition was already live.
 */
export async function deployWorkflowFromGit(
  db: Db,
  opts: {
    workflow: Workflow
    name: string
    description: string | null
    definition: WorkflowDefinition
    commit: string
    notes: string | null
    now?: Date
  },
): Promise<WorkflowRelease | null> {
  const definition = canonicalize(opts.definition)
  const hash = await definitionHash(definition)
  const plan = await checkReleasable(db, null, opts.workflow, definition, { actorUserId: null })
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(workflows).where(eq(workflows.id, opts.workflow.id)).for('update')
    if (!locked) throw new TRPCError({ code: 'NOT_FOUND', message: 'The workflow was deleted meanwhile' })
    // Compared canonically: jsonb doesn't keep key order.
    const draftChanged = canonicalJson(canonicalize(locked.draftDefinition)) !== canonicalJson(definition)
    await tx
      .update(workflows)
      .set({
        name: opts.name,
        description: opts.description,
        ...(draftChanged
          ? { draftDefinition: definition, draftRevision: locked.draftRevision + 1, updatedBy: null }
          : {}),
      })
      .where(eq(workflows.id, locked.id))
    const release = await insertRelease(tx, locked, definition, hash, {
      notes: opts.notes,
      createdBy: null,
      gitCommit: opts.commit,
      pythonLock: plan.pythonLock,
      js: plan.js,
    })
    if ('unchanged' in release) return null
    await makeLive(tx, locked.id, release, plan, opts.now ?? new Date())
    return release
  })
}

/**
 * Inserts the next release of a locked workflow, unless the live one already has this hash. The version is given
 * or bumped from the highest, and must be higher than every existing one.
 */
async function insertRelease(
  tx: Tx,
  locked: Workflow,
  definition: WorkflowDefinition,
  hash: string,
  opts: {
    version?: string
    bump?: VersionBump
    notes?: string | null
    createdBy: string | null
    gitCommit: string | null
    pythonLock: PythonLock | null
    js: ReleaseJsBundle | null
  },
): Promise<WorkflowRelease | { unchanged: string }> {
  const existing = await tx
    .select({
      id: workflowReleases.id,
      version: workflowReleases.version,
      hash: workflowReleases.definitionHash,
    })
    .from(workflowReleases)
    .where(eq(workflowReleases.workflowId, locked.id))
  const live = existing.find((r) => r.id === locked.liveReleaseId)
  if (live?.hash === hash) return { unchanged: live.version }
  const version = nextReleaseVersion(
    existing.map((r) => r.version),
    opts,
  )
  const [release] = await tx
    .insert(workflowReleases)
    .values({
      workflowId: locked.id,
      version,
      definition,
      definitionHash: hash,
      notes: opts.notes?.trim() || null,
      createdBy: opts.createdBy,
      gitCommit: opts.gitCommit,
      pythonLock: opts.pythonLock,
      jsLock: opts.js?.jsLock ?? null,
      jsBundleHash: opts.js?.jsBundleHash ?? null,
    })
    .returning()
  return release!
}

/** Makes an earlier (or later) release the live one: rollback. The same checks as publishing apply. */
export async function setLiveRelease(
  db: Db,
  access: Access,
  opts: { workflow: Workflow; releaseId: string; now?: Date; actorUserId?: string | null },
): Promise<WorkflowRelease> {
  const [release] = await db
    .select()
    .from(workflowReleases)
    .where(and(eq(workflowReleases.id, opts.releaseId), eq(workflowReleases.workflowId, opts.workflow.id)))
  if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
  const plan = await checkReleasable(db, access, opts.workflow, release.definition, {
    actorUserId: opts.actorUserId ?? null,
    lock: release.pythonLock,
    js: { jsLock: release.jsLock, jsBundleHash: release.jsBundleHash },
  })
  // A release from before its packages had a lock (or before M23) gets one now: live runs install it.
  if (plan.pythonLock && !release.pythonLock) {
    await db
      .update(workflowReleases)
      .set({ pythonLock: plan.pythonLock })
      .where(eq(workflowReleases.id, release.id))
  }
  // Its JavaScript packages' bundle, when it had none or lost it (rebuilt from its lock).
  if (plan.js && (plan.js.jsBundleHash !== release.jsBundleHash || plan.js.jsLock !== release.jsLock)) {
    await db
      .update(workflowReleases)
      .set({ jsLock: plan.js.jsLock, jsBundleHash: plan.js.jsBundleHash })
      .where(eq(workflowReleases.id, release.id))
  }
  await db.transaction(async (tx) => {
    await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, opts.workflow.id))
      .for('update')
    await makeLive(tx, opts.workflow.id, release, plan, opts.now ?? new Date())
  })
  return release
}

/** What going live needs, worked out before the transaction. */
interface ReleasePlan {
  /** Schedule name → environment id. */
  scheduleEnvironments: Map<string, string>
  aliasShape: string | null
  /** The Python packages' lock (M23), installed: null without packages or Python. */
  pythonLock: PythonLock | null
  /** The JavaScript packages' lock and bundle, built: null without packages. */
  js: ReleaseJsBundle | null
}

/**
 * The checks for making a definition live. Its runs start from webhooks and schedules with no user behind them, so
 * whoever makes it live vouches for it: they need Edit on the workflow, Use on every resource it queries in every
 * environment (a webhook can pick any environment), Use on every workflow it calls (each must be published) and on
 * every library query it uses (M21; the release it names must exist).
 * The definition must be valid, with each query checked by its connector, its schedules' environments must exist,
 * and its webhook alias must be free. `access` null is Git sync (M11): no grants are checked, the rest is.
 */
async function checkReleasable(
  db: Db,
  access: Access | null,
  workflow: Workflow,
  definition: WorkflowDefinition,
  python: {
    actorUserId: string | null
    lock?: PythonLock | null
    /** The release's JavaScript bundle and lock, for a rollback. */
    js?: { jsLock: string | null; jsBundleHash: string | null }
  },
): Promise<ReleasePlan> {
  if (access && !atLeast(access.workflowLevel(workflow), 'edit')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to this workflow to release it' })
  }
  const { resources, children, libraries, errors } = await checkDefinition(db, definition)
  if (errors.length) {
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The workflow isn't valid: ${errors[0]!.message}${more}`,
    })
  }
  const envs = await db.select().from(environments)
  for (const resource of access ? resources : []) {
    if (
      !atLeast(
        access!.levelEverywhere(
          resource,
          envs.map((e) => e.id),
        ),
        'use',
      )
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to resource "${resource.slug}" in every environment to release this workflow`,
      })
    }
  }

  // Nobody is behind a live run, so there's no one whose own account a per-user resource could use.
  if (resources.length) {
    const configs = await db
      .select({
        resourceId: resourceConfigs.resourceId,
        environmentId: resourceConfigs.environmentId,
        config: resourceConfigs.config,
        overrides: resourceConfigs.overrides,
      })
      .from(resourceConfigs)
      .where(
        inArray(
          resourceConfigs.resourceId,
          resources.map((r) => r.id),
        ),
      )
    const perUser = configs.find(
      (c) =>
        authorizationCode(resources.find((r) => r.id === c.resourceId)!.type, effectiveConfig(c))?.tokens ===
        'perUser',
    )
    if (perUser) {
      const resource = resources.find((r) => r.id === perUser.resourceId)!
      const env = envs.find((e) => e.id === perUser.environmentId)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Resource "${resource.slug}" uses each person's own account${env ? ` in ${env.slug}` : ''}, which a live run (webhook, schedule) has no one to use. Give it a shared account to release this workflow.`,
      })
    }
  }

  // Its child runs start unattended too. Workflow access applies in every environment.
  for (const child of access ? children : []) {
    if (!atLeast(access!.workflowLevel(child), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to workflow "${child.slug}" to release this workflow, which calls it`,
      })
    }
  }

  // Its library queries (M21): whoever releases vouches for using them, as for an app's.
  for (const library of access ? libraries : []) {
    if (!atLeast(access!.libraryQueryLevel(library), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to library query "${library.slug}" to release this workflow, which uses it`,
      })
    }
  }

  const defaultEnv = envs.find((e) => e.isDefault) ?? envs[0]!
  const scheduleEnvironments = new Map<string, string>()
  for (const schedule of definition.triggers?.schedules ?? []) {
    const env = schedule.environment ? envs.find((e) => e.slug === schedule.environment) : defaultEnv
    if (!env) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Schedule "${schedule.name}" runs in environment "${schedule.environment}", which doesn't exist`,
      })
    }
    scheduleEnvironments.set(schedule.name, env.id)
  }

  const webhook = definition.triggers?.webhook
  if (webhook?.enabled) await checkWebhookSettings(db, resolveWebhookSettings(webhook), envs)

  let aliasShape: string | null = null
  if (webhook?.enabled && webhook.alias !== undefined) {
    const parsed = parseWebhookAlias(webhook.alias)
    if (parsed.ok) aliasShape = parsed.shape
  }
  if (aliasShape) {
    const [taken] = await db
      .select({ slug: workflows.slug })
      .from(workflowTriggers)
      .innerJoin(workflows, eq(workflows.id, workflowTriggers.workflowId))
      .where(and(eq(workflowTriggers.aliasShape, aliasShape), ne(workflowTriggers.workflowId, workflow.id)))
    if (taken) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `The webhook alias "${webhook!.alias}" would answer the same URLs as workflow "${taken.slug}"'s`,
      })
    }
  }
  // Last, as it may take a while (a first install): every cheaper reason to refuse comes first.
  let pythonLock: PythonLock | null
  try {
    pythonLock = await releaseLock(db, definition, python.lock ?? null, {
      workflowId: workflow.id,
      actorUserId: python.actorUserId,
    })
  } catch (err) {
    if (!(err instanceof BlockFailure)) throw err
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  let js: ReleaseJsBundle | null
  try {
    js = await releaseJsBundle(db, definition.settings?.javascript?.packages, python.js ?? null, {
      objectType: 'workflow',
      objectId: workflow.id,
      actorUserId: python.actorUserId,
    })
  } catch (err) {
    if (!(err instanceof BlockFailure)) throw err
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  return { scheduleEnvironments, aliasShape, pythonLock, js }
}

/**
 * A live webhook's environments exist, and a signed one's secret is a secret config var with a value in each
 * environment the webhook runs in (its value isn't read here).
 */
async function checkWebhookSettings(db: Db, webhook: ResolvedWebhook, envs: Environment[]) {
  if (typeof webhook.environments !== 'string') {
    const unknown = webhook.environments.find((slug) => !envs.some((e) => e.slug === slug))
    if (unknown) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `The webhook runs in environment "${unknown}", which doesn't exist`,
      })
    }
  }
  const runsIn = webhookEnvironments(webhook, envs)
  // SNS (M30) signs with AWS's certificate: there's no secret to check.
  if (webhook.auth.type !== 'signature' || webhook.auth.preset === 'sns') return
  const name = webhook.auth.secret
  const [variable] = await db.select().from(configVars).where(eq(configVars.name, name))
  if (!variable) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The webhook's signing secret is config var "${name}", which doesn't exist`,
    })
  }
  if (!variable.isSecret) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Config var "${name}" isn't secret: make it a secret to sign webhooks with it`,
    })
  }
  const values = await db
    .select({ environmentId: configVarValues.environmentId })
    .from(configVarValues)
    .where(eq(configVarValues.configVarId, variable.id))
  const missing = runsIn.filter((env) => !values.some((v) => v.environmentId === env.id))
  if (missing.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Config var "${name}" has no value in ${missing.map((e) => e.name).join(', ')}, where the webhook runs`,
    })
  }
}

/** Points the workflow at the release and projects its triggers. Runs in the caller's transaction. */
async function makeLive(tx: Tx, workflowId: string, release: WorkflowRelease, plan: ReleasePlan, now: Date) {
  await tx.update(workflows).set({ liveReleaseId: release.id }).where(eq(workflows.id, workflowId))
  // The alias was checked before the transaction; the unique index catches another workflow taking it meanwhile.
  await uniqueOr('Another workflow just took this webhook alias', () =>
    projectTriggers(tx, workflowId, release, plan, now),
  )
}

/** The schedule settings that decide when it fires; when they're unchanged, its next fire time stays. */
const timingOf = (s: Partial<ScheduleTrigger>) =>
  JSON.stringify([s.cron ?? null, s.intervalMs ?? null, s.timezone ?? null])

/**
 * Rewrites `workflow_triggers` for the live release. Rows are matched by kind and name and updated in place, so a
 * trigger keeps its id across releases; triggers the release no longer has are deleted. A schedule whose timing
 * didn't change keeps its next fire time (republishing doesn't skip or repeat a fire); a new or changed one gets the
 * next fire after `now`.
 */
async function projectTriggers(
  tx: Tx,
  workflowId: string,
  release: WorkflowRelease,
  plan: ReleasePlan,
  now: Date,
) {
  const triggers = release.definition.triggers
  const existing = await tx.select().from(workflowTriggers).where(eq(workflowTriggers.workflowId, workflowId))
  const find = (kind: (typeof workflowTriggers.$inferSelect)['kind'], name: string) =>
    existing.find((t) => t.kind === kind && t.name === name)

  const rows: (typeof workflowTriggers.$inferInsert)[] = []
  if (triggers?.webhook) {
    rows.push({
      workflowId,
      releaseId: release.id,
      kind: 'webhook',
      name: 'webhook',
      enabled: triggers.webhook.enabled,
      // As written: resolveWebhookSettings applies the defaults when a call comes in.
      config: { ...triggers.webhook },
      environmentId: null,
      aliasShape: plan.aliasShape,
      nextFireAt: null,
    })
  }
  for (const schedule of triggers?.schedules ?? []) {
    const previous = find('schedule', schedule.name)
    const unchanged =
      previous?.enabled && previous.nextFireAt && timingOf(previous.config) === timingOf(schedule)
    rows.push({
      workflowId,
      releaseId: release.id,
      kind: 'schedule',
      name: schedule.name,
      enabled: schedule.enabled,
      config: { overlap: 'skip', ...schedule },
      environmentId: plan.scheduleEnvironments.get(schedule.name)!,
      aliasShape: null,
      nextFireAt: !schedule.enabled
        ? null
        : unchanged
          ? previous.nextFireAt
          : nextScheduleFire(schedule, now, previous?.lastFiredAt),
    })
  }

  const keep = rows.map((r) => find(r.kind, r.name)?.id).filter((id): id is string => !!id)
  await tx
    .delete(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workflowId, workflowId),
        keep.length ? notInArray(workflowTriggers.id, keep) : undefined,
      ),
    )
  for (const row of rows) {
    const current = find(row.kind, row.name)
    if (current) {
      await tx.update(workflowTriggers).set(row).where(eq(workflowTriggers.id, current.id))
    } else await tx.insert(workflowTriggers).values(row)
  }
}
