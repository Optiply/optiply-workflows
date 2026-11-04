import type { MergeConflict, MergeObject, Resolution } from '@ow/collab'
import type { Db, GitBranchDraft } from '@ow/db'
import {
  encodeObjectDir,
  type Files,
  KIND_LABELS,
  KIND_ROOTS,
  type ObjectKind,
  objectDir,
} from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import type { Config } from '../../config'
import {
  type BranchDraftUpdate,
  type DraftObject,
  problemsError,
  readObjectAt,
  reloadDraft,
  updateDraftTo,
} from './branch-drafts'
import { GitError } from './cli'
import { mergeKindObject } from './kinds'
import { gitTrpcError, repoObject, requireGitRepo, requireNotDeployBranch } from './protection'
import type { GitRepo } from './repo'

type GitConfig = Pick<
  Config,
  'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL' | 'GITLAB_API_URL'
>
type User = { id: string; name: string; email: string }

/** How often the merge commit is made again when the branch moved before its push. */
const PUSH_ATTEMPTS = 3

/** An object's conflicts in Update from main, for the merge dialog. */
export interface ObjectConflicts {
  /** Its directory: what resolutions are keyed by. */
  dir: string
  kind: ObjectKind
  slug: string
  name: string
  conflicts: MergeConflict[]
}

export type MainUpdate =
  /** Nothing to bring in: the branch has the deploy branch's tip already. */
  | { status: 'up_to_date' }
  /** Objects both sides changed conflict; nothing written. Resolutions go by object directory, then conflict id. */
  | { status: 'conflicts'; main: string; objects: ObjectConflicts[] }
  /**
   * The merge commit (null for a branch not made yet: the draft was merged onto main's tip), then the draft's update;
   * `draftError` when that update failed after the merge commit was pushed (the branch has main; Update from branch
   * brings it into the draft).
   */
  | {
      status: 'merged'
      commit: string | null
      objects: string[]
      draft: BranchDraftUpdate | null
      draftError?: string
    }

/** Resolutions per object directory (`workflows/sync-orders`), each by conflict id. */
export type MainResolutions = Readonly<Record<string, Readonly<Record<string, Resolution>>>>

/**
 * Brings the deploy branch into a draft's branch as one merge commit made by the person (architecture §2.23): the
 * object directories both sides changed since their merge base are merged by `mergeKindObject`, everything else by
 * `git merge-tree`; then the draft is updated from the branch (its uncommitted changes merged as usual). A branch
 * not made yet has nothing to merge: the draft is merged onto main's tip instead. `canEdit` says whether the person
 * may resolve conflicts in an object (Edit on it).
 */
export async function updateBranchDraftFromMain(
  db: Db,
  config: GitConfig,
  user: User,
  opts: {
    target: DraftObject
    draft: GitBranchDraft
    resolutions?: MainResolutions
    canEdit(kind: ObjectKind, slug: string): Promise<boolean>
  },
): Promise<MainUpdate> {
  const { target, draft } = opts
  const { repo, branch: deployBranch } = await requireGitRepo(db, config)
  requireNotDeployBranch(draft.branch, deployBranch)
  const dir = objectDir(target.kind, target.object.slug)
  try {
    for (let attempt = 1; ; attempt++) {
      const main = await repo.fetchBranch(deployBranch)
      if (!main) throw new GitError('not_found', `The repo has no branch ${deployBranch}`)
      const tip = await repo.fetchBranch(draft.branch)

      if (!tip) {
        // The draft's first commit makes the branch: it just moves onto main's tip.
        if (draft.baseCommit === main) return { status: 'up_to_date' }
        const update = await updateDraftTo(db, repo, user, {
          target,
          draft,
          tip: main,
          branchExists: false,
          discardChanges: false,
          resolutions: opts.resolutions?.[dir],
        })
        if (update.status === 'conflicts') {
          return {
            status: 'conflicts',
            main,
            objects: [
              {
                dir,
                kind: target.kind,
                slug: target.object.slug,
                name: draft.name,
                conflicts: update.conflicts,
              },
            ],
          }
        }
        return { status: 'merged', commit: null, objects: [], draft: update }
      }

      if (await repo.isAncestor(main, tip)) return { status: 'up_to_date' }
      const base = await repo.mergeBase(tip, main)
      if (!base) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `${draft.branch} and ${deployBranch} share no history: merge them on GitHub`,
        })
      }

      const both = await changedOnBothSides(repo, base, tip, main)
      const merged: Record<string, Files> = {}
      const conflicted: ObjectConflicts[] = []
      for (const { kind, slug, dir: path } of both) {
        const sides = await Promise.all([base, tip, main].map((c) => readObject(repo, c, kind, slug)))
        const [b, ours, theirs] = sides
        if (!ours || !theirs) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `${path} was deleted on one side and changed on the other: fix it on GitHub`,
          })
        }
        const result = mergeKindObject(
          kind,
          b ?? { name: '', description: null, definition: {} },
          ours,
          theirs,
          opts.resolutions?.[path],
        )
        if (result.conflicts.length > 0) {
          if (!(await opts.canEdit(kind, slug))) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `${path} conflicts with ${deployBranch}, and you can't edit that ${KIND_LABELS[kind]}: ask someone who can`,
            })
          }
          conflicted.push({
            dir: path,
            kind,
            slug,
            name: result.merged.name,
            conflicts: result.conflicts,
          })
          continue
        }
        merged[path] = encodeObjectDir(repoObject(kind, slug, result.merged)).files
      }

      const git = await repo.mergeTree(tip, main)
      const outside = git.conflicts.filter((path) => !both.some((o) => path.startsWith(`${o.dir}/`)))
      if (outside.length > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `${outside.join(', ')} changed on both ${draft.branch} and ${deployBranch}: merge them on GitHub`,
        })
      }
      if (conflicted.length > 0) return { status: 'conflicts', main, objects: conflicted }

      const commit = await repo.commit({
        parent: tip,
        mergeParents: [main],
        tree: git.tree,
        directories: merged,
        message: `Update ${draft.branch} from ${deployBranch}`,
        author: { name: user.name, email: user.email },
      })
      if ((await repo.push(commit!, draft.branch)) === 'ok') {
        const objects = Object.keys(merged)
        try {
          const update = await updateDraftTo(db, repo, user, {
            target,
            draft: await reloadDraft(db, draft),
            tip: commit!,
            branchExists: true,
            discardChanges: false,
          })
          return { status: 'merged', commit: commit!, objects, draft: update }
        } catch (err) {
          // The merge commit is on the branch whatever happens to the draft: say both.
          const message = err instanceof Error ? err.message : String(err)
          return { status: 'merged', commit: commit!, objects, draft: null, draftError: message }
        }
      }
      if (attempt >= PUSH_ATTEMPTS) {
        throw new GitError(
          'failed',
          `${draft.branch} kept moving while updating it from ${deployBranch}; try again`,
        )
      }
    }
  } catch (err) {
    throw err instanceof TRPCError ? err : gitTrpcError(err)
  }
}

/** The object directories that changed between `base` and each of the two tips, differently. */
async function changedOnBothSides(repo: GitRepo, base: string, ours: string, theirs: string) {
  const roots = Object.values(KIND_ROOTS)
  const [b, o, t] = (await Promise.all([base, ours, theirs].map((c) => repo.subtrees(c, roots)))) as [
    Map<string, string>,
    Map<string, string>,
    Map<string, string>,
  ]
  const dirs = new Set([...o.keys(), ...t.keys(), ...b.keys()])
  const kinds = Object.entries(KIND_ROOTS) as [ObjectKind, string][]
  return [...dirs]
    .filter((dir) => o.get(dir) !== b.get(dir) && t.get(dir) !== b.get(dir) && o.get(dir) !== t.get(dir))
    .sort()
    .flatMap((dir) => {
      const kind = kinds.find(([, root]) => dir.startsWith(`${root}/`))?.[0]
      return kind ? [{ kind, slug: dir.slice(KIND_ROOTS[kind].length + 1), dir }] : []
    })
}

/** An object at a commit, null where the commit has no files for it; problems refuse the update. */
async function readObject(
  repo: GitRepo,
  commit: string,
  kind: ObjectKind,
  slug: string,
): Promise<MergeObject<unknown> | null> {
  const { decoded } = await readObjectAt(repo, commit, kind, slug)
  if (!decoded) return null
  if (!decoded.ok) throw problemsError(decoded.problems)
  return decoded.value.value
}
