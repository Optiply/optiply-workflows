import { type Db, maintenanceJobs } from '@ow/db'
import { sql } from 'drizzle-orm'
import { sleep } from './retry'

export interface RetentionOptions {
  /** Runs that finished longer ago than this many days are deleted. */
  days: number
  /** Runs handled per batch. Default 100. */
  batchRuns?: number
  /** Most rows one statement deletes from a run's child tables. Default 5,000. */
  chunkRows?: number
  /** Pause between statements, so the queue and the API always get a turn. Default 20 ms. */
  pauseMs?: number
  /** Stops between statements (worker shutdown); the next run carries on. */
  signal?: AbortSignal
  /** After every statement: which table, how many rows, how long it took. */
  onStatement?: (s: { table: string; rows: number; ms: number }) => void
  /** "Now", for tests. */
  now?: Date
}

export interface RetentionResult {
  runs: number
  blockRuns: number
  payloads: number
  logs: number
  snapshots: number
  /** The longest single statement, in ms: each one is its own short transaction. */
  longestStatementMs: number
  durationMs: number
  /** Stopped by the signal before finishing. */
  stopped: boolean
}

/**
 * Deletes runs that finished more than `days` ago, with their blocks, payloads and logs, and the draft snapshots
 * nothing refers to any more.
 *
 * `workflow_runs` is also the queue, so nothing here holds a lock for long: every statement is its own transaction
 * and deletes at most `chunkRows` rows (a run's loop can have 100k block rows, so a run's children go in chunks,
 * payloads first, then blocks and logs; the run row goes last, when nothing cascades any more). Only finished runs
 * are touched; claims and leases only lock queued, waiting and running ones. A run with an unfinished child is kept,
 * because deleting it would update that child's `parent_run_id` while a worker may hold it.
 */
export async function deleteOldRuns(db: Db, opts: RetentionOptions): Promise<RetentionResult> {
  const started = performance.now()
  // An ISO string: postgres.js doesn't serialise Date parameters in raw SQL.
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.days * 86_400_000).toISOString()
  const batchRuns = opts.batchRuns ?? 100
  const chunk = opts.chunkRows ?? 5_000
  const pauseMs = opts.pauseMs ?? 20
  const result: RetentionResult = {
    runs: 0,
    blockRuns: 0,
    payloads: 0,
    logs: 0,
    snapshots: 0,
    longestStatementMs: 0,
    durationMs: 0,
    stopped: false,
  }

  const run = async (table: string, statement: ReturnType<typeof sql>): Promise<number> => {
    const t0 = performance.now()
    const rows = (await db.execute(statement)).length
    const ms = performance.now() - t0
    result.longestStatementMs = Math.max(result.longestStatementMs, ms)
    opts.onStatement?.({ table, rows, ms })
    if (pauseMs) await sleep(pauseMs, opts.signal ?? new AbortController().signal).catch(() => {})
    return rows
  }
  /** Deletes in chunks until a statement deletes nothing (or the signal stops it). */
  const drain = async (table: string, statement: () => ReturnType<typeof sql>): Promise<number> => {
    let total = 0
    for (;;) {
      if (opts.signal?.aborted) return total
      const n = await run(table, statement())
      total += n
      if (n < chunk) return total
    }
  }

  for (;;) {
    if (opts.signal?.aborted) {
      result.stopped = true
      break
    }
    const batch = await db.execute<{ id: string }>(sql`
      select r.id from workflow_runs r
      where r.finished_at < ${cutoff}::timestamptz
        and not exists (select 1 from workflow_runs c where c.parent_run_id = r.id and c.finished_at is null)
      order by r.finished_at
      limit ${batchRuns}`)
    if (!batch.length) break
    // Our own uuids, as one array parameter.
    const ids = `{${batch.map((r) => r.id).join(',')}}`

    result.payloads += await drain(
      'block_run_payloads',
      () => sql`
        delete from block_run_payloads where block_run_id in (
          select p.block_run_id from block_run_payloads p join block_runs b on b.id = p.block_run_id
          where b.run_id = any(${ids}::uuid[]) limit ${chunk})
        returning 1`,
    )
    result.blockRuns += await drain(
      'block_runs',
      () => sql`
        delete from block_runs where id in (
          select id from block_runs where run_id = any(${ids}::uuid[]) limit ${chunk})
        returning 1`,
    )
    result.logs += await drain(
      'run_logs',
      () => sql`
        delete from run_logs where id in (
          select id from run_logs where run_id = any(${ids}::uuid[]) limit ${chunk})
        returning 1`,
    )
    if (opts.signal?.aborted) {
      result.stopped = true
      break
    }
    // The conditions again, in the same statement as the delete: finished is final, but this is the authority.
    result.runs += await run(
      'workflow_runs',
      sql`
        delete from workflow_runs r
        where r.id = any(${ids}::uuid[]) and r.finished_at < ${cutoff}::timestamptz
          and not exists (select 1 from workflow_runs c where c.parent_run_id = r.id and c.finished_at is null)
        returning 1`,
    )
  }

  // Draft snapshots are made per draft revision for editor runs; once no run refers to an old one, it's dead weight.
  if (!result.stopped) {
    result.snapshots = await drain(
      'workflow_draft_snapshots',
      () => sql`
        delete from workflow_draft_snapshots where id in (
          select s.id from workflow_draft_snapshots s
          where s.created_at < ${cutoff}::timestamptz
            and not exists (select 1 from workflow_runs r where r.draft_snapshot_id = s.id)
          limit ${chunk})
        returning 1`,
    )
  }

  result.durationMs = Math.round(performance.now() - started)
  result.longestStatementMs = Math.round(result.longestStatementMs)
  return result
}

/**
 * Claims a periodic maintenance job: true when it last started more than `everyMs` ago (or never), in which case
 * this caller runs it now. One atomic upsert, so of all the workers checking, exactly one wins each period, and no
 * lock is held while the job runs. A worker that dies mid-job leaves the rest for the next period.
 */
export async function claimMaintenanceJob(db: Db, name: string, everyMs: number): Promise<boolean> {
  const rows = await db.execute(sql`
    insert into maintenance_jobs (name, last_started_at) values (${name}, now())
    on conflict (name) do update set last_started_at = now()
      where maintenance_jobs.last_started_at is null
         or maintenance_jobs.last_started_at < now() - ${`${Math.round(everyMs)} milliseconds`}::interval
    returning name`)
  return rows.length > 0
}

export async function finishMaintenanceJob(
  db: Db,
  name: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db
    .update(maintenanceJobs)
    .set({ lastFinishedAt: new Date(), lastResult: result })
    .where(sql`${maintenanceJobs.name} = ${name}`)
}

export interface RetentionLogger {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/**
 * Runs `deleteOldRuns` once a day across all workers: every worker checks every `checkMs` (default 10 minutes, the
 * first check a minute after start) and the one that claims the day's job runs it.
 */
export class RetentionJob {
  private timer: NodeJS.Timeout | undefined
  private first: NodeJS.Timeout | undefined
  private running: Promise<void> = Promise.resolve()
  private readonly stopping = new AbortController()

  constructor(
    private readonly opts: {
      db: Db
      days: number
      checkMs?: number
      firstCheckMs?: number
      everyMs?: number
      log?: RetentionLogger
    } & Pick<RetentionOptions, 'batchRuns' | 'chunkRows' | 'pauseMs'>,
  ) {}

  start() {
    if (this.opts.days <= 0 || this.timer) return
    const check = () => {
      this.running = this.running.then(async () => {
        await this.check()
      })
    }
    this.first = setTimeout(check, this.opts.firstCheckMs ?? 60_000)
    this.timer = setInterval(check, this.opts.checkMs ?? 10 * 60_000)
    this.first.unref()
    this.timer.unref()
  }

  async stop() {
    clearTimeout(this.first)
    clearInterval(this.timer)
    this.timer = undefined
    this.stopping.abort()
    await this.running
  }

  /** Runs retention if this worker claims today's job. Never throws. */
  async check(): Promise<RetentionResult | undefined> {
    const { db, log } = this.opts
    try {
      if (!(await claimMaintenanceJob(db, 'retention', this.opts.everyMs ?? 24 * 3_600_000))) return undefined
      const result = await deleteOldRuns(db, {
        days: this.opts.days,
        batchRuns: this.opts.batchRuns,
        chunkRows: this.opts.chunkRows,
        pauseMs: this.opts.pauseMs,
        signal: this.stopping.signal,
      })
      await finishMaintenanceJob(db, 'retention', { days: this.opts.days, ...result })
      log?.info({ retention: result }, 'retention finished')
      return result
    } catch (err) {
      log?.error({ err }, 'retention failed')
      await finishMaintenanceJob(db, 'retention', { error: (err as Error).message }).catch(() => {})
      return undefined
    }
  }
}
