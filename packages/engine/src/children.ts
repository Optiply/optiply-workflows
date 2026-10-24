import { type Db, workflowRuns, workflows } from '@ow/db'
import { eq, sql } from 'drizzle-orm'
import { BlockFailure } from './errors'
import { cancelRun, startRun } from './queue'
import { sleep } from './retry'
import type { ChildRunState, ChildRuns, EngineError, RunResponse } from './types'

const FINAL = new Set(['succeeded', 'failed', 'cancelled'])
/** How deep workflows may call workflows. Stops a workflow that (indirectly) calls itself from recursing forever. */
export const MAX_CHILD_DEPTH = 10

/**
 * Child runs in Postgres. A child runs its workflow's live release in the parent's environment, is linked by
 * `parent_run_id`, and is started at most once per key (the workflow's idempotency key), so a block that runs
 * again finds the child it started. A child ending wakes a parent paused waiting for it (see `finishRun`).
 */
export class PgChildRuns implements ChildRuns {
  constructor(private readonly db: Db) {}

  async start(request: {
    workflow: string
    input: unknown
    key: string
    parentRunId: string
    environmentId: string
  }): Promise<string> {
    const [workflow] = await this.db
      .select({ id: workflows.id, liveReleaseId: workflows.liveReleaseId })
      .from(workflows)
      .where(eq(workflows.slug, request.workflow))
    if (!workflow) {
      throw new BlockFailure('unknown_workflow', `No workflow has the slug "${request.workflow}"`)
    }
    if (!workflow.liveReleaseId) {
      throw new BlockFailure('not_published', `Workflow "${request.workflow}" isn't published`)
    }
    // The parent's depth: how many runs up its chain of parents.
    const [chain] = await this.db.execute<{ depth: number }>(sql`
      with recursive up(id, parent, depth) as (
        select id, parent_run_id, 1 from workflow_runs where id = ${request.parentRunId}
        union all
        select r.id, r.parent_run_id, up.depth + 1 from workflow_runs r join up on r.id = up.parent
        where up.depth <= ${MAX_CHILD_DEPTH}
      )
      select max(depth)::int as depth from up`)
    if ((chain?.depth ?? 1) >= MAX_CHILD_DEPTH) {
      throw new BlockFailure(
        'too_deep',
        `Workflows can call workflows at most ${MAX_CHILD_DEPTH} levels deep; does "${request.workflow}" call itself?`,
      )
    }
    // A child run has the same person behind it as its parent (M21: library queries' `current_user`).
    const [parent] = await this.db
      .select({ createdBy: workflowRuns.createdBy })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, request.parentRunId))
    const { run } = await startRun(this.db, {
      workflowId: workflow.id,
      releaseId: workflow.liveReleaseId,
      environmentId: request.environmentId,
      triggerType: 'workflow',
      parentRunId: request.parentRunId,
      idempotencyKey: request.key,
      input: { data: request.input ?? null },
      createdBy: parent?.createdBy ?? null,
    })
    return run.id
  }

  async get(runId: string): Promise<ChildRunState | null> {
    const [run] = await this.db
      .select({
        status: workflowRuns.status,
        response: workflowRuns.response,
        error: workflowRuns.error,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
    if (!run) return null
    return {
      runId,
      status: run.status,
      response: run.response as RunResponse | null,
      error: run.error as (EngineError & { block?: string }) | null,
    }
  }

  async cancel(runId: string): Promise<void> {
    await cancelRun(this.db, runId)
  }
}

/**
 * Waits for a child run to end, looking every 50 ms at first and up to every second; resolves to its final state,
 * or null when `ms` passes first. Rejects when `signal` aborts.
 */
export async function waitForChild(
  children: ChildRuns,
  runId: string,
  ms: number,
  signal: AbortSignal,
): Promise<ChildRunState | null> {
  const deadline = Date.now() + ms
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    const state = await children.get(runId)
    if (!state) throw new BlockFailure('child_missing', `The child run ${runId} no longer exists`)
    if (FINAL.has(state.status)) return state
    const left = deadline - Date.now()
    if (left <= 0) return null
    await sleep(Math.min(delay, left), signal)
  }
}

/** What a finished child gives its parent: its Response block's body. Failed or cancelled children fail the block. */
export function childResult(
  workflow: string,
  state: ChildRunState,
): { data: unknown; metadata: Record<string, unknown> } {
  const metadata = { runId: state.runId, workflow, status: state.status }
  if (state.status === 'succeeded') {
    return {
      data: state.response?.body ?? null,
      metadata: { ...metadata, ...(state.response && { responseStatus: state.response.status }) },
    }
  }
  if (state.status === 'cancelled') {
    throw new BlockFailure('child_cancelled', `Workflow "${workflow}" was cancelled`, { runId: state.runId })
  }
  throw new BlockFailure(
    'child_failed',
    `Workflow "${workflow}" failed: ${state.error?.message ?? 'unknown error'}`,
    { runId: state.runId, ...(state.error && { error: state.error }) },
  )
}
