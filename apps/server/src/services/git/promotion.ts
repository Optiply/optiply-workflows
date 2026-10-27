import type { Db } from '@ow/db'
import { KIND_ROOTS, SETTINGS_ROOTS } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import type { Config } from '../../config'
import type { PullRequestView } from './github'
import { gitTrpcError, openPullRequestFor, requireGitRepo } from './protection'

type PromoteConfig = Pick<
  Config,
  'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL' | 'PUBLIC_URL'
>

/** Directories listed in a promotion's description; the rest are counted. */
const LISTED = 50

export type PromotionResult =
  /** The target already has everything this instance deploys. */
  | { status: 'up_to_date' }
  | {
      status: 'opened'
      /** The object directories the deploy branch changed since the two branches parted. */
      directories: string[]
      pullRequest: PullRequestView | null
      pullRequestError: string | null
    }

/**
 * Promote (M22): a pull request from this instance's deploy branch into another branch (another instance's deploy
 * branch, say staging into production), or the one already open. Merging it is the promotion: the other instance
 * deploys what it brings, keeping its own secrets and overrides. Without GitHub (no token) the error comes back as a
 * message, as for any pull request.
 */
export async function openPromotion(
  db: Db,
  config: PromoteConfig,
  opts: { target: string; title?: string; body?: string },
): Promise<PromotionResult> {
  const { repo, branch } = await requireGitRepo(db, config)
  const { target } = opts
  if (target === branch) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${branch} is this instance's deploy branch: promote into another one`,
    })
  }
  let directories: string[]
  try {
    const head = await repo.fetchBranch(branch)
    if (!head) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `The repo has no ${branch} branch yet` })
    }
    const into = await repo.fetchBranch(target)
    if (!into) throw new TRPCError({ code: 'NOT_FOUND', message: `The repo has no branch ${target}` })
    if (await repo.isAncestor(head, into)) return { status: 'up_to_date' }
    const base = await repo.mergeBase(head, into)
    if (!base) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `${branch} and ${target} share no history: merge them on GitHub`,
      })
    }
    const roots = [...Object.values(KIND_ROOTS), ...Object.values(SETTINGS_ROOTS)]
    const [before, after] = await Promise.all([repo.subtrees(base, roots), repo.subtrees(head, roots)])
    directories = [...new Set([...before.keys(), ...after.keys()])]
      .filter((dir) => before.get(dir) !== after.get(dir))
      .sort()
  } catch (err) {
    throw gitTrpcError(err)
  }
  const listed = directories.slice(0, LISTED).map((dir) => `- \`${dir}\``)
  if (directories.length > LISTED) listed.push(`- … and ${directories.length - LISTED} more`)
  const body =
    opts.body ??
    [
      `Promotes what ${config.PUBLIC_URL} deploys from \`${branch}\` into \`${target}\`.`,
      ...(listed.length > 0 ? ['', 'Changes:', ...listed] : []),
    ].join('\n')
  const opened = await openPullRequestFor(db, config, {
    branch,
    base: target,
    title: opts.title ?? `Promote ${branch} into ${target}`,
    body,
  })
  return { status: 'opened', directories, ...opened }
}
