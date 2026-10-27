import type { Db } from '@ow/db'
import {
  encodeObjectDir,
  KIND_LABELS,
  MANIFEST_FILE,
  manifestFile,
  type ObjectKind,
  type RepoObject,
  type Warning,
} from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import type { Config } from '../../config'
import { GitError } from './cli'
import { commitToBranch, GitConflictError } from './commit'
import { folderPathOf } from './folders'
import { GitHubError, openGitHub, type PullRequestView } from './github'
import { type GitObjectRow, liveOrDraft, setGitProtected } from './kinds'
import type { GitAuthor, GitRepo } from './repo'
import { openGitRepo } from './settings'

type GitConfig = Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL'>

/** An object as the repo holds it; its definition is the kind's (as stored for it). */
export function repoObject(
  kind: ObjectKind,
  slug: string,
  value: { name: string; description: string | null; folder?: string; definition: unknown },
): RepoObject {
  const { name, description, folder, definition } = value
  return { kind, slug, value: { name, description, ...(folder ? { folder } : {}), definition } } as RepoObject
}

/** Refuses changing a protected object's main version on the instance: that's done on a branch and merged. */
export function requireUnprotected(
  object: { gitProtected: boolean },
  kind: ObjectKind,
  action: string,
): void {
  if (object.gitProtected) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `This ${KIND_LABELS[kind]} is protected: ${action} on a Git branch, and merge it to deploy`,
    })
  }
}

/**
 * Changing which release of a protected object is live: admins only, as an emergency rollback. It stays until Git
 * changes the object (a deploy that changes its directory) or an admin's Deploy now: a merge touching only other
 * objects leaves it, so nobody's unrelated change puts back what was rolled back.
 */
export function requireRollbackAllowed(
  object: { gitProtected: boolean },
  kind: ObjectKind,
  user: { isAdmin: boolean },
): void {
  if (object.gitProtected && !user.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This ${KIND_LABELS[kind]} is protected: only admins can change its live release (an emergency rollback, until its next change in Git or Deploy now)`,
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

/** Changes reach the deploy branch through pull requests only: drafts and protecting work on other branches. */
export function requireNotDeployBranch(branch: string, deployBranch: string): void {
  if (branch === deployBranch) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Changes reach ${deployBranch} through pull requests: pick another branch`,
    })
  }
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
 * Protects an object of any kind: its live release (or its draft, if it has none) goes onto a branch as the object's
 * directory, a pull request adds it to the deploy branch, and from now on the object is edited on branches only.
 * Merging the pull request deploys it (a release made by Git sync, when it differs from what's live).
 */
export async function protectObject(
  db: Db,
  config: GitConfig,
  user: { id: string; name: string; email: string },
  opts: { kind: ObjectKind; object: GitObjectRow; branch?: string },
): Promise<ProtectResult> {
  const { kind, object } = opts
  const label = KIND_LABELS[kind]
  if (object.gitProtected)
    throw new TRPCError({ code: 'CONFLICT', message: `This ${label} is already protected` })
  const definition = await liveOrDraft(db, kind, object)
  const meta = {
    name: object.name,
    description: object.description,
    folder: await folderPathOf(db, object.folderId),
  }
  const { dir, files, warnings } = encodeObjectDir(repoObject(kind, object.slug, { ...meta, definition }))
  return commitProtect(db, config, user, {
    kind,
    label,
    slug: object.slug,
    name: object.name,
    dir,
    files,
    warnings,
    branch: opts.branch,
    what: definition === object.draftDefinition ? 'draft' : 'live release',
    afterBase: 'edited on branches and deployed',
    setProtected: () => setGitProtected(db, kind, object.id, true, { from: false }),
  })
}

/**
 * The part of protecting every kind shares: the directory committed onto a protect branch (made from the deploy
 * branch, `ow.json` added when missing), the object marked protected, and the pull request opened.
 */
export async function commitProtect(
  db: Db,
  config: GitConfig,
  user: { id: string; name: string; email: string },
  opts: {
    /** Names the default branch: `protect/<kind>-<slug>`. */
    kind: string
    label: string
    slug: string
    name: string
    dir: string
    files: Record<string, string>
    warnings: Warning[]
    branch?: string
    /** What was committed, for the message: "live release", "settings". */
    what: string
    /** How it changes from now on, for the message. */
    afterBase: string
    /** Marks it protected; false when someone else just did. */
    setProtected: () => Promise<boolean>
  },
): Promise<ProtectResult> {
  const { label, dir } = opts
  const { repo, branch: base } = await requireGitRepo(db, config)
  if (opts.branch) requireNotDeployBranch(opts.branch, base)
  const author = { name: user.name, email: user.email }
  let branch: string
  let commit: string
  try {
    branch = opts.branch ?? (await freeProtectBranch(repo, `protect/${opts.kind}-${opts.slug}`))
    const main = await ensureBaseBranch(repo, base, author)
    const result = await commitToBranch(repo, {
      branch,
      base: main,
      createFrom: main,
      directories: { [dir]: opts.files },
      files: await manifestIfMissing(repo, main),
      message: `Protect ${label} ${opts.slug}\n\nFrom Optiply Workflows: the ${label}'s ${opts.what}, so it's ${opts.afterBase} from ${base} from now on.`,
      author,
    })
    commit = result.commit
  } catch (err) {
    throw gitTrpcError(err)
  }

  if (!(await opts.setProtected()))
    throw new TRPCError({ code: 'CONFLICT', message: `This ${label} was just protected by someone else` })

  const { pullRequest, pullRequestError } = await openPullRequestFor(db, config, {
    branch,
    title: `Protect ${label} "${opts.name}"`,
    body: `Adds \`${dir}/\` so the ${label} is deployed from this repo. Opened from Optiply Workflows by ${user.name}.`,
  })
  return { branch, commit, pullRequest, pullRequestError, warnings: opts.warnings }
}

/** Lets an object be edited on the instance again. Its directory stays in the repo (and stops deploying). */
export async function unprotectObject(db: Db, kind: ObjectKind, object: GitObjectRow): Promise<void> {
  if (!object.gitProtected) {
    throw new TRPCError({ code: 'CONFLICT', message: `This ${KIND_LABELS[kind]} isn't protected` })
  }
  await setGitProtected(db, kind, object.id, false)
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

/**
 * The default protect branch, or the first of `<name>-2`, `<name>-3` … the repo doesn't have yet: one left from an
 * earlier protect (unprotected before it merged) holds that version, and building on it would conflict.
 */
async function freeProtectBranch(repo: GitRepo, name: string): Promise<string> {
  for (let n = 1; n <= 100; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`
    if ((await repo.fetchBranch(candidate)) === null) return candidate
  }
  throw new GitError('failed', `Every branch from ${name} to ${name}-100 exists: delete some`)
}
