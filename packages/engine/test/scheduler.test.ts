import { type Db, environments, workflowReleases, workflowRuns, workflows, workflowTriggers } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { nextScheduleFire, type ScheduleTrigger } from '@ow/definition'
import { asc, sql as dsql, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Claim, claimRuns, enqueueRun, finishRun, tickSchedules } from '../src'
import { connect, wf } from './pg-harness'

let db: Db
let other: Db
let prodId: string
let stagingId: string
let stopDb: () => Promise<void>

beforeAll(async () => {
  const pg = await startTestDatabase()
  const a = connect(pg.url)
  const b = connect(pg.url)
  db = a.db
  other = b.db
  const envs = await db.select().from(environments)
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
  stopDb = async () => {
    await a.close()
    await b.close()
    await pg.stop()
  }
})
beforeEach(async () => {
  await db.execute(dsql`truncate workflow_runs, workflow_triggers cascade`)
})
afterAll(() => stopDb?.())

const definition = wf([{ name: 'a', type: 'code', config: { code: 'return 1' } }], [['startTrigger', 'a']])
let n = 0

/** A workflow with a release, and optionally a concurrency limit. */
async function workflowWithRelease(opts: { maxConcurrentRuns?: number } = {}) {
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `sched_${++n}`, name: 'Scheduled', draftDefinition: definition, ...opts })
    .returning()
  const [release] = await db
    .insert(workflowReleases)
    .values({ workflowId: workflow!.id, version: '1.0.0', definition, definitionHash: 'a'.repeat(64) })
    .returning()
  return { workflow: workflow!, release: release! }
}

/** A projected schedule, first due at `nextFireAt` (default: its first fire after `from`). */
async function schedule(
  config: Partial<ScheduleTrigger>,
  opts: { nextFireAt?: Date; from?: Date; environmentId?: string; maxConcurrentRuns?: number } = {},
) {
  const { workflow, release } = await workflowWithRelease(opts)
  const full = { name: 'every', enabled: true, overlap: 'skip', ...config } as ScheduleTrigger
  const [trigger] = await db
    .insert(workflowTriggers)
    .values({
      workflowId: workflow.id,
      releaseId: release.id,
      kind: 'schedule',
      name: full.name,
      config: full,
      environmentId: opts.environmentId ?? prodId,
      nextFireAt: opts.nextFireAt ?? nextScheduleFire(full, opts.from ?? new Date()),
    })
    .returning()
  return { workflow, release, trigger: trigger! }
}

const at = (iso: string) => new Date(iso)
const runsOf = (triggerId: string) =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.triggerId, triggerId))
    .orderBy(asc(workflowRuns.scheduledFor))
const triggerRow = async (id: string) =>
  (await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, id)))[0]!

describe('tickSchedules', () => {
  it('fires a due schedule once, as a run of its release in its environment', async () => {
    const { trigger, release, workflow } = await schedule(
      { cron: '*/5 * * * *', timezone: 'UTC' },
      { nextFireAt: at('2026-10-14T10:05:00Z'), environmentId: stagingId },
    )
    expect(await tickSchedules(db, { now: at('2026-10-14T10:04:59Z') })).toEqual([])

    const fires = await tickSchedules(db, { now: at('2026-10-14T10:05:02Z') })
    expect(fires).toEqual([
      expect.objectContaining({
        triggerId: trigger.id,
        scheduledFor: at('2026-10-14T10:05:00Z'),
        runId: expect.any(String),
      }),
    ])
    const [run] = await runsOf(trigger.id)
    expect(run).toMatchObject({
      id: fires[0]!.runId,
      workflowId: workflow.id,
      releaseId: release.id,
      environmentId: stagingId,
      triggerType: 'schedule',
      status: 'queued',
      scheduledFor: at('2026-10-14T10:05:00Z'),
      input: { data: { scheduledFor: '2026-10-14T10:05:00.000Z', schedule: 'every' } },
    })
    expect(await triggerRow(trigger.id)).toMatchObject({
      nextFireAt: at('2026-10-14T10:10:00Z'),
      lastFiredAt: at('2026-10-14T10:05:00Z'),
    })
    expect(await tickSchedules(db, { now: at('2026-10-14T10:05:03Z') })).toEqual([])
  })

  it('ignores disabled schedules and schedules with no next fire', async () => {
    const off = await schedule({ cron: '* * * * *' }, { nextFireAt: at('2026-10-14T10:00:00Z') })
    await db.update(workflowTriggers).set({ enabled: false }).where(eq(workflowTriggers.id, off.trigger.id))
    const never = await schedule({ cron: '* * * * *' })
    await db
      .update(workflowTriggers)
      .set({ nextFireAt: null })
      .where(eq(workflowTriggers.id, never.trigger.id))
    expect(await tickSchedules(db, { now: at('2030-01-01T00:00:00Z') })).toEqual([])
  })

  it('catches up after downtime with one run, for the latest fire time that passed', async () => {
    const cron = await schedule(
      { cron: '*/5 * * * *', timezone: 'UTC' },
      { nextFireAt: at('2026-10-14T09:00:00Z') },
    )
    const interval = await schedule(
      { name: 'grid', intervalMs: 600_000 },
      { nextFireAt: at('2026-10-14T09:03:00Z') },
    )
    const fires = await tickSchedules(db, { now: at('2026-10-14T10:07:30Z') })
    expect(fires.map((f) => [f.triggerId, f.scheduledFor.toISOString()]).sort()).toEqual(
      [
        [cron.trigger.id, '2026-10-14T10:05:00.000Z'],
        [interval.trigger.id, '2026-10-14T10:03:00.000Z'],
      ].sort(),
    )
    expect(await runsOf(cron.trigger.id)).toHaveLength(1)
    expect((await triggerRow(cron.trigger.id)).nextFireAt).toEqual(at('2026-10-14T10:10:00Z'))
    // The interval keeps its grid (…09:03, 09:13 … 10:03, 10:13).
    expect((await triggerRow(interval.trigger.id)).nextFireAt).toEqual(at('2026-10-14T10:13:00Z'))
  })

  it('fires each fire time once, even when workers tick at the same moment or a fire repeats', async () => {
    const triggers = await Promise.all(
      Array.from({ length: 8 }, () =>
        schedule({ cron: '0 * * * *', timezone: 'UTC' }, { nextFireAt: at('2026-10-14T10:00:00Z') }),
      ),
    )
    const now = at('2026-10-14T10:00:01Z')
    const [a, b] = await Promise.all([tickSchedules(db, { now }), tickSchedules(other, { now })])
    expect(a.length + b.length).toBe(8)
    const count = await db.execute<{ n: number }>(dsql`select count(*)::int as n from workflow_runs`)
    expect(count[0]!.n).toBe(8)

    // Wind one schedule back to a fire that already ran: the unique (trigger, scheduled_for) index stops it.
    const { trigger } = triggers[0]!
    await db
      .update(workflowTriggers)
      .set({ nextFireAt: at('2026-10-14T10:00:00Z') })
      .where(eq(workflowTriggers.id, trigger.id))
    await db
      .update(workflowRuns)
      .set({ status: 'succeeded', finishedAt: now })
      .where(eq(workflowRuns.triggerId, trigger.id))
    expect(await tickSchedules(db, { now })).toEqual([expect.objectContaining({ runId: null })])
    expect(await runsOf(trigger.id)).toHaveLength(1)
    expect((await triggerRow(trigger.id)).nextFireAt).toEqual(at('2026-10-14T11:00:00Z'))
  })
})

/**
 * Plays a schedule minute by minute: each minute, runs that have taken `runMinutes` finish, the scheduler ticks,
 * and a worker claims whatever it may. Returns when each run ran and the most runs that ran at once.
 */
async function simulate(triggerId: string, start: Date, minutes: number, runMinutes: number) {
  const running = new Map<string, { claim: Claim; from: number }>()
  const ran: { runId: string; from: number; to: number }[] = []
  let mostAtOnce = 0
  for (let m = 0; m <= minutes; m++) {
    for (const [runId, { claim, from }] of running) {
      if (m - from >= runMinutes) {
        expect(await finishRun(db, claim, { status: 'succeeded', error: null })).toBe(true)
        ran.push({ runId, from, to: m })
        running.delete(runId)
      }
    }
    await tickSchedules(db, { now: new Date(start.getTime() + m * 60_000) })
    for (const claim of await claimRuns(db, 'sim-worker', 10, 600_000))
      running.set(claim.runId, { claim, from: m })
    mostAtOnce = Math.max(mostAtOnce, running.size)
  }
  const fired = (await runsOf(triggerId)).length
  return { ran, mostAtOnce, fired, stillRunning: running.size }
}

describe('a 1-minute cron whose runs take 2 minutes', () => {
  const start = at('2026-10-14T10:00:00Z')

  it('never overlaps with overlap "skip": the fires that come while a run is going are skipped', async () => {
    const { trigger } = await schedule({ cron: '* * * * *', timezone: 'UTC' }, { nextFireAt: start })
    const { ran, mostAtOnce, fired } = await simulate(trigger.id, start, 20, 2)
    expect(mostAtOnce).toBe(1)
    for (let i = 1; i < ran.length; i++) expect(ran[i]!.from).toBeGreaterThanOrEqual(ran[i - 1]!.to)
    // Runs start at minutes 0, 2, 4 … 20; the odd minutes are skipped.
    expect(fired).toBe(11)
    expect(ran.map((r) => r.from)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('never overlaps with overlap "queue": every fire runs, one after the other, in order', async () => {
    const { trigger } = await schedule(
      { cron: '* * * * *', timezone: 'UTC', overlap: 'queue' },
      { nextFireAt: start },
    )
    const { ran, mostAtOnce, fired } = await simulate(trigger.id, start, 20, 2)
    expect(mostAtOnce).toBe(1)
    expect(fired).toBe(21)
    for (let i = 1; i < ran.length; i++) expect(ran[i]!.from).toBeGreaterThanOrEqual(ran[i - 1]!.to)
    const order = (await runsOf(trigger.id)).map((r) => r.id)
    expect(ran.map((r) => r.runId)).toEqual(order.slice(0, ran.length))
  })

  it('overlaps only with overlap "allow"', async () => {
    const { trigger } = await schedule(
      { cron: '* * * * *', timezone: 'UTC', overlap: 'allow' },
      { nextFireAt: start },
    )
    const { mostAtOnce, fired } = await simulate(trigger.id, start, 10, 2)
    expect(mostAtOnce).toBe(2)
    expect(fired).toBe(11)
  })
})

describe('schedules across the Amsterdam DST changes', () => {
  /** Ticks every 10 minutes from `from` to `to` and returns the fire times that started runs. */
  async function firesBetween(config: Partial<ScheduleTrigger>, from: string, to: string) {
    const { trigger } = await schedule({ overlap: 'allow', ...config }, { from: at(from) })
    for (let t = at(from).getTime(); t <= at(to).getTime(); t += 10 * 60_000) {
      await tickSchedules(db, { now: new Date(t) })
    }
    return (await runsOf(trigger.id)).map((r) => r.scheduledFor!.toISOString())
  }

  it('runs a 02:30 job once a day when the clocks go forward', async () => {
    expect(
      await firesBetween({ cron: '30 2 * * *' }, '2026-03-27T23:00:00Z', '2026-03-30T23:00:00Z'),
    ).toEqual([
      '2026-03-28T01:30:00.000Z', // 02:30 CET
      '2026-03-29T01:00:00.000Z', // 02:30 doesn't exist: 03:00 CEST
      '2026-03-30T00:30:00.000Z', // 02:30 CEST
    ])
  })

  it('runs a 02:30 job once a day when the clocks go back', async () => {
    expect(
      await firesBetween({ cron: '30 2 * * *' }, '2026-10-23T23:00:00Z', '2026-10-26T23:00:00Z'),
    ).toEqual([
      '2026-10-24T00:30:00.000Z', // 02:30 CEST
      '2026-10-25T00:30:00.000Z', // the first 02:30; the second (CET) doesn't fire
      '2026-10-26T01:30:00.000Z', // 02:30 CET
    ])
  })

  it('runs an hourly job once per wall-clock hour through the repeated hour', async () => {
    expect(await firesBetween({ cron: '0 * * * *' }, '2026-10-24T22:30:00Z', '2026-10-25T03:30:00Z')).toEqual(
      [
        '2026-10-24T23:00:00.000Z', // 01:00 CEST
        '2026-10-25T00:00:00.000Z', // 02:00 CEST
        '2026-10-25T02:00:00.000Z', // 03:00 CET (02:00 CET repeats a wall-clock time and doesn't fire)
        '2026-10-25T03:00:00.000Z', // 04:00 CET
      ],
    )
  })

  it('keeps interval schedules exactly an interval apart through the change', async () => {
    const fires = await firesBetween(
      { intervalMs: 3_600_000 },
      '2026-10-24T22:30:00Z',
      '2026-10-25T03:40:00Z',
    )
    expect(fires).toEqual([
      '2026-10-24T23:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:30:00.000Z',
      '2026-10-25T03:30:00.000Z',
    ])
  })
})

describe('claim gates', () => {
  async function queueOf(workflowId: string, releaseId: string, count: number) {
    const runs = []
    for (let i = 0; i < count; i++) {
      runs.push(
        await enqueueRun(db, {
          workflowId,
          releaseId,
          environmentId: prodId,
          triggerType: 'manual',
          input: {},
        }),
      )
    }
    return runs
  }
  const running = async (workflowId: string) =>
    (
      await db.execute<{ n: number }>(
        dsql`select count(*)::int as n from workflow_runs where workflow_id = ${workflowId} and status = 'running'`,
      )
    )[0]!.n

  it("keeps a workflow's running runs under max_concurrent_runs, even when workers claim at once", async () => {
    const { workflow, release } = await workflowWithRelease({ maxConcurrentRuns: 2 })
    await queueOf(workflow.id, release.id, 6)
    const [a, b] = await Promise.all([
      claimRuns(db, 'worker-a', 5, 60_000),
      claimRuns(other, 'worker-b', 5, 60_000),
    ])
    expect(a.length + b.length).toBe(2)
    expect(await running(workflow.id)).toBe(2)
    expect(await claimRuns(db, 'worker-a', 5, 60_000)).toEqual([])

    // A full workflow doesn't hold up other workflows' runs queued behind it.
    const free = await workflowWithRelease()
    const [later] = await queueOf(free.workflow.id, free.release.id, 1)
    expect((await claimRuns(db, 'worker-a', 5, 60_000)).map((c) => c.runId)).toEqual([later!.id])

    // A finished run frees a slot for the next one, in order.
    expect(await finishRun(db, a[0] ?? b[0]!, { status: 'succeeded', error: null })).toBe(true)
    expect(await claimRuns(db, 'worker-a', 5, 60_000)).toHaveLength(1)
    expect(await running(workflow.id)).toBe(2)
  })

  it('runs a "queue" schedule one run at a time', async () => {
    const { trigger } = await schedule(
      { cron: '* * * * *', timezone: 'UTC', overlap: 'queue' },
      { nextFireAt: at('2026-10-14T10:00:00Z') },
    )
    await tickSchedules(db, { now: at('2026-10-14T10:00:00Z') })
    await tickSchedules(db, { now: at('2026-10-14T10:01:00Z') })
    const [first] = await Promise.all([
      claimRuns(db, 'worker-a', 5, 60_000),
      claimRuns(other, 'worker-b', 5, 60_000),
    ])
    const claimed = await db.select().from(workflowRuns).where(eq(workflowRuns.triggerId, trigger.id))
    expect(claimed.filter((r) => r.status === 'running')).toHaveLength(1)
    expect(claimed.find((r) => r.status === 'running')!.scheduledFor).toEqual(at('2026-10-14T10:00:00Z'))
    expect(first).toBeDefined()
  })

  it('keeps a "queue" schedule in order while another worker holds its earliest run', async () => {
    // The race behind a CI failure (2026-11-19): worker A has locked the 10:00 run, worker B skips it (SKIP LOCKED),
    // locks 10:01 and, finding nothing running yet, must not start it ahead of 10:00.
    const { trigger } = await schedule(
      { cron: '* * * * *', timezone: 'UTC', overlap: 'queue' },
      { nextFireAt: at('2026-10-14T10:00:00Z') },
    )
    await tickSchedules(db, { now: at('2026-10-14T10:00:00Z') })
    await tickSchedules(db, { now: at('2026-10-14T10:01:00Z') })
    const [earliest, later] = await runsOf(trigger.id)
    expect(earliest!.scheduledFor).toEqual(at('2026-10-14T10:00:00Z'))

    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked!: () => void
    const isLocked = new Promise<void>((r) => {
      locked = r
    })
    const workerA = other.transaction(async (tx) => {
      await tx.execute(dsql`select id from workflow_runs where id = ${earliest!.id} for update`)
      locked()
      await held
    })
    await isLocked
    const workerB = await claimRuns(db, 'worker-b', 5, 60_000)
    release()
    await workerA
    expect(workerB.map((c) => c.runId)).not.toContain(later!.id)

    // Once nobody holds it, the earliest goes first.
    const next = await claimRuns(db, 'worker-a', 5, 60_000)
    expect(next.map((c) => c.runId)).toEqual([earliest!.id])
  })
})
