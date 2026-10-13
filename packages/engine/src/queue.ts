import { blockRunPayloads, blockRuns, type Db, type WorkflowRun, workflowRuns } from '@ow/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BlockResult, EngineError, FinalBlockStatus } from './types'

/** NOTIFY channels. `RUNS_QUEUED` wakes workers; `RUN_FINISHED` carries the run id (sync webhooks, tests). */
export const RUNS_QUEUED_CHANNEL = 'ow_runs_queued'
export const RUN_FINISHED_CHANNEL = 'ow_run_finished'

/** Block statuses a resumed run treats as committed. */
const CHECKPOINT_STATUSES: FinalBlockStatus[] = ['succeeded', 'errored', 'skipped', 'failed']

export interface Claim {
  runId: string
  /** The fencing token every write of this lease must present. */
  epoch: number
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx

function notify(db: Executor, channel: string, payload = '') {
  return db.execute(sql`select pg_notify(${channel}, ${payload})`)
}

/** Inserts a run as `queued` and wakes the workers when the transaction commits. */
export async function enqueueRun(db: Db, values: typeof workflowRuns.$inferInsert): Promise<WorkflowRun> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(workflowRuns)
      .values({ ...values, status: 'queued' })
      .returning()
    await notify(tx, RUNS_QUEUED_CHANNEL)
    return run!
  })
}

/**
 * Claims up to `limit` runs that are due, oldest first. `SKIP LOCKED` lets workers claim concurrently without
 * blocking each other or claiming the same run; each claim bumps the epoch and starts a lease on the
 * database's clock.
 */
export async function claimRuns(db: Db, workerId: string, limit: number, leaseMs: number): Promise<Claim[]> {
  if (limit <= 0) return []
  const rows = await db.execute<{ id: string; epoch: number }>(sql`
    with next as (
      select id from workflow_runs
      where status in ('queued', 'waiting') and available_at <= now()
      order by available_at, id
      limit ${limit}
      for update skip locked
    )
    update workflow_runs r
    set status = 'running',
        lease_owner = ${workerId},
        lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
        epoch = r.epoch + 1,
        started_at = coalesce(r.started_at, now()),
        updated_at = now()
    from next
    where r.id = next.id
    returning r.id, r.epoch`)
  return rows.map((r) => ({ runId: r.id, epoch: r.epoch }))
}

/** Extends a lease. False means another worker owns the run now: stop working on it. */
export async function renewLease(db: Db, claim: Claim, leaseMs: number): Promise<boolean> {
  const rows = await db.execute(sql`
    update workflow_runs
    set lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    where id = ${claim.runId} and epoch = ${claim.epoch} and status = 'running'
    returning id`)
  return rows.length > 0
}

/** Sets the run timeout the first time a run starts; later leases keep it. Fenced. */
export async function ensureDeadline(db: Db, claim: Claim, timeoutMs: number): Promise<Date | null> {
  const rows = await db.execute<{ deadline_at: string }>(sql`
    update workflow_runs
    set deadline_at = coalesce(deadline_at, now() + make_interval(secs => ${timeoutMs / 1000}))
    where id = ${claim.runId} and epoch = ${claim.epoch} and status = 'running'
    returning deadline_at`)
  return rows[0] ? new Date(rows[0].deadline_at) : null
}

/** Records the final status. False if the lease was lost first (the new owner finishes the run). */
export async function finishRun(
  db: Db,
  claim: Claim,
  outcome: { status: 'succeeded' | 'failed'; error: (EngineError & { block?: string }) | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      update workflow_runs
      set status = ${outcome.status},
          error = ${outcome.error ? JSON.stringify(outcome.error) : null}::jsonb,
          finished_at = now(),
          lease_owner = null,
          lease_expires_at = null,
          updated_at = now()
      where id = ${claim.runId} and epoch = ${claim.epoch} and status = 'running'
      returning id`)
    if (!rows.length) return false
    await notify(tx, RUN_FINISHED_CHANNEL, claim.runId)
    return true
  })
}

/**
 * Hands a run back to the queue without counting a recovery (graceful shutdown). The epoch moves on, so this
 * lease can't write any more.
 */
export async function releaseRun(db: Db, claim: Claim): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      update workflow_runs
      set status = 'queued', lease_owner = null, lease_expires_at = null, epoch = epoch + 1,
          available_at = now(), updated_at = now()
      where id = ${claim.runId} and epoch = ${claim.epoch} and status = 'running'
      returning id`)
    if (!rows.length) return false
    await notify(tx, RUNS_QUEUED_CHANNEL)
    return true
  })
}

/**
 * Recovers runs whose lease expired (their worker died or hung): back to the queue, or `failed` once a run has
 * been recovered `maxRecoveries` times. The epoch moves on so the old worker is fenced off, and blocks it left
 * running are marked `interrupted`.
 */
export async function reapExpiredLeases(
  db: Db,
  maxRecoveries: number,
  batch = 100,
): Promise<{ requeued: string[]; failed: string[] }> {
  const error = JSON.stringify({
    code: 'worker_lost',
    message: `The worker running this run stopped responding ${maxRecoveries + 1} times`,
  })
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; status: string }>(sql`
      with expired as (
        select id from workflow_runs
        where status = 'running' and lease_expires_at < now()
        order by lease_expires_at
        limit ${batch}
        for update skip locked
      )
      update workflow_runs r
      set epoch = r.epoch + 1,
          lease_owner = null,
          lease_expires_at = null,
          available_at = now(),
          updated_at = now(),
          status = case when r.recoveries >= ${maxRecoveries} then 'failed' else 'queued' end,
          recoveries = case when r.recoveries >= ${maxRecoveries} then r.recoveries else r.recoveries + 1 end,
          finished_at = case when r.recoveries >= ${maxRecoveries} then now() end,
          error = case when r.recoveries >= ${maxRecoveries} then ${error}::jsonb else r.error end
      from expired
      where r.id = expired.id
      returning r.id, r.status`)
    const requeued = rows.filter((r) => r.status === 'queued').map((r) => r.id)
    const failed = rows.filter((r) => r.status === 'failed').map((r) => r.id)
    if (rows.length) {
      await tx
        .update(blockRuns)
        .set({ status: 'interrupted' })
        .where(
          and(
            inArray(
              blockRuns.runId,
              rows.map((r) => r.id),
            ),
            eq(blockRuns.status, 'running'),
          ),
        )
    }
    if (requeued.length) await notify(tx, RUNS_QUEUED_CHANNEL)
    for (const id of failed) await notify(tx, RUN_FINISHED_CHANNEL, id)
    return { requeued, failed }
  })
}

/** Results committed by earlier leases, for `executeRun`'s `checkpoints`. */
export async function loadCheckpoints(db: Db, runId: string): Promise<BlockResult[]> {
  const rows = await db
    .select({ block: blockRuns, payload: blockRunPayloads })
    .from(blockRuns)
    .leftJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
    .where(and(eq(blockRuns.runId, runId), inArray(blockRuns.status, CHECKPOINT_STATUSES)))
  return rows.map(({ block, payload }) => ({
    key: block.blockKey,
    status: block.status as FinalBlockStatus,
    data: payload?.data ?? null,
    sizeBytes: payload?.sizeBytes ?? 0,
    error: (block.error as EngineError | null) ?? null,
    metadata: block.metadata ?? {},
    port: block.port,
    attempt: block.attempt,
    startedAt: block.startedAt,
    finishedAt: block.finishedAt ?? new Date(),
  }))
}
