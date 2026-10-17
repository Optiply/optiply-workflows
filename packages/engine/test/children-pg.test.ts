/**
 * Child workflows on Postgres: child rows linked to their parent and started once per block attempt, a paused
 * parent woken as soon as its child ends, and cancel cascading to children.
 */
import { PoolManager } from '@ow/connectors'
import { blockRuns, type Db, workflowRuns } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { sql as dsql, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { cancelRun, claimRuns, Dispatcher, finishRun, releaseRun, startRun, suspendRun } from '../src'
import {
  blocksOf,
  connect,
  getRun,
  postgresResources,
  publishWorkflow,
  queueRun,
  waitFor,
  waitForFinish,
  wf,
} from './pg-harness'

let db: Db
let listener: postgres.Sql
let pool: PoolManager
let url: string
let stopAll: () => Promise<void>
const dispatchers: Dispatcher[] = []

beforeAll(async () => {
  const pg = await startTestDatabase()
  url = pg.url
  const conn = connect(url)
  db = conn.db
  listener = conn.sql
  pool = new PoolManager({ sweepIntervalMs: 0 })
  stopAll = async () => {
    await pool.closeAll()
    await conn.close()
    await pg.stop()
  }
  const reply = {
    name: 'reply',
    type: 'response',
    config: { body: '{"hello": {{ startTrigger.data.name }}}' },
  }
  await publishWorkflow(db, 'greet', wf([reply], [['startTrigger', 'reply']]))
  await publishWorkflow(
    db,
    'slow-greet',
    wf(
      [{ name: 'pause', type: 'wait', config: { kind: 'duration', amount: '3', unit: 'seconds' } }, reply],
      [
        ['startTrigger', 'pause'],
        ['pause', 'reply'],
      ],
    ),
  )
  await publishWorkflow(
    db,
    'very-slow',
    wf(
      [{ name: 'pause', type: 'wait', config: { kind: 'duration', amount: '10', unit: 'minutes' } }],
      [['startTrigger', 'pause']],
    ),
  )
})
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.stop()))
})
afterAll(() => stopAll?.())

async function start() {
  const d = new Dispatcher({ db, listener, pool, resources: postgresResources(url), pollIntervalMs: 100 })
  dispatchers.push(d)
  await d.start()
}

const call = (workflow: string, extra: object = {}) => ({
  name: 'call',
  type: 'workflow',
  config: { workflow, input: '{"name": {{ startTrigger.data.name }}}', ...extra },
})

const childrenOf = (parentId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, parentId))

it('runs a child linked to its parent and returns its Response body', async () => {
  await start()
  const parent = await queueRun(db, wf([call('greet')], [['startTrigger', 'call']]), {
    data: { name: 'Ada' },
  })
  const done = await waitForFinish(db, parent.id)
  expect(done.status).toBe('succeeded')
  const [child] = await childrenOf(parent.id)
  expect(child).toMatchObject({
    status: 'succeeded',
    triggerType: 'workflow',
    environmentId: parent.environmentId,
    idempotencyKey: `child:${parent.id}:call:1`,
    input: { data: { name: 'Ada' } },
  })
  const [row] = await db.execute<{ data: unknown }>(dsql`
    select p.data from block_runs b join block_run_payloads p on p.block_run_id = b.id
    where b.run_id = ${parent.id} and b.block_key = 'call'`)
  expect(row!.data).toEqual({ hello: 'Ada' })
})

it('pauses the parent while its child waits, and wakes it as soon as the child ends', async () => {
  await start()
  const parent = await queueRun(db, wf([call('slow-greet')], [['startTrigger', 'call']]), {
    data: { name: 'Bo' },
  })
  await waitFor(async () => (await getRun(db, parent.id)).status === 'waiting')
  expect((await blocksOf(db, parent.id)).call!.status).toBe('waiting')

  const done = await waitForFinish(db, parent.id)
  expect(done.status).toBe('succeeded')
  const [child] = await childrenOf(parent.id)
  // Not at its hourly recheck: within moments of the child finishing.
  expect(done.finishedAt!.getTime() - child!.finishedAt!.getTime()).toBeLessThan(1500)
  expect(await childrenOf(parent.id)).toHaveLength(1)
})

it('cancels the children of a cancelled parent', async () => {
  await start()
  const parent = await queueRun(db, wf([call('very-slow')], [['startTrigger', 'call']]), {
    data: { name: 'Cy' },
  })
  await waitFor(async () => (await getRun(db, parent.id)).status === 'waiting')
  const [child] = await childrenOf(parent.id)
  await waitFor(async () => (await getRun(db, child!.id)).status === 'waiting')

  expect(await cancelRun(db, parent.id)).toBe('cancelled')
  expect(await getRun(db, parent.id)).toMatchObject({ status: 'cancelled' })
  expect(await getRun(db, child!.id)).toMatchObject({ status: 'cancelled' })
})

it("fails the block when the child workflow isn't published", async () => {
  await start()
  await queueRun(db, wf([], [])) // a workflow with no live release, under a random slug
  const parent = await queueRun(db, wf([call('missing-one')], [['startTrigger', 'call']]), {
    data: { name: 'Di' },
  })
  expect(await waitForFinish(db, parent.id)).toMatchObject({
    status: 'failed',
    error: { block: 'call', code: 'unknown_workflow' },
  })
})

it('stops a workflow that calls itself after 10 levels', async () => {
  await start()
  const self = wf(
    [{ name: 'again', type: 'workflow', config: { workflow: 'recursive' } }],
    [['startTrigger', 'again']],
  )
  await publishWorkflow(db, 'recursive', self)
  const top = await queueRun(db, self)
  const done = await waitForFinish(db, top.id, 60_000)
  expect(done).toMatchObject({ status: 'failed', error: { block: 'again', code: 'child_failed' } })
  expect((done.error as { message: string }).message).toContain('at most 10 levels deep')
  // The top run is level 1; nine nested children below it, the deepest failing to start a tenth.
  const [below] = await db.execute<{ n: number }>(dsql`
    with recursive down(id) as (
      select id from workflow_runs where parent_run_id = ${top.id}
      union all
      select r.id from workflow_runs r join down on r.parent_run_id = down.id
    )
    select count(*)::int as n from down`)
  expect(below!.n).toBe(9)
})

it('wakes a parent whose child ends while the parent pauses', async () => {
  // A child ending wakes its parent only if the parent is already waiting; a parent pausing looks for children
  // that already ended. A child's ending committed just after the parent looked was seen by neither, and the parent
  // slept for its hour (CI, M11). A deferred trigger holds the child's transaction open after its wake-up, at
  // commit, while the parent pauses.
  await db.execute(dsql`
    create function test_slow_finish() returns trigger language plpgsql as $$
    begin perform pg_sleep(0.5); return null; end $$`)
  await db.execute(dsql`
    create constraint trigger test_slow_finish after update on workflow_runs
    deferrable initially deferred for each row
    when (old.status = 'running' and new.status = 'succeeded' and new.parent_run_id is not null)
    execute function test_slow_finish()`)
  try {
    const parent = await queueRun(db, wf([], []))
    const { run: child } = await startRun(db, {
      workflowId: parent.workflowId,
      releaseId: parent.releaseId,
      environmentId: parent.environmentId,
      triggerType: 'workflow',
      parentRunId: parent.id,
      input: { data: null },
    })
    const claims = await claimRuns(db, 'test-worker', 100, 30_000)
    const ours = [parent.id, child.id]
    for (const other of claims.filter((c) => !ours.includes(c.runId))) await releaseRun(db, other)
    const parentClaim = claims.find((c) => c.runId === parent.id)!
    const childClaim = claims.find((c) => c.runId === child.id)!
    const anHour = new Date(Date.now() + 3_600_000)
    await db.insert(blockRuns).values({
      runId: parent.id,
      blockKey: 'call',
      status: 'waiting',
      attempt: 1,
      epoch: parentClaim.epoch,
      metadata: { until: anHour.toISOString(), childRunId: child.id },
      startedAt: new Date(),
    })

    const finishing = finishRun(db, childClaim, { status: 'succeeded', error: null })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await suspendRun(db, parentClaim, anHour)).toBe(true)
    expect(await finishing).toBe(true)

    const after = await getRun(db, parent.id)
    expect(after.status).toBe('waiting')
    expect(after.availableAt.getTime()).toBeLessThanOrEqual(Date.now())
  } finally {
    await db.execute(dsql`drop trigger test_slow_finish on workflow_runs`)
    await db.execute(dsql`drop function test_slow_finish()`)
  }
})

it('runs a child per loop iteration', async () => {
  await start()
  const parent = await queueRun(
    db,
    wf(
      [
        {
          name: 'each',
          type: 'loop',
          config: {
            input: '{{ ["a", "b", "c"] }}',
            runner: { kind: 'workflow', workflow: 'greet', input: '{"name": {{ value }}}' },
          },
        },
      ],
      [['startTrigger', 'each']],
    ),
  )
  expect((await waitForFinish(db, parent.id)).status).toBe('succeeded')
  const children = await childrenOf(parent.id)
  expect(children.map((c) => c.idempotencyKey).sort()).toEqual([
    `child:${parent.id}:each[0]:1`,
    `child:${parent.id}:each[1]:1`,
    `child:${parent.id}:each[2]:1`,
  ])
})
