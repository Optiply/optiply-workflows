import { type Db, gitBranchDrafts } from '@ow/db'
import { type ObjectKind, objectDir } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import type { Config } from '../../config'
import { draftColumn, type GitObjectRow } from './kinds'
import { gitTrpcError, requireGitRepo } from './protection'

type GitConfig = Pick<
  Config,
  'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL' | 'GITLAB_API_URL'
>

/** Branches compared with the deploy branch for one object; more are listed without it. */
const COMPARED = 100

/**
 * The branch picker asks often (each open editor, every 30 s), so this process reads the branches at most every
 * `HEADS_MS` per repo (sooner after a push from here), and keeps each answer by the commits it was worked out from: a commit to the branch or the
 * deploy branch makes a new key, so a kept answer is never stale.
 */
const HEADS_MS = 15_000
const heads = new Map<string, { at: number; heads: Promise<Map<string, string>> }>()
const answers = new Map<string, boolean>()
const MAX_ANSWERS = 20_000

function branchHeads(repo: {
  dir: string
  lastPushAt(): number
  fetchAllBranches(): Promise<Map<string, string>>
}) {
  const cached = heads.get(repo.dir)
  // A push from here (a commit, a new branch) is seen at once.
  if (cached && Date.now() - cached.at < HEADS_MS && cached.at > repo.lastPushAt()) return cached.heads
  const fetched = repo.fetchAllBranches()
  heads.set(repo.dir, { at: Date.now(), heads: fetched })
  // A failed read isn't kept: the next ask tries again.
  fetched.catch(() => heads.delete(repo.dir))
  return fetched
}

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
    const tips = await branchHeads(repo)
    const main = tips.get(deployBranch)
    let mainEntry: Promise<string | null> | undefined
    let compared = 0
    const branches: ObjectBranch[] = []
    for (const [name, commit] of tips) {
      const deploy = name === deployBranch
      let changes = false
      if (!deploy && compared < COMPARED) {
        compared++
        const key = `${repo.dir}\u0000${commit}\u0000${main ?? ''}\u0000${dir}`
        const known = answers.get(key)
        if (known !== undefined) changes = known
        else {
          const base = main ? await repo.mergeBase(commit, main) : null
          mainEntry ??= main ? repo.entryAt(main, dir) : Promise.resolve(null)
          const before = base === main ? await mainEntry : base ? await repo.entryAt(base, dir) : null
          changes = (await repo.entryAt(commit, dir)) !== before
          if (answers.size >= MAX_ANSWERS) answers.clear()
          answers.set(key, changes)
        }
      }
      branches.push({ name, commit, deploy, changes, draft: withDraft.has(name) })
    }
    const rank = (b: ObjectBranch) => (b.deploy ? 0 : b.changes || b.draft ? 1 : 2)
    return branches.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch (err) {
    throw gitTrpcError(err)
  }
}
