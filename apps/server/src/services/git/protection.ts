import type { AppDefinition } from '@ow/app-definition'
import {
  type App,
  type AppRelease,
  appReleases,
  apps,
  type Db,
  type Workflow,
  type WorkflowRelease,
  workflowReleases,
  workflows,
} from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { encodeObjectDir, MANIFEST_FILE, manifestFile, type ObjectKind, type Warning } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import type { Config } from '../../config'
import { GitError } from './cli'
import { commitToBranch, GitConflictError } from './commit'
import { GitHubError, openGitHub, type PullRequestView } from './github'
import type { GitAuthor, GitRepo } from './repo'
import { openGitRepo } from './settings'

type GitConfig = Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL'>

/** Refuses changing a protected object's main version on the instance: that's done on a branch and merged. */
export function requireUnprotected(
  object: { gitProtected: boolean },
  kind: ObjectKind,
  action: string,
): void {
  if (object.gitProtected) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `This ${kind} is protected: ${action} on a Git branch, and merge it to deploy`,
    })
  }
}

/**
 * Changing which release of a protected object is live: admins only, as an emergency rollback (the next deploy
 * from Git replaces it).
 */
export function requireRollbackAllowed(
  object: { gitProtected: boolean },
  kind: ObjectKind,
  user: { isAdmin: boolean },
): void {
  if (object.gitProtected && !user.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This ${kind} is protected: only admins can change its live release (an emergency rollback, until the next deploy from Git)`,
    })
  }
}

/** A Git or GitHub failure as an API error people can act on. */
export function gitTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err
  if (err instanceof GitConflictError) return new TRPCError({ code: 'CONFLICT', message: err.message })
  if (err instanceof GitError || err instanceof GitHubError) {
    const code =
      err.kind === 'auth' || err.kind === 'not_found' || err.kind === 'refused' || err.kind === 'unsupported'
        ? 'PRECONDITION_FAILED'
        : err.kind === 'invalid'
          ? 'BAD_REQUEST'
          : 'BAD_GATEWAY'
    return new TRPCError({ code, message: err.message })
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message, cause: err })
}

/** The repo, or PRECONDITION_FAILED when Git sync isn't set up. */
export async function requireGitRepo(db: Db, config: GitConfig) {
  const opened = await openGitRepo(db, config)
  if (!opened) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Set up Git sync first (Settings → Git)' })
  }
  return opened
}

/**
 * The deploy branch's tip, making it when the repo is empty (a first commit with `ow.json`, so pull requests have a
 * base). Pushing it can only race with someone else's first commit; then theirs is used.
 */
export async function ensureBaseBranch(repo: GitRepo, branch: string, author: GitAuthor): Promise<string> {
  const tip = await repo.fetchBranch(branch)
  if (tip) return tip
  const first = await repo.commit({
    parent: null,
    files: { [MANIFEST_FILE]: manifestFile() },
    message: 'Start the Optiply Workflows repo',
    author,
  })
  if ((await repo.push(first!, branch)) === 'ok') return first!
  const theirs = await repo.fetchBranch(branch)
  if (!theirs) throw new GitError('failed', `Couldn't create ${branch}`)
  return theirs
}

/** `ow.json`, when the commit at `base` doesn't have it yet. */
export async function manifestIfMissing(
  repo: GitRepo,
  base: string,
): Promise<Record<string, string> | undefined> {
  const files = await repo.readFiles(base, [MANIFEST_FILE])
  return files[MANIFEST_FILE] === undefined ? { [MANIFEST_FILE]: manifestFile() } : undefined
}

export interface ProtectResult {
  branch: string
  commit: string
  pullRequest: PullRequestView | null
  /** Why no pull request could be opened (not GitHub, no token): the branch is there to open one by hand. */
  pullRequestError: string | null
  warnings: Warning[]
}

/**
 * Protects a workflow or app: its live release (or its draft, if it has none) goes onto a branch as the object's
 * directory, a pull request adds it to the deploy branch, and from now on the object is edited on branches only.
 * Merging the pull request deploys it (a release made by Git sync, when it differs from what's live).
 */
export async function protectObject(
  db: Db,
  config: GitConfig,
  user: { id: string; name: string; email: string },
  opts: { kind: ObjectKind; object: Workflow | App; branch?: string },
): Promise<ProtectResult> {
  const { kind, object } = opts
  if (object.gitProtected)
    throw new TRPCError({ code: 'CONFLICT', message: `This ${kind} is already protected` })
  const { repo, branch: base } = await requireGitRepo(db, config)
  const definition = await liveOrDraft(db, kind, object)
  const meta = { name: object.name, description: object.description }
  const { dir, files, warnings } = encodeObjectDir(
    kind === 'workflow'
      ? { kind, slug: object.slug, value: { ...meta, definition: definition as WorkflowDefinition } }
      : { kind, slug: object.slug, value: { ...meta, definition: definition as AppDefinition } },
  )
  const branch = opts.branch ?? `protect/${kind}-${object.slug}`
  const author = { name: user.name, email: user.email }
  let commit: string
  try {
    const main = await ensureBaseBranch(repo, base, author)
    const result = await commitToBranch(repo, {
      branch,
      base: main,
      createFrom: main,
      directories: { [dir]: files },
      files: await manifestIfMissing(repo, main),
      message: `Protect ${kind} ${object.slug}\n\nFrom Optiply Workflows: the ${kind}'s ${
        definition === object.draftDefinition ? 'draft' : 'live release'
      }, so it's edited on branches and deployed from ${base} from now on.`,
      author,
    })
    commit = result.commit
  } catch (err) {
    throw gitTrpcError(err)
  }

  const table = kind === 'workflow' ? workflows : apps
  const [updated] = await db
    .update(table)
    .set({ gitProtected: true })
    .where(and(eq(table.id, object.id), eq(table.gitProtected, false)))
    .returning({ id: table.id })
  if (!updated)
    throw new TRPCError({ code: 'CONFLICT', message: `This ${kind} was just protected by someone else` })

  const { pullRequest, pullRequestError } = await openPullRequestFor(db, config, {
    branch,
    title: `Protect ${kind} "${object.name}"`,
    body: `Adds \`${dir}/\` so the ${kind} is deployed from this repo. Opened from Optiply Workflows by ${user.name}.`,
  })
  return { branch, commit, pullRequest, pullRequestError, warnings }
}

/** Lets an object be edited on the instance again. Its directory stays in the repo (and stops deploying). */
export async function unprotectObject(db: Db, kind: ObjectKind, object: Workflow | App): Promise<void> {
  if (!object.gitProtected) throw new TRPCError({ code: 'CONFLICT', message: `This ${kind} isn't protected` })
  const table = kind === 'workflow' ? workflows : apps
  await db.update(table).set({ gitProtected: false }).where(eq(table.id, object.id))
}

/** Opens (or finds) the branch's pull request; failures come back as a message rather than an error. */
export async function openPullRequestFor(
  db: Db,
  config: Pick<Config, 'keyring' | 'GITHUB_API_URL'>,
  opts: { branch: string; title: string; body: string },
): Promise<{ pullRequest: PullRequestView | null; pullRequestError: string | null }> {
  const opened = await openGitHub(db, config)
  if ('error' in opened) return { pullRequest: null, pullRequestError: opened.error }
  try {
    const pullRequest = await opened.github.openPullRequest({ ...opts, base: opened.branch })
    return { pullRequest, pullRequestError: null }
  } catch (err) {
    if (err instanceof GitHubError) return { pullRequest: null, pullRequestError: err.message }
    throw err
  }
}

async function liveOrDraft(db: Db, kind: ObjectKind, object: Workflow | App) {
  if (!object.liveReleaseId) return object.draftDefinition
  const [release]: Array<WorkflowRelease | AppRelease> =
    kind === 'workflow'
      ? await db.select().from(workflowReleases).where(eq(workflowReleases.id, object.liveReleaseId))
      : await db.select().from(appReleases).where(eq(appReleases.id, object.liveReleaseId))
  return release?.definition ?? object.draftDefinition
}
