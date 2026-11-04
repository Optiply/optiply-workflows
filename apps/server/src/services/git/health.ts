import {
  type Db,
  environments,
  type GitHealthProblem,
  type GitProblem,
  gitDeploys,
  gitObjects,
  gitSettings,
  workflows,
} from '@ow/db'
import { canonicalJson } from '@ow/definition'
import { enqueueRun } from '@ow/engine'
import { desc, eq } from 'drizzle-orm'
import { recordAudit } from '../../audit'
import type { Config } from '../../config'

/**
 * How Git sync is doing (M22): the problems keeping objects from deploying, for the admin banner (`git.health`),
 * and the notify workflow run when they change.
 */

interface HealthLogger {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/**
 * What keeps the deploy branch from deploying in full: each directory's problems, then the repo's own from the last
 * deploy (`ow.json`, a directory that isn't an object).
 */
export async function currentProblems(db: Db): Promise<GitHealthProblem[]> {
  const rows = await db
    .select()
    .from(gitObjects)
    .where(eq(gitObjects.status, 'problem'))
    .orderBy(gitObjects.kind, gitObjects.slug)
  const problems: GitHealthProblem[] = rows.flatMap((row) =>
    row.problems.map((p) => ({ kind: row.kind, slug: row.slug, path: p.path, message: p.message })),
  )
  const [last] = await db
    .select({ summary: gitDeploys.summary })
    .from(gitDeploys)
    .orderBy(desc(gitDeploys.startedAt))
    .limit(1)
  const repo = (last?.summary.problems ?? []) as GitProblem[]
  problems.push(...repo.map((p) => ({ kind: null, slug: null, path: p.path, message: p.message })))
  return problems
}

/**
 * For admins: the last deploy, why the branch couldn't be read (if it couldn't), and the problems. `key` changes
 * when the problems do, so a dismissed banner comes back for new ones.
 */
export async function gitHealth(db: Db) {
  const [settings] = await db
    .select({ lastError: gitSettings.lastError, checkedAt: gitSettings.checkedAt })
    .from(gitSettings)
  if (!settings) return { configured: false as const }
  const [last] = await db
    .select({
      id: gitDeploys.id,
      commit: gitDeploys.commit,
      status: gitDeploys.status,
      trigger: gitDeploys.trigger,
      finishedAt: gitDeploys.finishedAt,
    })
    .from(gitDeploys)
    .orderBy(desc(gitDeploys.startedAt))
    .limit(1)
  const problems = await currentProblems(db)
  return {
    configured: true as const,
    lastDeploy: last ?? null,
    checkedAt: settings.checkedAt,
    lastError: settings.lastError,
    problems,
    key: problemsKey(problems),
  }
}

/** A short key for a set of problems; empty when there are none. */
function problemsKey(problems: GitHealthProblem[]): string {
  if (problems.length === 0) return ''
  let hash = 0
  for (const char of canonicalJson(problems)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
  return (hash >>> 0).toString(36)
}

/**
 * After a deploy: when its problems differ from those last notified about, the notify workflow's live release runs
 * once in the default environment, with `{ deploy: { id, commit, url }, problems }` (no person: `created_by` null);
 * recovering runs it once more with no problems. Recorded first, so a failing notify workflow is never run again for
 * the same problems. Never throws: a missing workflow or release is logged.
 */
export async function notifyIfChanged(
  db: Db,
  config: Pick<Config, 'PUBLIC_URL'>,
  deploy: { id: string; commit: string },
  log?: HealthLogger,
): Promise<void> {
  try {
    const [settings] = await db.select().from(gitSettings)
    if (!settings) return
    const problems = await currentProblems(db)
    if (canonicalJson(problems) === canonicalJson(settings.notifiedProblems ?? [])) return
    await db.update(gitSettings).set({ notifiedProblems: problems })
    if (!settings.notifyWorkflowId) return
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, settings.notifyWorkflowId))
    if (!workflow?.liveReleaseId) {
      log?.error({ workflowId: settings.notifyWorkflowId }, 'git notify: the workflow has no live release')
      return
    }
    const [env] = await db
      .select({ id: environments.id })
      .from(environments)
      .orderBy(desc(environments.isDefault), environments.createdAt)
      .limit(1)
    if (!env) return
    const run = await enqueueRun(db, {
      workflowId: workflow.id,
      releaseId: workflow.liveReleaseId,
      environmentId: env.id,
      triggerType: 'git',
      input: {
        data: {
          deploy: { id: deploy.id, commit: deploy.commit, url: `${config.PUBLIC_URL}/settings/git` },
          problems,
        },
      },
      createdBy: null,
    })
    await recordAudit(db, {
      actorUserId: null,
      action: 'git.notified',
      objectType: 'workflow',
      objectId: workflow.id,
      metadata: { runId: run.id, deployId: deploy.id, problems: problems.length },
    })
    log?.info({ runId: run.id, problems: problems.length }, 'git notify: workflow run started')
  } catch (err) {
    log?.error({ err }, 'git notify failed')
  }
}
