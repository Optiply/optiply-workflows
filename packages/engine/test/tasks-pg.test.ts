/**
 * User Tasks on Postgres: the run waits for a person without holding a worker, and completing the task resumes it,
 * even when no worker was running at the time. Tasks expire, close when their run is cancelled, and check what
 * people submit.
 */
import { PoolManager } from '@ow/connectors'
import { blockRunPayloads, blockRuns, type Db, groupMembers, groups, users, userTasks } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { and, sql as dsql, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelRun,
  completeTask,
  Dispatcher,
  type DispatcherOptions,
  PgUserTasks,
  type ResourceProvider,
} from '../src'
import { connect, getRun, postgresResources, queueRun, sql, waitFor, waitForFinish, wf } from './pg-harness'

let db: Db
let listener: postgres.Sql
let resources: ResourceProvider
let pool: PoolManager
let stopAll: () => Promise<void>
let ana: { id: string; email: string; name: string }
let bob: { id: string }
const dispatchers: Dispatcher[] = []

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = connect(pg.url)
  db = conn.db
  listener = conn.sql
  resources = postgresResources(pg.url)
  pool = new PoolManager({ sweepIntervalMs: 0 })
  stopAll = async () => {
    await pool.closeAll()
    await conn.close()
    await pg.stop()
  }
  ana = (
    await db
      .insert(users)
      .values({ email: 'ana@optiply.nl', name: 'Ana' })
      .returning({ id: users.id, email: users.email, name: users.name })
  )[0]!
  bob = (
    await db.insert(users).values({ email: 'bob@optiply.nl', name: 'Bob' }).returning({ id: users.id })
  )[0]!
  const [finance] = await db.insert(groups).values({ name: 'Finance' }).returning()
  await db.insert(groupMembers).values({ groupId: finance!.id, userId: bob!.id })
})
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.stop()))
})
afterAll(() => stopAll?.())

/** A dispatcher that only claims when woken by NOTIFY: polling every minute can't explain a prompt resume. */
function dispatcher(opts: Partial<DispatcherOptions> = {}) {
  const d = new Dispatcher({
    db,
    listener,
    pool,
    resources,
    pollIntervalMs: 60_000,
    reapIntervalMs: 100,
    ...opts,
  })
  dispatchers.push(d)
  return d
}

const approval = (config: object = {}, extra: object = {}) => ({
  name: 'approval',
  type: 'userTask',
  config: {
    title: 'Refund {{ startTrigger.data.amount }} to {{ startTrigger.data.customer }}?',
    description: 'Asked by {{ startTrigger.data.owner }}',
    assignees: { users: ['{{ startTrigger.data.owner }}'], groups: ['Finance'] },
    fields: [
      { name: 'reason', label: 'Reason', type: 'text', required: true },
      { name: 'amount', label: 'Amount', type: 'number', default: '{{ startTrigger.data.amount }}' },
    ],
    outcomes: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    ...config,
  },
  ...extra,
})

const refundFlow = (task = approval()) =>
  wf(
    [
      task,
      sql(
        'after',
        "select {{ approval.data.outcome }} || ':' || {{ approval.data.values.amount }}::text as result",
      ),
    ],
    [
      ['startTrigger', 'approval'],
      ['approval', 'after'],
    ],
  )
const input = { data: { amount: 120, customer: 'acme', owner: 'ana@optiply.nl' } }

async function taskOf(runId: string) {
  const [task] = await db.select().from(userTasks).where(eq(userTasks.runId, runId))
  return task
}

async function dataOf(runId: string, key: string) {
  const [row] = await db
    .select({ data: blockRunPayloads.data })
    .from(blockRuns)
    .innerJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
    .where(and(eq(blockRuns.runId, runId), eq(blockRuns.blockKey, key)))
  return row?.data
}

describe('User Tasks', () => {
  it('a run waits for its task, and completing it resumes the run, even with no worker running at the time', async () => {
    const first = dispatcher()
    await first.start()
    const run = await queueRun(db, refundFlow(), input)

    // The run pauses and frees its worker; the task is open, with its templates rendered and assignees resolved.
    await waitFor(async () => (await getRun(db, run.id)).status === 'waiting')
    const task = await taskOf(run.id)
    expect(task).toMatchObject({
      status: 'open',
      blockKey: 'approval',
      title: 'Refund 120 to acme?',
      description: 'Asked by ana@optiply.nl',
      assigneeUserIds: [ana.id],
      outcomes: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      dueAt: null,
    })
    expect(task!.assigneeGroupIds).toHaveLength(1)
    expect(task!.fields).toEqual([
      { name: 'reason', label: 'Reason', type: 'text', required: true },
      { name: 'amount', label: 'Amount', type: 'number', default: 120 },
    ])
    const [waiting] = await db
      .select()
      .from(blockRuns)
      .where(and(eq(blockRuns.runId, run.id), eq(blockRuns.blockKey, 'approval')))
    expect(waiting).toMatchObject({ status: 'waiting', metadata: { taskId: task!.id } })

    // Every worker stops. The task is answered meanwhile (what people submit is checked first).
    await first.stop()
    expect(
      await completeTask(db, {
        taskId: task!.id,
        userId: bob.id,
        outcome: 'approve',
        values: { amount: 'lots' },
      }),
    ).toEqual({
      ok: false,
      reason: 'invalid',
      errors: [
        { field: 'reason', message: 'Reason is required' },
        { field: 'amount', message: 'Amount must be a number' },
      ],
    })
    expect(
      await completeTask(db, {
        taskId: task!.id,
        userId: bob.id,
        outcome: 'approve',
        values: { reason: 'Late delivery', amount: 100 },
      }),
    ).toEqual({ ok: true, runId: run.id })
    expect((await getRun(db, run.id)).status).toBe('waiting')

    // A new worker picks the run up as soon as it starts, and the run carries on with the answer.
    const started = Date.now()
    await dispatcher().start()
    const done = await waitForFinish(db, run.id)
    expect(done.status).toBe('succeeded')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await dataOf(run.id, 'approval')).toEqual({
      outcome: 'approve',
      values: { reason: 'Late delivery', amount: 100 },
      completedBy: { id: bob.id, email: 'bob@optiply.nl', name: 'Bob' },
      completedAt: expect.any(String),
    })
    expect(await dataOf(run.id, 'after')).toEqual([{ result: 'approve:100' }])
    expect(await taskOf(run.id)).toMatchObject({
      status: 'completed',
      outcome: 'approve',
      completedBy: bob.id,
    })
    // Only once.
    expect(
      await completeTask(db, {
        taskId: task!.id,
        userId: ana.id,
        outcome: 'reject',
        values: { reason: 'x' },
      }),
    ).toEqual({ ok: false, reason: 'not_open' })
  })

  it('wakes a waiting run at once (not at its hourly recheck)', async () => {
    await dispatcher().start()
    const run = await queueRun(db, refundFlow(), input)
    await waitFor(async () => (await getRun(db, run.id)).status === 'waiting')
    const task = await taskOf(run.id)
    const started = Date.now()
    // A field's default only fills the form in: what's submitted is what counts.
    await completeTask(db, {
      taskId: task!.id,
      userId: ana.id,
      outcome: 'reject',
      values: { reason: 'No', amount: 120 },
    })
    expect((await waitForFinish(db, run.id)).status).toBe('succeeded')
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(await dataOf(run.id, 'after')).toEqual([{ result: 'reject:120' }])
  })

  it('picks up an answer given while the run was still busy with another branch', async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      wf(
        [approval(), sql('slow', 'select pg_sleep(1.5) as slept')],
        [
          ['startTrigger', 'approval'],
          ['startTrigger', 'slow'],
        ],
      ),
      input,
    )
    // Answer as soon as the task exists, while `slow` keeps the run running.
    const task = await waitFor(() => taskOf(run.id))
    expect((await getRun(db, run.id)).status).toBe('running')
    await completeTask(db, {
      taskId: task.id,
      userId: ana.id,
      outcome: 'approve',
      values: { reason: 'Fine' },
    })
    const done = await waitForFinish(db, run.id, 10_000)
    expect(done.status).toBe('succeeded')
    expect(await dataOf(run.id, 'approval')).toMatchObject({ outcome: 'approve' })
  })

  it('expires when nobody completes it in time, failing the block', async () => {
    await dispatcher({ pollIntervalMs: 100 }).start()
    const run = await queueRun(
      db,
      refundFlow(
        approval({ due: { amount: '0.02', unit: 'minutes' } }, { settings: { finally: 'continue' } }),
      ),
      input,
    )
    // The task is due in 1.2 s: on a busy machine the run can wait, expire and finish between two looks (CI,
    // 2026-11-19), so a run already past waiting counts too. What follows proves the task expired.
    await waitFor(async () => {
      const { status } = await getRun(db, run.id)
      return status === 'waiting' || status === 'succeeded' || status === 'failed'
    })
    expect((await taskOf(run.id))!.dueAt).toBeInstanceOf(Date)
    const done = await waitForFinish(db, run.id, 10_000)
    expect(done.status).toBe('succeeded')
    const [block] = await db
      .select()
      .from(blockRuns)
      .where(and(eq(blockRuns.runId, run.id), eq(blockRuns.blockKey, 'approval')))
    expect(block).toMatchObject({ status: 'errored', error: { code: 'task_expired' } })
    expect(await taskOf(run.id)).toMatchObject({ status: 'expired' })
    const late = await completeTask(db, {
      taskId: (await taskOf(run.id))!.id,
      userId: ana.id,
      outcome: 'approve',
      values: { reason: 'Too late' },
    })
    expect(late).toEqual({ ok: false, reason: 'not_open' })
  })

  it('closes its task when the run is cancelled', async () => {
    await dispatcher().start()
    const run = await queueRun(db, refundFlow(), input)
    await waitFor(async () => (await getRun(db, run.id)).status === 'waiting')
    expect(await cancelRun(db, run.id)).toBe('cancelled')
    expect(await taskOf(run.id)).toMatchObject({ status: 'cancelled' })
    const answer = await completeTask(db, {
      taskId: (await taskOf(run.id))!.id,
      userId: ana.id,
      outcome: 'approve',
      values: { reason: 'x' },
    })
    expect(answer).toEqual({ ok: false, reason: 'not_open' })
  })

  it('fails the block when an assignee does not exist', async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      refundFlow(approval({ assignees: { users: ['nobody@optiply.nl'], groups: ['Ghosts'] } })),
      input,
    )
    const done = await waitForFinish(db, run.id)
    expect(done).toMatchObject({
      status: 'failed',
      error: {
        code: 'unknown_assignee',
        message: 'No user has the email nobody@optiply.nl; No group is named Ghosts',
        block: 'approval',
      },
    })
    expect(await taskOf(run.id)).toBeUndefined()
  })

  /** Opens a task for a queued run (no worker), as the block would. Cancel the run afterwards. */
  const openTask = async (
    tasks: PgUserTasks,
    assignees: { users: string[]; groups: string[] },
    dueAt: Date | null,
  ) => {
    const run = await queueRun(db, refundFlow(), input)
    const request = {
      runId: run.id,
      blockKey: 'approval',
      workflowId: run.workflowId,
      environmentId: run.environmentId,
      title: 'Refund?',
      description: null,
      fields: [{ name: 'reason', label: 'Reason', type: 'text' as const, required: false }],
      outcomes: [{ id: 'approve', label: 'Approve' }],
      assignees,
      dueAt,
    }
    return { run, request, task: await tasks.open(request) }
  }

  it('a block that runs again gets its task back, even if an assignee is gone since', async () => {
    const tasks = new PgUserTasks(db)
    await db.insert(users).values({ email: 'carol@optiply.nl', name: 'Carol' })
    const { run, request, task } = await openTask(tasks, { users: ['carol@optiply.nl'], groups: [] }, null)
    await db.delete(users).where(eq(users.email, 'carol@optiply.nl'))
    expect((await tasks.open(request)).id).toBe(task.id)
    await cancelRun(db, run.id)
  })

  it('refuses an answer past the due time, even before the run has expired the task', async () => {
    const tasks = new PgUserTasks(db)
    const { run, task } = await openTask(
      tasks,
      { users: ['ana@optiply.nl'], groups: [] },
      new Date(Date.now() - 1000),
    )
    expect(task.status).toBe('open')
    const late = await completeTask(db, { taskId: task.id, userId: ana.id, outcome: 'approve', values: {} })
    expect(late).toEqual({ ok: false, reason: 'expired' })
    expect((await tasks.get(task.id))!.status).toBe('expired')
    await cancelRun(db, run.id)
  })
})

describe('the queue', () => {
  it('closes open tasks of runs that end some other way', async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      wf(
        [approval(), sql('broken', 'select 1 / (count(*) - count(*)) as boom from (select pg_sleep(0.5)) s')],
        [
          ['startTrigger', 'approval'],
          ['startTrigger', 'broken'],
        ],
      ),
      input,
    )
    // `broken` fails half a second in (division by zero), which fails the run while its task is open.
    const done = await waitForFinish(db, run.id)
    expect(done.status).toBe('failed')
    expect(await taskOf(run.id)).toMatchObject({ status: 'cancelled' })
    const [{ open }] = (await db.execute(
      dsql`select count(*)::int as open from user_tasks where status = 'open'`,
    )) as unknown as [{ open: number }]
    expect(open).toBe(0)
  })
})
