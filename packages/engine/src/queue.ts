import { blockRunPayloads, blockRuns, type Db, type WorkflowRun, workflowRuns, workflows } from '@ow/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BlockResult, EngineError, FinalBlockStatus } from './types'

/**
 * NOTIFY channels. `RUNS_QUEUED` wakes workers (a run was queued or a slot freed up); `RUN_FINISHED` carries the run id (sync webhooks, tests);
 * `RUN_EVENTS` carries a JSON `RunEvent` for every run and block status change (live status in the editor).
 */
export const RUNS_QUEUED_CHANNEL = 'ow_runs_queued'
export const RUN_FINISHED_CHANNEL = 'ow_run_finished'
export const RUN_EVENTS_CHANNEL = 'ow_run_events'

/**
 * A change, as published on `RUN_EVENTS_CHANNEL` when it commits: a run or block status, or `response` once the
 * run's reply is recorded (what a sync webhook waits for).
 */
export type RunEvent =
  | { runId: string; type: 'run'; status: string }
  | { runId: string; type: 'block'; key: string; status: string; attempt: number; port: string | null }
  | { runId: string; type: 'response' }

/** Publishes an event when the surrounding transaction commits. */
export function notifyRunEvent(db: Executor, event: RunEvent) {
  return notify(db, RUN_EVENTS_CHANNEL, JSON.stringify(event))
}

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

/**
 * Inserts a run as `queued` and wakes the workers when the transaction commits. `seed` pre-commits block results
 * (the editor's "Run block" reuses another run's upstream results), so the run treats them as checkpoints.
 */
export async function enqueueRun(
  db: Db,
  values: typeof workflowRuns.$inferInsert,
  opts: { seed?: readonly BlockResult[] } = {},
): Promise<WorkflowRun> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(workflowRuns)
      .values({ ...values, status: 'queued' })
      .returning()
    for (const result of opts.seed ?? []) {
      const [row] = await tx
        .insert(blockRuns)
        .values({
          runId: run!.id,
          blockKey: result.key,
          status: result.status,
          attempt: result.attempt,
          epoch: 0,
          port: result.port,
          error: result.error as Record<string, unknown> | null,
          metadata: result.metadata,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
        })
        .returning({ id: blockRuns.id })
      if (result.status === 'succeeded') {
        await tx
          .insert(blockRunPayloads)
          .values({ blockRunId: row!.id, data: result.data, sizeBytes: result.sizeBytes })
      }
    }
    await notify(tx, RUNS_QUEUED_CHANNEL)
    return run!
  })
}

/**
 * Claims up to `limit` runs that are due, oldest first. `SKIP LOCKED` lets workers claim concurrently without
 * blocking each other or claiming the same run; each claim bumps the epoch and starts a lease on the database's
 * clock.
 *
 * Two gates hold runs back without blocking the runs behind them:
 * - a workflow's `max_concurrent_runs` (every run of the workflow counts, editor runs included);
 * - a schedule with overlap `queue` runs one run at a time, in order.
 * Gated candidates are re-checked under transaction-scoped advisory locks (one per workflow or trigger, taken in
 * sorted order so workers can't deadlock), so two workers can't both take the last slot. A run held back stays
 * queued; a finishing run wakes the workers (`finishRun`) so it's picked up promptly.
 */
export async function claimRuns(db: Db, workerId: string, limit: number, leaseMs: number): Promise<Claim[]> {
  if (limit <= 0) return []
  return db.transaction(async (tx) => {
    // The gate conditions here are a cheap pre-filter (so a full workflow doesn't crowd out other runs); they're
    // authoritative only once re-checked under the locks below.
    const candidates = await tx.execute<Candidate>(sql`
      select r.id, r.workflow_id, r.trigger_id, w.max_concurrent_runs,
             coalesce(t.config->>'overlap' = 'queue', false) as serial
      from workflow_runs r
      join workflows w on w.id = r.workflow_id
      left join workflow_triggers t on t.id = r.trigger_id
      where r.status in ('queued', 'waiting') and r.available_at <= now()
        and (w.max_concurrent_runs is null or w.max_concurrent_runs > (
          select count(*) from workflow_runs x where x.workflow_id = r.workflow_id and x.status = 'running'))
        and (t.config->>'overlap' is distinct from 'queue' or not exists (
          select 1 from workflow_runs x where x.trigger_id = r.trigger_id and x.status = 'running'))
      order by r.available_at, r.id
      limit ${Math.min(limit * 3, 100)}
      for update of r skip locked`)

    const gateKeys = [
      ...new Set(
        candidates.flatMap((c) => [
          ...(c.max_concurrent_runs !== null ? [`workflow:${c.workflow_id}`] : []),
          ...(c.serial ? [`trigger:${c.trigger_id}`] : []),
        ]),
      ),
    ].sort()
    for (const key of gateKeys) await lockGate(tx, key)

    const claims: Claim[] = []
    for (const c of candidates) {
      if (claims.length >= limit) break
      if (c.max_concurrent_runs !== null || c.serial) {
        const [gate] = await tx.execute<{ busy: boolean }>(sql`
          select (${c.max_concurrent_runs}::int is not null and (
                    select count(*) from workflow_runs
                    where workflow_id = ${c.workflow_id} and status = 'running') >= ${c.max_concurrent_runs}::int)
              or (${c.serial} and exists (
                    select 1 from workflow_runs where trigger_id = ${c.trigger_id} and status = 'running')) as busy`)
        if (gate!.busy) continue
      }
      const [claimed] = await tx.execute<{ id: string; epoch: number }>(sql`
        update workflow_runs
        set status = 'running',
            lease_owner = ${workerId},
            lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
            epoch = epoch + 1,
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = ${c.id}
        returning id, epoch`)
      await notifyRunEvent(tx, { runId: claimed!.id, type: 'run', status: 'running' })
      claims.push({ runId: claimed!.id, epoch: claimed!.epoch })
    }
    return claims
  })
}

interface Candidate extends Record<string, unknown> {
  id: string
  workflow_id: string
  trigger_id: string | null
  max_concurrent_runs: number | null
  serial: boolean
}

/** Takes a concurrency gate's lock (`workflow:<id>` or `trigger:<id>`) until the transaction ends. */
function lockGate(tx: Executor, key: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ow-run-gate:${key}`}, 0))`)
}

export interface StartedRun {
  run: WorkflowRun
  /** Set when the run was claimed for the caller, who must now execute it. */
  claim: Claim | null
  /** The `idempotencyKey` was used before: `run` is that earlier run, and nothing was inserted. */
  replayed: boolean
}

/**
 * Inserts a run. With `claimAs`, the run is claimed for the caller in the same transaction (a sync webhook executes
 * it in the API process), unless its workflow is at `max_concurrent_runs`: then it's queued for the workers like any
 * other run. A run with an `idempotencyKey` the workflow already saw isn't inserted; the earlier run comes back
 * with `replayed`.
 */
export async function startRun(
  db: Db,
  values: typeof workflowRuns.$inferInsert,
  opts: { claimAs?: { workerId: string; leaseMs: number } } = {},
): Promise<StartedRun> {
  return db.transaction(async (tx) => {
    let claim = opts.claimAs
    if (claim) {
      const [workflow] = await tx
        .select({ limit: workflows.maxConcurrentRuns })
        .from(workflows)
        .where(eq(workflows.id, values.workflowId))
      if (workflow?.limit != null) {
        await lockGate(tx, `workflow:${values.workflowId}`)
        const [running] = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from workflow_runs
          where workflow_id = ${values.workflowId} and status = 'running'`)
        if (running!.n >= workflow.limit) claim = undefined
      }
    }
    const [run] = await tx
      .insert(workflowRuns)
      .values({
        ...values,
        ...(claim
          ? {
              status: 'running',
              leaseOwner: claim.workerId,
              leaseExpiresAt: sql`now() + make_interval(secs => ${claim.leaseMs / 1000})`,
              epoch: 1,
              startedAt: sql`now()`,
            }
          : { status: 'queued' }),
      })
      .onConflictDoNothing({
        target: [workflowRuns.workflowId, workflowRuns.idempotencyKey],
        where: sql`${workflowRuns.idempotencyKey} is not null`,
      })
      .returning()
    if (!run) {
      const [earlier] = await tx
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workflowId, values.workflowId),
            eq(workflowRuns.idempotencyKey, values.idempotencyKey!),
          ),
        )
      return { run: earlier!, claim: null, replayed: true }
    }
    if (claim) await notifyRunEvent(tx, { runId: run.id, type: 'run', status: 'running' })
    else await notify(tx, RUNS_QUEUED_CHANNEL)
    return { run, claim: claim ? { runId: run.id, epoch: run.epoch } : null, replayed: false }
  })
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
    await notifyRunEvent(tx, { runId: claim.runId, type: 'run', status: outcome.status })
    // A slot freed up: runs held back by a concurrency gate can go now.
    await notify(tx, RUNS_QUEUED_CHANNEL)
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
    await notifyRunEvent(tx, { runId: claim.runId, type: 'run', status: 'queued' })
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
    // Requeued runs, and slots freed by failed ones.
    if (rows.length) await notify(tx, RUNS_QUEUED_CHANNEL)
    for (const id of failed) await notify(tx, RUN_FINISHED_CHANNEL, id)
    for (const row of rows) await notifyRunEvent(tx, { runId: row.id, type: 'run', status: row.status })
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
