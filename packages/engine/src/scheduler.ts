import { type Db, workflowRuns } from '@ow/db'
import { nextIntervalFire, nextScheduleFire, type ScheduleTrigger } from '@ow/definition'
import { sql } from 'drizzle-orm'
import { RUNS_QUEUED_CHANNEL } from './queue'

export interface ScheduleFire {
  triggerId: string
  workflowId: string
  schedule: string
  scheduledFor: Date
  /** The run started for this fire; null when it was skipped (overlap `skip`) or had already run. */
  runId: string | null
}

/** A fire that's further behind than this many fire times catches up from where the search stopped. */
const MAX_CATCH_UP_STEPS = 10_000

/**
 * One scheduler pass: fires every enabled schedule whose `next_fire_at` has passed. Every worker runs it every few
 * seconds; `FOR UPDATE SKIP LOCKED` on the trigger rows means each due schedule is handled by one of them, and the
 * `ON CONFLICT (trigger_id, scheduled_for)` insert means each fire time runs at most once.
 *
 * - After downtime a schedule catches up with one run, for the latest fire time that has passed, not one per missed
 *   fire.
 * - Overlap `skip` (the default) doesn't start a run while an earlier run of the same schedule is queued, running
 *   or waiting; the check and the insert happen under the trigger row's lock, so runs of a schedule never overlap.
 *   `queue` inserts the run and the claim gate starts it when the previous one ends; `allow` just inserts it.
 * - Runs execute the trigger's release in the trigger's environment, with
 *   `startTrigger.data = { scheduledFor, schedule }`.
 *
 * `now` defaults to the database's clock, so workers on different machines agree.
 */
export async function tickSchedules(
  db: Db,
  opts: { now?: Date; batch?: number } = {},
): Promise<ScheduleFire[]> {
  return db.transaction(async (tx) => {
    const now =
      opts.now ??
      new Date(
        Number((await tx.execute<{ ms: string }>(sql`select extract(epoch from now()) * 1000 as ms`))[0]!.ms),
      )
    const due = await tx.execute<DueTrigger>(sql`
      select id, workflow_id, release_id, environment_id, name, config, next_fire_at
      from workflow_triggers
      where kind = 'schedule' and enabled and next_fire_at <= ${now.toISOString()}
      order by next_fire_at
      limit ${opts.batch ?? 50}
      for update skip locked`)

    const fires: ScheduleFire[] = []
    for (const trigger of due) {
      const schedule = trigger.config as ScheduleTrigger
      const scheduledFor = latestFire(schedule, new Date(trigger.next_fire_at), now)
      const overlap = schedule.overlap ?? 'skip'
      const busy =
        overlap === 'skip' &&
        (
          await tx.execute(sql`
            select 1 from workflow_runs
            where trigger_id = ${trigger.id} and status in ('queued', 'running', 'waiting')
            limit 1`)
        ).length > 0

      let runId: string | null = null
      if (!busy) {
        const [inserted] = await tx
          .insert(workflowRuns)
          .values({
            workflowId: trigger.workflow_id,
            releaseId: trigger.release_id,
            environmentId: trigger.environment_id,
            triggerType: 'schedule',
            triggerId: trigger.id,
            scheduledFor,
            input: { data: { scheduledFor: scheduledFor.toISOString(), schedule: trigger.name } },
          })
          .onConflictDoNothing({
            target: [workflowRuns.triggerId, workflowRuns.scheduledFor],
            where: sql`${workflowRuns.triggerId} is not null and ${workflowRuns.scheduledFor} is not null`,
          })
          .returning({ id: workflowRuns.id })
        runId = inserted?.id ?? null
      }

      const next = nextScheduleFire(schedule, now, scheduledFor)
      await tx.execute(sql`
        update workflow_triggers
        set next_fire_at = ${next?.toISOString() ?? null},
            last_fired_at = coalesce(${runId ? scheduledFor.toISOString() : null}::timestamptz, last_fired_at),
            updated_at = now()
        where id = ${trigger.id}`)
      fires.push({
        triggerId: trigger.id,
        workflowId: trigger.workflow_id,
        schedule: trigger.name,
        scheduledFor,
        runId,
      })
    }
    if (fires.some((f) => f.runId)) await tx.execute(sql`select pg_notify(${RUNS_QUEUED_CHANNEL}, '')`)
    return fires
  })
}

interface DueTrigger extends Record<string, unknown> {
  id: string
  workflow_id: string
  release_id: string
  environment_id: string
  name: string
  config: Record<string, unknown>
  next_fire_at: string
}

/** The latest fire time at or before `now`, starting from the first one that's due. */
function latestFire(schedule: ScheduleTrigger, due: Date, now: Date): Date {
  if (schedule.intervalMs !== undefined && schedule.cron === undefined) {
    const next = nextIntervalFire(due, schedule.intervalMs, now)
    return new Date(next.getTime() - schedule.intervalMs)
  }
  let fire = due
  for (let i = 0; i < MAX_CATCH_UP_STEPS; i++) {
    const next = nextScheduleFire(schedule, fire)
    if (!next || next > now) break
    fire = next
  }
  return fire
}

export interface SchedulerLogger {
  info(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/** Runs `tickSchedules` on a timer (every 5 s by default) until stopped. */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<void> = Promise.resolve()

  constructor(private readonly opts: { db: Db; intervalMs?: number; log?: SchedulerLogger }) {}

  start() {
    this.timer ??= setInterval(() => {
      this.ticking = this.ticking.then(() => this.tick())
    }, this.opts.intervalMs ?? 5_000)
  }

  async stop() {
    clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
  }

  /** Fires everything due, in batches, logging the fires. Never throws. */
  async tick() {
    try {
      for (;;) {
        const fires = await tickSchedules(this.opts.db)
        for (const f of fires) {
          this.opts.log?.info(
            { triggerId: f.triggerId, schedule: f.schedule, scheduledFor: f.scheduledFor, runId: f.runId },
            f.runId ? 'schedule fired' : 'schedule fire skipped',
          )
        }
        if (fires.length < 50) return
      }
    } catch (err) {
      this.opts.log?.error({ err }, 'schedule tick failed')
    }
  }
}
