import type { AppDefinition, LibraryQueryDefinition } from '@ow/app-definition'
import {
  type App,
  type Db,
  type GIT_DEPLOY_TRIGGERS,
  type GitObject,
  type GitProblem,
  gitDeploys,
  gitObjects,
  gitSettings,
  type LibraryQuery,
  type Module,
  type Workflow,
} from '@ow/db'
import { canonicalJson, type WorkflowDefinition } from '@ow/definition'
import {
  checkManifest,
  decodeRepo,
  KIND_LABELS,
  KIND_ROOTS,
  MANIFEST_FILE,
  type ObjectKind,
  objectDir,
  type RepoObject,
  SETTINGS_ROOTS,
  type SettingsKind,
  settingsDir,
} from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { desc, eq, sql } from 'drizzle-orm'
import { recordAudit } from '../../audit'
import type { Config } from '../../config'
import { deployAppFromGit } from '../apps'
import { deployLibraryQueryFromGit } from '../library-queries'
import { deployModuleFromGit } from '../modules'
import { deployWorkflowFromGit } from '../releases'
import { GitError } from './cli'
import { deployConfigVar, deployResource } from './deploy-settings'
import { type FolderMove, moveToGitFolder } from './folders'
import { insertGitObject, loadGitObject, protectedObjectIds } from './kinds'
import { openGitRepo } from './settings'

export type DeployTrigger = (typeof GIT_DEPLOY_TRIGGERS)[number]

/** Resources and config vars go before every other kind; config vars first, as resources may name them. */
const SETTINGS_ORDER: readonly SettingsKind[] = ['config_var', 'resource']

/** The order a deploy goes in: what other objects use comes first. */
const DEPLOY_ORDER: readonly ObjectKind[] = ['library_query', 'module', 'workflow', 'app']

/** What a deploy did with one object directory. */
export interface ObjectOutcome {
  kind: ObjectKind | SettingsKind
  slug: string
  /**
   * `created`: a new workflow, app, library query or module (and its first release, unless it has problems); `released`: a new live
   * release; `updated`: a resource's or config var's settings changed, or an object moved to another folder without
   * a new release (M22); `unchanged`: the directory, or at least
   * its definition, is what's already live; `problem`: not deployed (the live release stays); `missing`: the
   * directory left the branch.
   */
  outcome: 'created' | 'released' | 'updated' | 'unchanged' | 'problem' | 'missing'
  objectId?: string | null
  treeSha?: string | null
  version?: string
  problems?: GitProblem[]
  /** Moved into the folder Git names (M22). */
  folder?: FolderMove
  /** Made by this deploy (a later pass may still release it). */
  created?: boolean
}

export type DeployResult =
  | { status: 'not_configured' }
  /** Another process is deploying; it was asked to go again when it's done. */
  | { status: 'busy' }
  /** The branch couldn't be read (sign-in, network): `git_settings.last_error`. */
  | { status: 'failed'; error: string }
  /** The repo has no such branch yet. */
  | { status: 'empty' }
  | { status: 'up_to_date'; commit: string }
  | { status: 'deployed'; commit: string; ok: boolean; objects: ObjectOutcome[]; problems: GitProblem[] }

type DeployConfig = Pick<
  Config,
  'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GOOGLE_SERVER_IDENTITY'
>

interface DeployLogger {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/** How long a deploy may hold the lease before another process may take over (renewed as it goes). */
const LEASE = sql`now() + interval '5 minutes'`
/** Requests that arrive while deploying make it go again, this many times at most. */
const MAX_ROUNDS = 5
/** Deploy history kept. */
const KEEP_DEPLOYS = 200

/**
 * Audited changes a problem object may have been waiting for (M22): resources (secrets and overrides included),
 * config vars, library queries and modules. Running their queries changes nothing.
 */
const RETRY_ACTIONS = /^(resource|config_var|library_query|module)\.(?!query_run$)/

/** Whether an audited action marks the last deploy's problem objects for a re-check. */
export function asksForGitRetry(action: string): boolean {
  return RETRY_ACTIONS.test(action)
}

/** Marks the last deploy's problem objects for a re-check by the next poll (nothing without Git sync). */
export async function requestGitRetry(db: Db): Promise<void> {
  await db.update(gitSettings).set({ retryRequestedAt: sql`now()` })
}

/**
 * Asks for a deploy (a webhook, an admin's Deploy now) and runs it here unless another process holds the lease, in
 * which case that one goes again when it's done.
 */
export async function requestGitDeploy(
  db: Db,
  config: DeployConfig,
  opts: { trigger: DeployTrigger; force?: boolean; log?: DeployLogger },
): Promise<DeployResult> {
  await db.update(gitSettings).set({ deployRequestedAt: sql`now()`, deployRequestedBy: opts.trigger })
  return runGitDeploy(db, config, opts)
}

/**
 * Deploys the branch's tip if this process gets the lease: one deploy at a time across every process. Requests
 * that came in meanwhile make it go again. `force` re-checks every object, deployed ones too (Deploy now, say after
 * creating a missing resource). Never throws for Git or definition problems; they're recorded.
 */
export async function runGitDeploy(
  db: Db,
  config: DeployConfig,
  opts: { trigger: DeployTrigger; force?: boolean; retry?: boolean; log?: DeployLogger },
): Promise<DeployResult> {
  const claimed = await db
    .update(gitSettings)
    .set({ deployLeaseUntil: LEASE, deployRequestedAt: null, deployRequestedBy: null })
    .where(sql`${gitSettings.deployLeaseUntil} is null or ${gitSettings.deployLeaseUntil} < now()`)
    .returning({ id: gitSettings.id })
  if (claimed.length === 0) {
    const [settings] = await db.select({ id: gitSettings.id }).from(gitSettings)
    return settings ? { status: 'busy' } : { status: 'not_configured' }
  }
  let result: DeployResult = { status: 'not_configured' }
  let trigger = opts.trigger
  let force = opts.force ?? false
  // Once handed back, the lease may be someone else's: only a lease still held here is released at the end.
  let held = true
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const retry = round === 0 && (opts.retry ?? false)
      result = await deployOnce(db, config, { trigger, force, retry, log: opts.log })
      const next = await handBackLease(db)
      if (!next.again) {
        held = false
        return result
      }
      trigger = next.by ?? 'webhook'
      force = trigger === 'manual'
    }
    // Out of rounds with a request taken for one more: put it back for the next deploy (a poll, a webhook).
    await db.update(gitSettings).set({ deployRequestedAt: sql`now()`, deployRequestedBy: trigger })
    return result
  } finally {
    if (held) {
      await db
        .update(gitSettings)
        .set({ deployLeaseUntil: null })
        .catch(() => {})
    }
  }
}

/**
 * Ends a deploy round: hands the lease back, unless someone asked for a deploy meanwhile, in which case the lease
 * is kept for another round (`again`, and who asked). RETURNING gives the new row, so the request is read in a CTE
 * first; the table has one row.
 */
export async function handBackLease(db: Db): Promise<{ again: boolean; by: DeployTrigger | null }> {
  const [row] = await db.execute<{ again: boolean; by: DeployTrigger | null }>(sql`
    with old as (select deploy_requested_at, deploy_requested_by from git_settings for update)
    update git_settings set
      deploy_lease_until = case when old.deploy_requested_at is null then null else ${LEASE} end,
      deploy_requested_at = null,
      deploy_requested_by = null
    from old
    returning old.deploy_requested_at is not null as again, old.deploy_requested_by as by`)
  return { again: row?.again ?? false, by: row?.by ?? null }
}

async function deployOnce(
  db: Db,
  config: DeployConfig,
  opts: { trigger: DeployTrigger; force: boolean; retry: boolean; log?: DeployLogger },
): Promise<DeployResult> {
  const opened = await openGitRepo(db, config)
  const [settings] = await db.select().from(gitSettings)
  if (!opened || !settings) return { status: 'not_configured' }
  const { repo, branch } = opened
  const checked = (patch: Partial<typeof gitSettings.$inferInsert> = {}) =>
    db.update(gitSettings).set({ checkedAt: sql`now()`, lastError: null, deployLeaseUntil: LEASE, ...patch })

  let commit: string | null
  try {
    commit = await repo.fetchBranch(branch)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    await checked({ lastError: err.message })
    opts.log?.error({ err }, 'git deploy: could not read the branch')
    return { status: 'failed', error: err.message }
  }
  if (!commit) {
    await checked()
    return { status: 'empty' }
  }
  // Every deploy re-checks the problem objects, so it takes the retry mark (a mark set from here on stays).
  const marked = await takeRetryMark(db)
  // The deployed commit again for its problem objects (M22): asked for, or something they may need changed.
  let retrying = false
  if (!opts.force && commit === settings.deployedCommit) {
    if (!((opts.retry || marked) && (await hasProblemObjects(db)))) {
      await checked()
      return { status: 'up_to_date', commit }
    }
    retrying = true
  }
  const trigger: DeployTrigger = retrying ? 'retry' : opts.trigger

  const startedAt = new Date()
  const roots = [...Object.values(KIND_ROOTS), ...Object.values(SETTINGS_ROOTS)]
  const files = await repo.readFiles(commit, [MANIFEST_FILE, ...roots.map((r) => `${r}/`)])
  const trees = await repo.subtrees(commit, roots)
  const info = await repo.commitInfo(commit)
  const decoded = decodeRepo(files)
  const repoProblems: GitProblem[] = decoded.problems
  const rows = await db.select().from(gitObjects)
  // An unchanged directory is skipped only while its object is still there and protected (one deleted on the
  // instance comes back).
  const protectedIds = await protectedObjectIds(db)
  const rowOf = (kind: ObjectKind | SettingsKind, slug: string) =>
    rows.find((r) => r.kind === kind && r.slug === slug)
  const unchanged = (row: GitObject | undefined, treeSha: string | null) =>
    !opts.force &&
    row?.status === 'deployed' &&
    row.treeSha === treeSha &&
    !!row.objectId &&
    protectedIds.has(row.objectId)
  const outcomes: ObjectOutcome[] = []

  // A repo in a format this version doesn't read (or without ow.json) deploys nothing.
  const blocked = checkManifest(files).length > 0 && decoded.objects.length + decoded.settings.length > 0
  if (!blocked) {
    // Config vars, then resources (M22): what workflows and apps need is there before they're checked.
    const settings = [...decoded.settings].sort(
      (a, b) => SETTINGS_ORDER.indexOf(a.kind) - SETTINGS_ORDER.indexOf(b.kind),
    )
    for (const object of settings) {
      const treeSha = trees.get(settingsDir(object.kind, object.slug)) ?? null
      const row = rowOf(object.kind, object.slug)
      if (unchanged(row, treeSha)) {
        outcomes.push({
          kind: object.kind,
          slug: object.slug,
          outcome: 'unchanged',
          objectId: row!.objectId,
          treeSha,
        })
        continue
      }
      if (!object.result.ok) {
        outcomes.push({
          kind: object.kind,
          slug: object.slug,
          outcome: 'problem',
          objectId: row?.objectId ?? null,
          treeSha,
          problems: object.result.problems,
        })
        continue
      }
      const result = object.result.value
      const item = { slug: object.slug, treeSha }
      outcomes.push(
        result.kind === 'config_var'
          ? await deployConfigVar(db, { ...item, value: result.value }, { commit })
          : await deployResource(
              db,
              { ...item, value: result.value },
              { commit },
              {
                serverIdentity: config.GOOGLE_SERVER_IDENTITY === 'allow',
              },
            ),
      )
      await db.update(gitSettings).set({ deployLeaseUntil: LEASE })
    }

    type Pending = {
      kind: ObjectKind
      slug: string
      treeSha: string | null
      value: RepoObject['value']
      created?: boolean
    }
    const pending: Pending[] = []
    for (const object of decoded.objects) {
      const treeSha = trees.get(objectDir(object.kind, object.slug)) ?? null
      const row = rowOf(object.kind, object.slug)
      if (unchanged(row, treeSha)) {
        outcomes.push({
          kind: object.kind,
          slug: object.slug,
          outcome: 'unchanged',
          objectId: row!.objectId,
          treeSha,
        })
        continue
      }
      if (!object.result.ok) {
        outcomes.push({
          kind: object.kind,
          slug: object.slug,
          outcome: 'problem',
          objectId: row?.objectId ?? null,
          treeSha,
          problems: object.result.problems,
        })
        continue
      }
      pending.push({ kind: object.kind, slug: object.slug, treeSha, value: object.result.value.value })
    }

    // What others use first (library queries, modules, workflows, then apps); in passes, so a new workflow can call
    // another one new in the same commit.
    pending.sort((a, b) => DEPLOY_ORDER.indexOf(a.kind) - DEPLOY_ORDER.indexOf(b.kind))
    let remaining = pending
    for (;;) {
      const failed: Array<{ item: Pending; outcome: ObjectOutcome }> = []
      for (const item of remaining) {
        const outcome = await deployObject(db, item, { commit, subject: releaseNotes(info) })
        if (outcome.outcome === 'problem') failed.push({ item, outcome })
        else outcomes.push(outcome)
        await db.update(gitSettings).set({ deployLeaseUntil: LEASE })
      }
      if (failed.length === 0 || failed.length === remaining.length) {
        outcomes.push(...failed.map((f) => f.outcome))
        break
      }
      remaining = failed.map((f) => ({ ...f.item, created: f.item.created || f.outcome.created }))
    }

    // Directories that left the branch: the objects stay, flagged, and stop deploying.
    const present = new Set([...decoded.objects, ...decoded.settings].map((o) => `${o.kind}:${o.slug}`))
    for (const row of rows) {
      if (row.status !== 'missing' && !present.has(`${row.kind}:${row.slug}`)) {
        outcomes.push({
          kind: row.kind,
          slug: row.slug,
          outcome: 'missing',
          objectId: row.objectId,
          treeSha: null,
        })
      }
    }
    // A retry that changed nothing (the same problems again) isn't a deploy worth recording.
    if (retrying && !outcomes.some((o) => isNews(o, rowOf(o.kind, o.slug)))) {
      await checked()
      return { status: 'up_to_date', commit }
    }
    await saveOutcomes(db, commit, outcomes)
  }

  const objectProblems = outcomes.filter((o) => o.outcome === 'problem')
  const ok = repoProblems.length === 0 && objectProblems.length === 0
  const changed = outcomes.filter((o) => o.outcome !== 'unchanged')
  await db.insert(gitDeploys).values({
    commit,
    previousCommit: settings.deployedCommit,
    trigger,
    status: ok ? 'ok' : 'problems',
    summary: {
      subject: releaseNotes(info),
      author: { name: info.authorName, email: info.authorEmail },
      objects: changed.map(({ kind, slug, outcome, version, problems, folder }) => ({
        kind,
        slug,
        outcome,
        version,
        problems,
        folder,
      })),
      unchanged: outcomes.length - changed.length,
      problems: repoProblems,
    },
    startedAt,
    finishedAt: new Date(),
  })
  await db.execute(sql`
    delete from git_deploys where id not in (
      select id from git_deploys order by started_at desc limit ${KEEP_DEPLOYS})`)
  await checked({ deployedCommit: commit })
  const count = (outcome: ObjectOutcome['outcome']) => outcomes.filter((o) => o.outcome === outcome).length
  await recordAudit(db, {
    actorUserId: null,
    action: 'git.deployed',
    objectType: 'git_settings',
    metadata: {
      commit,
      trigger,
      created: count('created'),
      released: count('released'),
      updated: count('updated'),
      problems: objectProblems.length + repoProblems.length,
      missing: count('missing'),
    },
  })
  opts.log?.info({ commit, trigger, ok, changed: changed.length }, 'git deploy finished')
  return { status: 'deployed', commit, ok, objects: outcomes, problems: repoProblems }
}

/** Takes the retry mark: whether one was set. */
async function takeRetryMark(db: Db): Promise<boolean> {
  const taken = await db
    .update(gitSettings)
    .set({ retryRequestedAt: null })
    .where(sql`${gitSettings.retryRequestedAt} is not null`)
    .returning({ id: gitSettings.id })
  return taken.length > 0
}

async function hasProblemObjects(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: gitObjects.id })
    .from(gitObjects)
    .where(eq(gitObjects.status, 'problem'))
    .limit(1)
  return Boolean(row)
}

/** Whether an outcome differs from what the directory's row already says. */
function isNews(outcome: ObjectOutcome, row: GitObject | undefined): boolean {
  if (outcome.outcome === 'unchanged') return false
  if (outcome.outcome !== 'problem' || row?.status !== 'problem') return true
  // Compared canonically: jsonb doesn't keep the keys' order.
  return canonicalJson(outcome.problems ?? []) !== canonicalJson(row.problems)
}

/**
 * A release's notes from the commit it deploys: its subject, or for GitHub's merge commits ("Merge pull request
 * #12 from optiply/branch", the title on the next line) the pull request's title and number.
 */
export function releaseNotes(info: { subject: string; body: string }): string {
  const merge = /^Merge pull request #(\d+) from \S+$/.exec(info.subject)
  const title = info.body.split('\n')[0]?.trim()
  return merge && title ? `${title} (#${merge[1]})` : info.subject
}

/** Creates or updates one object of any kind from its decoded files. Problems come back as an outcome. */
async function deployObject(
  db: Db,
  item: {
    kind: ObjectKind
    slug: string
    treeSha: string | null
    value: RepoObject['value']
    /** An earlier pass of this deploy made it. */
    created?: boolean
  },
  git: { commit: string; subject: string },
): Promise<ObjectOutcome> {
  const { kind, slug, treeSha } = item
  const dir = objectDir(kind, slug)
  let created = item.created ?? false
  const problem = (code: string, message: string, objectId: string | null = null): ObjectOutcome => ({
    kind,
    slug,
    outcome: 'problem',
    objectId,
    treeSha,
    problems: [{ path: dir, code, message }],
    created,
  })
  const label = KIND_LABELS[kind]
  let object = await loadGitObject(db, kind, { slug })
  if (!object) {
    const inserted = await insertGitObject(db, kind, { slug, ...item.value })
    if (!inserted) return problem('slug_taken', `A ${label} "${slug}" was just created on the instance`)
    object = inserted
    created = true
    await recordAudit(db, {
      actorUserId: null,
      action: `${kind}.created`,
      objectType: kind,
      objectId: inserted.id,
      metadata: { slug, source: 'git', commit: git.commit },
    })
  } else if (!object.gitProtected) {
    return problem(
      'not_protected',
      `A ${label} "${slug}" exists on the instance and isn't protected: protect it there to deploy it from Git`,
      object.id,
    )
  }

  try {
    const meta = {
      name: item.value.name,
      description: item.value.description,
      commit: git.commit,
      notes: git.subject,
    }
    const definition = item.value.definition
    const release = await (() => {
      switch (kind) {
        case 'workflow':
          return deployWorkflowFromGit(db, {
            ...meta,
            workflow: object as Workflow,
            definition: definition as WorkflowDefinition,
          })
        case 'app':
          return deployAppFromGit(db, {
            ...meta,
            app: object as App,
            definition: definition as AppDefinition,
          })
        case 'library_query':
          return deployLibraryQueryFromGit(db, {
            ...meta,
            query: object as LibraryQuery,
            definition: definition as LibraryQueryDefinition,
          })
        case 'module':
          return deployModuleFromGit(db, {
            ...meta,
            module: object as Module,
            definition: definition as AppDefinition,
          })
      }
    })()
    if (release) {
      await recordAudit(db, {
        actorUserId: null,
        action: `${kind}.release_published`,
        objectType: kind,
        objectId: object.id,
        metadata: {
          releaseId: release.id,
          version: release.version,
          definitionHash: release.definitionHash,
          source: 'git',
          commit: git.commit,
        },
      })
    }
    // Into its Git folder once deployed: a directory with problems leaves the object where it is.
    const folder = await moveToGitFolder(db, kind, object, item.value.folder, git)
    if (folder && !created) {
      await recordAudit(db, {
        actorUserId: null,
        action: `${kind}.updated`,
        objectType: kind,
        objectId: object.id,
        metadata: { slug, folder: folder.to, source: 'git', commit: git.commit },
      })
    }
    return {
      kind,
      slug,
      outcome: created ? 'created' : release ? 'released' : folder ? 'updated' : 'unchanged',
      objectId: object.id,
      treeSha,
      version: release?.version,
      ...(folder ? { folder } : {}),
    }
  } catch (err) {
    if (err instanceof TRPCError) return problem('invalid_definition', err.message, object.id)
    return problem('deploy_failed', `Deploying failed: ${(err as Error).message}`, object.id)
  }
}

/** Records each directory's state: what deployed, what has problems, what's gone. */
async function saveOutcomes(db: Db, commit: string, outcomes: ObjectOutcome[]): Promise<void> {
  for (const o of outcomes) {
    const status: GitObject['status'] =
      o.outcome === 'problem' ? 'problem' : o.outcome === 'missing' ? 'missing' : 'deployed'
    const values = {
      kind: o.kind,
      slug: o.slug,
      objectId: o.objectId ?? null,
      treeSha: o.outcome === 'missing' ? null : (o.treeSha ?? null),
      commit,
      status,
      problems: o.problems ?? [],
      ...(o.version ? { version: o.version } : {}),
    }
    await db
      .insert(gitObjects)
      .values(values)
      .onConflictDoUpdate({
        target: [gitObjects.kind, gitObjects.slug],
        set: { ...values, updatedAt: sql`now()` },
      })
  }
}

/** For the Git page: the settings' deploy state, every directory's, and recent deploys. */
export async function gitDeployStatus(db: Db) {
  const [settings] = await db
    .select({
      branch: gitSettings.branch,
      deployedCommit: gitSettings.deployedCommit,
      checkedAt: gitSettings.checkedAt,
      lastError: gitSettings.lastError,
      deploying: sql<boolean>`${gitSettings.deployLeaseUntil} is not null and ${gitSettings.deployLeaseUntil} > now()`,
    })
    .from(gitSettings)
  const objects = await db.select().from(gitObjects).orderBy(gitObjects.kind, gitObjects.slug)
  const deploys = await db.select().from(gitDeploys).orderBy(desc(gitDeploys.startedAt)).limit(20)
  return { settings: settings ?? null, objects, deploys }
}
