/**
 * Child workflows on Postgres: child rows linked to their parent and started once per block attempt, a paused
 * parent woken as soon as its child ends, and cancel cascading to children.
 */
import { PoolManager } from '@ow/connectors'
import { type Db, workflowRuns } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { sql as dsql, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { cancelRun, Dispatcher } from '../src'
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
