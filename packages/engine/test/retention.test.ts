import { type Db, environments, maintenanceJobs, workflowReleases, workflows } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { sql as dsql, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimMaintenanceJob,
  claimRuns,
  deleteOldRuns,
  enqueueRun,
  QUEUE_DELIVERY_DAYS,
  RetentionJob,
} from '../src'
import { connect, wf } from './pg-harness'

let db: Db
let monitorDb: Db
let queueDb: Db
let stopDb: () => Promise<void>
let workflowId: string
let releaseId: string
let environmentId: string

beforeAll(async () => {
  const pg = await startTestDatabase()
  // Three connections pools: retention, the queue traffic, and the lock monitor, so none waits on another's pool.
  const main = connect(pg.url)
  const queue = connect(pg.url)
  const monitor = connect(pg.url)
  db = main.db
  queueDb = queue.db
  monitorDb = monitor.db
  stopDb = async () => {
    await Promise.all([main.close(), queue.close(), monitor.close()])
    await pg.stop()
  }
  const definition = wf([], [])
  const [env] = await db.select().from(environments).where(eq(environments.slug, 'production'))
  environmentId = env!.id
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: 'retention', name: 'Retention', draftDefinition: definition })
    .returning()
  workflowId = workflow!.id
  const [release] = await db
    .insert(workflowReleases)
    .values({ workflowId, version: '1.0.0', definition, definitionHash: 'f'.repeat(64) })
    .returning()
  releaseId = release!.id
}, 60_000)
afterAll(() => stopDb?.())

/** Inserts finished runs (with blocks, payloads and logs) straight into the tables; returns their ids. */
async function finishedRuns(
  n: number,
  opts: { finishedDaysAgo: number; blocks?: number; logs?: number; parent?: string; snapshot?: string },
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(dsql`
    insert into workflow_runs (id, workflow_id, release_id, draft_snapshot_id, environment_id, trigger_type, status,
                               parent_run_id, created_at, started_at, finished_at)
    select gen_random_uuid(), ${workflowId},
           ${opts.snapshot ? null : releaseId}::uuid, ${opts.snapshot ?? null}::uuid, ${environmentId}, 'manual',
           'succeeded', ${opts.parent ?? null}::uuid, now() - make_interval(days => ${opts.finishedDaysAgo}),
           now() - make_interval(days => ${opts.finishedDaysAgo}), now() - make_interval(days => ${opts.finishedDaysAgo})
    from generate_series(1, ${n})
    returning id`)
  const ids = `{${rows.map((r) => r.id).join(',')}}`
  if (opts.blocks) {
    await db.execute(dsql`
      insert into block_runs (id, run_id, block_key, status, attempt, epoch)
      select gen_random_uuid(), r, 'loop1[' || g || ']', 'succeeded', 1, 1
      from unnest(${ids}::uuid[]) r, generate_series(1, ${opts.blocks}) g`)
    await db.execute(dsql`
      insert into block_run_payloads (block_run_id, data, size_bytes)
      select id, '{"value": 42}'::jsonb, 13 from block_runs where run_id = any(${ids}::uuid[])`)
  }
  if (opts.logs) {
    await db.execute(dsql`
      insert into run_logs (run_id, level, message)
      select r, 'info', 'line ' || g from unnest(${ids}::uuid[]) r, generate_series(1, ${opts.logs}) g`)
  }
  return rows.map((r) => r.id)
}

async function count(table: string, where = 'true'): Promise<number> {
  const [row] = await db.execute<{ n: number }>(
    dsql.raw(`select count(*)::int as n from ${table} where ${where}`),
  )
  return row!.n
}

async function exists(runId: string): Promise<boolean> {
  return (await count('workflow_runs', `id = '${runId}'`)) === 1
}

describe('deleteOldRuns', () => {
  it('deletes 100k old block rows in short statements while the queue keeps claiming runs', async () => {
    // 40 runs that finished 40 days ago, each with a 2,500-item loop: 100,000 block rows and payloads.
    const old = await finishedRuns(40, { finishedDaysAgo: 40, blocks: 2_500, logs: 50 })
    // Kept: finished recently; old but still queued; an old parent whose child is still waiting.
    const [recent] = await finishedRuns(1, { finishedDaysAgo: 5, blocks: 10, logs: 5 })
    const [stuck] = await db.execute<{ id: string }>(dsql`
      insert into workflow_runs (id, workflow_id, release_id, environment_id, trigger_type, status, created_at,
                                 available_at)
      values (gen_random_uuid(), ${workflowId}, ${releaseId}, ${environmentId}, 'manual', 'queued',
              now() - interval '60 days', now() + interval '1 year')
      returning id`)
    const [parentOfActive] = await finishedRuns(1, { finishedDaysAgo: 40 })
    const [activeChild] = await db.execute<{ id: string }>(dsql`
      insert into workflow_runs (id, workflow_id, release_id, environment_id, trigger_type, status, parent_run_id,
                                 available_at)
      values (gen_random_uuid(), ${workflowId}, ${releaseId}, ${environmentId}, 'workflow', 'waiting',
              ${parentOfActive}, now() + interval '1 year')
      returning id`)
    // Deleted: an old parent and its old child; an old parent whose recent child stays (and loses the link).
    const [oldParent] = await finishedRuns(1, { finishedDaysAgo: 45 })
    const [oldChild] = await finishedRuns(1, { finishedDaysAgo: 44, parent: oldParent })
    const [parentOfRecent] = await finishedRuns(1, { finishedDaysAgo: 50 })
    const [recentChild] = await finishedRuns(1, { finishedDaysAgo: 2, parent: parentOfRecent })
    // Draft snapshots: an old one nothing uses (deleted), an old one a recent run uses, a new one, and an old one of
    // the current draft revision, which a Run click can pick up at any moment (kept).
    const snapshot = async (revision: number, daysAgo: number) =>
      (
        await db.execute<{ id: string }>(dsql`
          insert into workflow_draft_snapshots (id, workflow_id, revision, definition, created_at)
          values (gen_random_uuid(), ${workflowId}, ${revision}, '{}'::jsonb, now() - make_interval(days => ${daysAgo}))
          returning id`)
      )[0]!.id
    const deadSnapshot = await snapshot(1, 90)
    const usedSnapshot = await snapshot(2, 90)
    const newSnapshot = await snapshot(3, 1)
    const currentSnapshot = await snapshot(4, 90)
    await db.update(workflows).set({ draftRevision: 4 }).where(eq(workflows.id, workflowId))
    await finishedRuns(1, { finishedDaysAgo: 3, snapshot: usedSnapshot })
    expect(await count('block_runs')).toBe(100_010)

    // Queue traffic during retention: queue a run, claim it, finish it, over and over, timing each step.
    let done = false
    const queueLatencies: number[] = []
    const traffic = (async () => {
      while (!done) {
        const t0 = performance.now()
        const run = await enqueueRun(queueDb, { workflowId, releaseId, environmentId, triggerType: 'manual' })
        const claims = await claimRuns(queueDb, 'worker-test', 1, 30_000)
        await queueDb.execute(dsql`
          update workflow_runs set status = 'succeeded', finished_at = now(), lease_owner = null,
                 lease_expires_at = null
          where id = ${claims[0]?.runId ?? run.id}`)
        queueLatencies.push(performance.now() - t0)
      }
    })()
    // Lock monitor: anything waiting for a lock, and the oldest open transaction, every 10 ms.
    let lockWaits = 0
    let oldestTransactionMs = 0
    const monitor = (async () => {
      while (!done) {
        const [row] = await monitorDb.execute<{ waiting: number; oldest_ms: number | null }>(dsql`
          select (select count(*)::int from pg_locks where not granted) as waiting,
                 (select extract(epoch from max(now() - xact_start)) * 1000 from pg_stat_activity
                  where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid()) as oldest_ms`)
        lockWaits += row!.waiting
        oldestTransactionMs = Math.max(oldestTransactionMs, Number(row!.oldest_ms ?? 0))
        await new Promise((r) => setTimeout(r, 10))
      }
    })()

    const statements: { table: string; rows: number; ms: number }[] = []
    let result: Awaited<ReturnType<typeof deleteOldRuns>>
    try {
      result = await deleteOldRuns(db, {
        days: 30,
        batchRuns: 10,
        pauseMs: 5,
        onStatement: (s) => statements.push(s),
      })
    } finally {
      done = true
      await Promise.all([traffic, monitor])
    }

    console.info(
      `retention: ${result.durationMs} ms, ${statements.length} statements, longest ${result.longestStatementMs} ms; ` +
        `queue: ${queueLatencies.length} cycles, max ${Math.round(Math.max(...queueLatencies))} ms; ` +
        `oldest transaction ${Math.round(oldestTransactionMs)} ms`,
    )
    // No statement deleted more than a chunk, none took long (locally ~25 ms each, ~250 ms on a busy CI runner),
    // nothing ever waited for a lock, the queue never stalled, and no transaction stayed open long. (A single
    // cascading DELETE would be one transaction growing with the backlog; the exact counts below catch it, since
    // they only add up when every block row and payload went in the chunked statements.) The time limits leave
    // room for a machine running every package's tests at once, where a statement reached 1.01 s.
    expect(Math.max(...statements.map((s) => s.rows))).toBeLessThanOrEqual(5_000)
    expect(result.longestStatementMs).toBeLessThan(2_000)
    expect(lockWaits).toBe(0)
    expect(oldestTransactionMs).toBeLessThan(2_000)
    expect(queueLatencies.length).toBeGreaterThan(10)
    expect(Math.max(...queueLatencies)).toBeLessThan(2_000)

    // Every block row and payload went in the chunked statements: none was left for a run's cascade.
    expect(result).toMatchObject({
      runs: 40 + 1 + 1 + 1, // the loops, the old parent and child, the parent of a recent child
      blockRuns: 100_000,
      payloads: 100_000,
      logs: 2_000,
      snapshots: 1,
      stopped: false,
    })

    for (const id of old) expect(await exists(id)).toBe(false)
    expect(await count('block_runs')).toBe(10)
    expect(await count('block_run_payloads')).toBe(10)
    expect(await count('run_logs')).toBe(5)
    for (const id of [recent!, stuck!.id, parentOfActive!, activeChild!.id, recentChild!]) {
      expect(await exists(id)).toBe(true)
    }
    for (const id of [oldParent!, oldChild!, parentOfRecent!]) expect(await exists(id)).toBe(false)
    expect(await count('workflow_runs', `id = '${recentChild}' and parent_run_id is null`)).toBe(1)
    expect(await count('workflow_draft_snapshots', `id = '${deadSnapshot}'`)).toBe(0)
    expect(
      await count(
        'workflow_draft_snapshots',
        `id in ('${usedSnapshot}', '${newSnapshot}', '${currentSnapshot}')`,
      ),
    ).toBe(3)
  }, 120_000)

  it('stops between statements when asked, leaving the rest for next time', async () => {
    await finishedRuns(3, { finishedDaysAgo: 40, blocks: 10 })
    const before = await count('workflow_runs')
    const controller = new AbortController()
    controller.abort()
    const result = await deleteOldRuns(db, { days: 30, signal: controller.signal })
    expect(result).toMatchObject({ stopped: true, runs: 0 })
    expect(await count('workflow_runs')).toBe(before)
    expect((await deleteOldRuns(db, { days: 30 })).runs).toBe(3)
  })
})

describe('the daily job', () => {
  it('is claimed by exactly one worker per period', async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimMaintenanceJob(db, 'race', 3_600_000)),
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await claimMaintenanceJob(db, 'race', 3_600_000)).toBe(false)
    // Once the period has passed (here: a period of 0 ms), the next check claims it again.
    expect(await claimMaintenanceJob(db, 'race', 0)).toBe(true)
  })

  it('runs retention when it wins the claim and records what it did', async () => {
    await finishedRuns(2, { finishedDaysAgo: 31, blocks: 3, logs: 1 })
    const job = new RetentionJob({ db, days: 30, pauseMs: 0 })
    const result = await job.check()
    expect(result).toMatchObject({ runs: 2, blockRuns: 6, logs: 2 })
    const [row] = await db.select().from(maintenanceJobs).where(eq(maintenanceJobs.name, 'retention'))
    expect(row).toMatchObject({ lastStartedAt: expect.any(Date), lastFinishedAt: expect.any(Date) })
    expect(row!.lastResult).toMatchObject({ days: 30, runs: 2, blockRuns: 6 })
    // Another worker's check the same day does nothing.
    expect(await new RetentionJob({ db, days: 30 }).check()).toBeUndefined()
  })
})

describe('deleteOldRuns: webhook bookkeeping', () => {
  it('deletes ended rate windows, and rejections past 7 days or the latest 200 per webhook', async () => {
    const trigger = async (name: string) => {
      const [row] = await db.execute<{ id: string }>(dsql`
        insert into workflow_triggers (id, workflow_id, release_id, kind, name)
        values (gen_random_uuid(), ${workflowId}, ${releaseId}, 'schedule', ${name}) returning id`)
      return row!.id
    }
    const busy = await trigger('busy')
    const quiet = await trigger('quiet')
    await db.execute(dsql`
      insert into webhook_rate_windows (trigger_id, window_start, expires_at, count)
      select ${busy}, now() - make_interval(mins => i + 1), now() - make_interval(mins => i), 5
      from generate_series(1, 3) i`)
    await db.execute(dsql`
      insert into webhook_rate_windows (trigger_id, window_start, expires_at, count)
      values (${busy}, now(), now() + interval '1 minute', 1)`)
    const reject = (triggerId: string, n: number, minutesAgo: string) =>
      db.execute(dsql`
        insert into webhook_rejections (id, trigger_id, status, reason, message, created_at)
        select gen_random_uuid(), ${triggerId}, 401, 'signature_mismatch', 'x',
               now() - make_interval(mins => ${minutesAgo}::int + i)
        from generate_series(1, ${n}) i`)
    await reject(busy, 205, '0')
    await reject(busy, 3, String(8 * 24 * 60))
    await reject(quiet, 2, String(8 * 24 * 60))
    await reject(quiet, 4, '0')

    const result = await deleteOldRuns(db, { days: 30, pauseMs: 0 })
    expect(result).toMatchObject({ rateWindows: 3, rejections: 5 + 3 + 2 })
    const count = async (table: string, triggerId: string) =>
      (
        await db.execute<{ n: number }>(dsql`
        select count(*)::int as n from ${dsql.identifier(table)} where trigger_id = ${triggerId}`)
      )[0]!.n
    expect(await count('webhook_rate_windows', busy)).toBe(1)
    expect(await count('webhook_rejections', busy)).toBe(200)
    expect(await count('webhook_rejections', quiet)).toBe(4)
    // The 200 kept are the latest.
    const [oldest] = await db.execute<{ minutes: number }>(dsql`
      select round(extract(epoch from now() - min(created_at)) / 60)::int as minutes
      from webhook_rejections where trigger_id = ${busy}`)
    expect(oldest!.minutes).toBe(200)
  })
})

describe('deleteOldRuns: queue deliveries left by the removed queue triggers (M19)', () => {
  it('deletes finished deliveries past their retention, never one whose run is under way', async () => {
    const [trigger] = await db.execute<{ id: string }>(dsql`
      insert into workflow_triggers (id, workflow_id, release_id, kind, name)
      values (gen_random_uuid(), ${workflowId}, ${releaseId}, 'pubsub', 'orders') returning id`)
    const deliver = (messageId: string, outcome: string | null, daysAgo: number) =>
      db.execute(dsql`
        insert into queue_deliveries (trigger_id, message_id, runs, outcome, updated_at)
        values (${trigger!.id}, ${messageId}, 1, ${outcome}, now() - make_interval(days => ${daysAgo}))`)
    await deliver('old-done', 'succeeded', QUEUE_DELIVERY_DAYS + 1)
    await deliver('old-failed', 'failed', QUEUE_DELIVERY_DAYS + 1)
    await deliver('old-running', null, QUEUE_DELIVERY_DAYS + 1)
    await deliver('recent', 'succeeded', QUEUE_DELIVERY_DAYS - 1)
    // `days` is the runs' horizon: deliveries keep their own.
    const result = await deleteOldRuns(db, { days: 1, pauseMs: 0 })
    expect(result.queueDeliveries).toBe(2)
    const left = await db.execute<{ message_id: string }>(dsql`
      select message_id from queue_deliveries where trigger_id = ${trigger!.id} order by message_id`)
    expect(left.map((r) => r.message_id)).toEqual(['old-running', 'recent'])
  })
})
