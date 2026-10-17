import { type AppDefinition, appDefinitionHash, appDefinitionSchema, validateApp } from '@ow/app-definition'
import {
  type App,
  apps,
  type Db,
  type GitBranchDraft,
  gitBranchDrafts,
  type Workflow,
  workflows,
} from '@ow/db'
import {
  definitionHash,
  validateDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import {
  decodeObject,
  encodeObjectDir,
  type Files,
  type ObjectKind,
  objectDir,
  type Problem,
  type RepoObject,
} from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import type { Config } from '../../config'
import { invalidInput } from '../../trpc/errors'
import { commitToBranch, GitConflictError } from './commit'
import {
  ensureBaseBranch,
  gitTrpcError,
  liveOrDraft,
  manifestIfMissing,
  requireGitRepo,
  requireNotDeployBranch,
} from './protection'
import type { GitRepo } from './repo'

type GitConfig = Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS'>
type User = { id: string; name: string; email: string }

/** Larger files are listed in a draft's changes without their text. */
const MAX_DIFF_TEXT = 200_000

/** The object a branch draft belongs to. */
export type DraftObject = { kind: 'workflow'; object: Workflow } | { kind: 'app'; object: App }

export function draftKind(draft: GitBranchDraft): ObjectKind {
  return draft.workflowId ? 'workflow' : 'app'
}

/** What the editor gets: the draft, its checks, and where it stands against the branch. */
export async function branchDraftView(draft: GitBranchDraft) {
  const kind = draftKind(draft)
  return {
    id: draft.id,
    kind,
    objectId: (draft.workflowId ?? draft.appId)!,
    branch: draft.branch,
    name: draft.name,
    description: draft.description,
    definition: draft.definition,
    revision: draft.revision,
    baseCommit: draft.baseCommit,
    branchExists: draft.branchExists,
    committedCommit: draft.committedCommit,
    updatedAt: draft.updatedAt,
    draftHash:
      kind === 'workflow'
        ? await definitionHash(draft.definition as WorkflowDefinition)
        : await appDefinitionHash(draft.definition as AppDefinition),
    diagnostics:
      kind === 'workflow'
        ? validateDefinition(draft.definition as WorkflowDefinition).diagnostics
        : validateApp(draft.definition as AppDefinition).diagnostics,
  }
}

function repoObject(
  kind: ObjectKind,
  slug: string,
  value: { name: string; description: string | null; definition: unknown },
): RepoObject {
  return kind === 'workflow'
    ? { kind, slug, value: { ...value, definition: value.definition as WorkflowDefinition } }
    : { kind, slug, value: { ...value, definition: value.definition as AppDefinition } }
}

/** The object's directory at a commit: its files (inside the directory) and, when there are any, what they decode to. */
async function readObjectAt(repo: GitRepo, commit: string, kind: ObjectKind, slug: string) {
  const dir = objectDir(kind, slug)
  const raw = await repo.readFiles(commit, [`${dir}/`])
  const files: Files = Object.fromEntries(
    Object.entries(raw).map(([path, content]) => [path.slice(dir.length + 1), content]),
  )
  if (Object.keys(files).length === 0) return { dir, files, decoded: null }
  const decoded = decodeObject({ kind, slug, files })
  return { dir, files, decoded }
}

function problemsError(problems: Problem[]): TRPCError {
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `The branch's files have problems; fix them in the repo first: ${problems[0]!.message}${more}`,
  })
}

/**
 * The object's draft on a branch: the one already open, or a new one from the branch's files (or, when the branch
 * doesn't exist yet and `create` is set, from the deploy branch's). Where the repo doesn't have the object yet
 * (created protected, or its protect pull request isn't merged), it starts from what's on the instance.
 */
export async function openBranchDraft(
  db: Db,
  config: GitConfig,
  user: User,
  opts: { target: DraftObject; branch: string; create: boolean },
): Promise<GitBranchDraft> {
  const { target, branch } = opts
  const { kind, object } = target
  if (!object.gitProtected) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `This ${kind} isn't protected: edit it here`,
    })
  }
  const { repo, branch: deployBranch } = await requireGitRepo(db, config)
  requireNotDeployBranch(branch, deployBranch)
  const column = kind === 'workflow' ? gitBranchDrafts.workflowId : gitBranchDrafts.appId
  const [existing] = await db
    .select()
    .from(gitBranchDrafts)
    .where(and(eq(column, object.id), eq(gitBranchDrafts.branch, branch)))
  if (existing) return existing

  let base: string
  let branchExists: boolean
  let read: Awaited<ReturnType<typeof readObjectAt>>
  try {
    const tip = await repo.fetchBranch(branch)
    if (!tip && !opts.create) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `The repo has no branch ${branch}` })
    }
    base = tip ?? (await ensureBaseBranch(repo, deployBranch, user))
    branchExists = Boolean(tip)
    read = await readObjectAt(repo, base, kind, object.slug)
  } catch (err) {
    throw gitTrpcError(err)
  }
  let value: { name: string; description: string | null; definition: unknown }
  if (!read.decoded) {
    value = {
      name: object.name,
      description: object.description,
      definition: await liveOrDraft(db, kind, object),
    }
  } else if (!read.decoded.ok) {
    throw problemsError(read.decoded.problems)
  } else {
    value = read.decoded.value.value
  }
  const [created] = await db
    .insert(gitBranchDrafts)
    .values({
      ...(kind === 'workflow' ? { workflowId: object.id } : { appId: object.id }),
      branch,
      definition: value.definition as WorkflowDefinition | AppDefinition,
      name: value.name,
      description: value.description,
      baseCommit: base,
      branchExists,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  // Someone opened it at the same moment: theirs it is.
  const [theirs] = await db
    .select()
    .from(gitBranchDrafts)
    .where(and(eq(column, object.id), eq(gitBranchDrafts.branch, branch)))
  return theirs!
}

/** Saves the draft if nobody saved since `revision`; the definition must match the schema (diagnostics come back). */
export async function saveBranchDraft(
  db: Db,
  user: User,
  opts: {
    draft: GitBranchDraft
    revision: number
    definition: unknown
    name?: string
    description?: string | null
  },
): Promise<GitBranchDraft> {
  const kind = draftKind(opts.draft)
  const parsed = (kind === 'workflow' ? workflowDefinitionSchema : appDefinitionSchema).safeParse(
    opts.definition,
  )
  if (!parsed.success) throw invalidInput(`${kind} definition`, parsed.error.issues)
  const [saved] = await db
    .update(gitBranchDrafts)
    .set({
      definition: parsed.data as WorkflowDefinition | AppDefinition,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      revision: opts.revision + 1,
      updatedBy: user.id,
    })
    .where(and(eq(gitBranchDrafts.id, opts.draft.id), eq(gitBranchDrafts.revision, opts.revision)))
    .returning()
  if (!saved) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Someone else saved this draft since revision ${opts.revision}; reload to get their changes`,
    })
  }
  return saved
}

export interface DraftFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  before: string | null
  after: string | null
}

/**
 * What committing the draft would change on the branch: its files against the branch's tip (or the deploy branch,
 * for a branch not made yet). `behind`: the branch moved since the draft's base; `conflict`: the object's files
 * changed there too, so a commit would be refused until the draft is updated from the branch.
 */
export async function branchDraftChanges(
  db: Db,
  config: GitConfig,
  target: DraftObject,
  draft: GitBranchDraft,
) {
  const { repo } = await requireGitRepo(db, config)
  try {
    const tip = await repo.fetchBranch(draft.branch)
    // A new process's cache (a restart, another replica) may not have the base yet.
    const haveBase = await repo.ensureCommit(draft.baseCommit)
    if (!tip && !haveBase) throw lostBase()
    const against = tip ?? draft.baseCommit
    const { dir, files: now } = encodeObjectDir(repoObject(target.kind, target.object.slug, draft))
    const { files: there } = await readObjectAt(repo, against, target.kind, target.object.slug)
    const paths = [...new Set([...Object.keys(now), ...Object.keys(there)])].sort()
    const clip = (text: string | undefined) =>
      text === undefined ? null : text.length > MAX_DIFF_TEXT ? null : text
    const files: DraftFileChange[] = paths.flatMap((path): DraftFileChange[] => {
      const before = there[path]
      const after = now[path]
      if (before === after) return []
      return [
        {
          path: `${dir}/${path}`,
          status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
          before: clip(before),
          after: clip(after),
        },
      ]
    })
    const behind = tip !== null && tip !== draft.baseCommit
    const conflict =
      behind && haveBase
        ? (await repo.entryAt(tip!, dir)) !== (await repo.entryAt(draft.baseCommit, dir))
        : behind
    return { tip, behind, conflict, files }
  } catch (err) {
    throw gitTrpcError(err)
  }
}

/** The draft's base commit is gone from the repo (its branch was rewritten): only updating and discarding helps. */
const lostBase = () =>
  new TRPCError({
    code: 'CONFLICT',
    message:
      'The commit this draft started from is no longer in the repo (was the branch rewritten?): update it from the branch and discard its changes',
  })

/** Whether the draft holds changes its base commit doesn't have (anything a commit would write). */
async function hasUncommittedChanges(
  repo: GitRepo,
  target: DraftObject,
  draft: GitBranchDraft,
): Promise<boolean> {
  const { files: now } = encodeObjectDir(repoObject(target.kind, target.object.slug, draft))
  const { files: there } = await readObjectAt(repo, draft.baseCommit, target.kind, target.object.slug)
  const paths = new Set([...Object.keys(now), ...Object.keys(there)])
  return [...paths].some((path) => now[path] !== there[path])
}

/**
 * Loads the branch's current files into the draft (after someone else committed there, or to resolve a conflict).
 * Refused while the draft has changes not committed, unless `discardChanges`.
 */
export async function updateBranchDraftFromBranch(
  db: Db,
  config: GitConfig,
  user: User,
  opts: { target: DraftObject; draft: GitBranchDraft; discardChanges: boolean },
): Promise<GitBranchDraft> {
  const { target, draft } = opts
  const { repo } = await requireGitRepo(db, config)
  let tip: string | null
  let read: Awaited<ReturnType<typeof readObjectAt>>
  try {
    tip = await repo.fetchBranch(draft.branch)
    if (!tip)
      throw new TRPCError({ code: 'NOT_FOUND', message: `The repo has no branch ${draft.branch} yet` })
    if (!opts.discardChanges) {
      // Without its base (the branch was rewritten) nobody can tell what's uncommitted: ask, as with changes.
      if (!(await repo.ensureCommit(draft.baseCommit))) throw lostBase()
      if (await hasUncommittedChanges(repo, target, draft)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The draft has changes that aren’t committed: commit them, or update and discard them',
        })
      }
    }
    read = await readObjectAt(repo, tip, target.kind, target.object.slug)
  } catch (err) {
    throw gitTrpcError(err)
  }
  if (read.decoded && !read.decoded.ok) throw problemsError(read.decoded.problems)
  const value = read.decoded?.ok
    ? read.decoded.value.value
    : { name: draft.name, description: draft.description, definition: draft.definition }
  const [updated] = await db
    .update(gitBranchDrafts)
    .set({
      definition: value.definition as WorkflowDefinition | AppDefinition,
      name: value.name,
      description: value.description,
      baseCommit: tip,
      branchExists: true,
      revision: draft.revision + 1,
      updatedBy: user.id,
    })
    .where(and(eq(gitBranchDrafts.id, draft.id), eq(gitBranchDrafts.revision, draft.revision)))
    .returning()
  if (!updated) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The draft was saved while updating it from the branch: reload, then update again',
    })
  }
  return updated
}

/**
 * Commits the draft's files onto its branch (made from the deploy branch on the first commit). `revision` is the
 * revision the person is looking at: a commit never includes changes they haven't seen. The branch having moved is
 * fine unless the object's files changed there (CONFLICT: update from the branch first).
 */
export async function commitBranchDraft(
  db: Db,
  config: GitConfig,
  user: User,
  opts: { target: DraftObject; draft: GitBranchDraft; revision: number; message: string },
): Promise<{ commit: string; changed: boolean; draft: GitBranchDraft }> {
  const { target, draft } = opts
  if (draft.revision !== opts.revision) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `The draft changed since revision ${opts.revision}; reload before committing`,
    })
  }
  const { repo, branch: deployBranch } = await requireGitRepo(db, config)
  // A draft opened before the deploy branch was changed in Settings → Git could be on it now.
  requireNotDeployBranch(draft.branch, deployBranch)
  const { dir, files } = encodeObjectDir(repoObject(target.kind, target.object.slug, draft))
  let result: { commit: string; changed: boolean }
  try {
    const main = await ensureBaseBranch(repo, deployBranch, user)
    // A new process's cache may not have the base yet; gone from the remote too, the branch was rewritten.
    if (!(await repo.ensureCommit(draft.baseCommit))) throw new GitConflictError(draft.branch, [dir])
    result = await commitToBranch(repo, {
      branch: draft.branch,
      base: draft.baseCommit,
      createFrom: main,
      directories: { [dir]: files },
      files: await manifestIfMissing(repo, draft.baseCommit),
      message: opts.message,
      author: { name: user.name, email: user.email },
    })
  } catch (err) {
    throw gitTrpcError(err)
  }
  // The commit is on the branch: it's the draft's base now, even if someone saved meanwhile (their edits are
  // uncommitted changes on top of it). Unless an update from the branch moved the base in the meantime.
  const [updated] = await db
    .update(gitBranchDrafts)
    .set({
      baseCommit: result.commit,
      branchExists: true,
      ...(result.changed ? { committedCommit: result.commit } : {}),
    })
    .where(and(eq(gitBranchDrafts.id, draft.id), eq(gitBranchDrafts.baseCommit, draft.baseCommit)))
    .returning()
  return { ...result, draft: updated ?? draft }
}

/** A branch draft with its object, for someone with Edit on it; NOT_FOUND otherwise. */
export async function loadBranchDraft(
  db: Db,
  id: string,
): Promise<{ draft: GitBranchDraft; target: DraftObject }> {
  const [draft] = await db.select().from(gitBranchDrafts).where(eq(gitBranchDrafts.id, id))
  if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft not found' })
  if (draft.workflowId) {
    const [object] = await db.select().from(workflows).where(eq(workflows.id, draft.workflowId))
    return { draft, target: { kind: 'workflow', object: object! } }
  }
  const [object] = await db.select().from(apps).where(eq(apps.id, draft.appId!))
  return { draft, target: { kind: 'app', object: object! } }
}
