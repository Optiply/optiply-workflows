import type { Files } from '@ow/git-format'
import { GitError } from './cli'
import type { GitAuthor, GitRepo } from './repo'

/** Someone else changed the same files on the branch since the commit a change started from. */
export class GitConflictError extends Error {
  constructor(
    readonly branch: string,
    /** The directories and files that changed there. */
    readonly paths: string[],
  ) {
    super(
      `${paths.join(', ')} changed on ${branch} since you started: update your draft from the branch first (it merges their changes with yours)`,
    )
    this.name = 'GitConflictError'
  }
}

/**
 * Writes directories (and single files) onto a branch as one commit and pushes it. `base` is the commit the change
 * started from: when the branch has moved on since, the commit goes on top of the new tip as long as none of the
 * same paths changed there, and is refused otherwise. A push that loses a race with another one fetches and tries
 * again. A branch that doesn't exist yet is made from `createFrom`.
 */
export async function commitToBranch(
  repo: GitRepo,
  opts: {
    branch: string
    base: string | null
    createFrom?: string
    directories?: Record<string, Files | null>
    files?: Files
    message: string
    author: GitAuthor
    attempts?: number
  },
): Promise<{ commit: string; changed: boolean }> {
  const paths = [...Object.keys(opts.directories ?? {}), ...Object.keys(opts.files ?? {})]
  const attempts = opts.attempts ?? 3
  for (let attempt = 0; attempt < attempts; attempt++) {
    const tip = await repo.fetchBranch(opts.branch)
    const parent = tip ?? opts.createFrom ?? null
    if (!parent) throw new GitError('not_found', `There's no branch ${opts.branch}`)
    if (opts.base && opts.base !== parent) {
      if (!(await repo.ensureCommit(opts.base))) throw new GitConflictError(opts.branch, paths)
      const changed: string[] = []
      for (const path of paths) {
        if ((await repo.entryAt(parent, path)) !== (await repo.entryAt(opts.base, path))) changed.push(path)
      }
      if (changed.length > 0) throw new GitConflictError(opts.branch, changed)
    }
    const commit = await repo.commit({
      parent,
      directories: opts.directories,
      files: opts.files,
      message: opts.message,
      author: opts.author,
    })
    if (commit === null) {
      // Nothing to change; a new branch is still made, so the change has somewhere to go.
      if (tip === null && (await repo.push(parent, opts.branch)) === 'rejected') continue
      return { commit: parent, changed: false }
    }
    if ((await repo.push(commit, opts.branch)) === 'ok') return { commit, changed: true }
  }
  throw new GitError('failed', `${opts.branch} kept moving while committing; try again`)
}
