import { type Db, gitBranchDrafts } from '@ow/db'
import { type ObjectKind, objectDir } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import type { Config } from '../../config'
import { draftColumn, type GitObjectRow } from './kinds'
import { gitTrpcError, requireGitRepo } from './protection'

type GitConfig = Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS'>

/** Branches compared with the deploy branch for one object; more are listed without it. */
const COMPARED = 100

export interface ObjectBranch {
  name: string
  commit: string
  deploy: boolean
  /** The branch changed the object's directory since it left the deploy branch. */
  changes: boolean
  /** Someone has the object's draft open on it here. */
  draft: boolean
}

/**
 * The repo's branches for one object's branch picker (M22): the deploy branch first, then the branches that change
 * the object or hold a draft of it here, then the rest, each by name. "Changes" means the branch's directory differs
 * from the one at its merge base with the deploy branch, so a branch merely behind it doesn't count.
 */
export async function objectBranches(
  db: Db,
  config: GitConfig,
  target: { kind: ObjectKind; object: GitObjectRow },
): Promise<ObjectBranch[]> {
  const { repo, branch: deployBranch } = await requireGitRepo(db, config)
  const drafts = await db
    .select({ branch: gitBranchDrafts.branch })
    .from(gitBranchDrafts)
    .where(eq(draftColumn(target.kind), target.object.id))
  const withDraft = new Set(drafts.map((d) => d.branch))
  const dir = objectDir(target.kind, target.object.slug)
  try {
    const heads = await repo.fetchAllBranches()
    const main = heads.get(deployBranch)
    const mainEntry = main ? await repo.entryAt(main, dir) : null
    let compared = 0
    const branches: ObjectBranch[] = []
    for (const [name, commit] of heads) {
      const deploy = name === deployBranch
      let changes = false
      if (!deploy && compared < COMPARED) {
        compared++
        const base = main ? await repo.mergeBase(commit, main) : null
        const before = base === main ? mainEntry : base ? await repo.entryAt(base, dir) : null
        changes = (await repo.entryAt(commit, dir)) !== before
      }
      branches.push({ name, commit, deploy, changes, draft: withDraft.has(name) })
    }
    const rank = (b: ObjectBranch) => (b.deploy ? 0 : b.changes || b.draft ? 1 : 2)
    return branches.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch (err) {
    throw gitTrpcError(err)
  }
}
