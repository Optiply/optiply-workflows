import { type ChildProcess, fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { sql as dsql } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Dispatcher } from '../src'
import {
  blocksOf,
  connect,
  getRun,
  hit,
  hitsOf,
  postgresResources,
  queueRun,
  sql,
  waitFor,
  waitForFinish,
  wf,
} from './pg-harness'

let url: string
let db: Db
let close: () => Promise<void>
let child: ChildProcess | undefined

beforeAll(async () => {
  const pg = await startTestDatabase()
  url = pg.url
  const conn = connect(url)
  db = conn.db
  await db.execute(dsql`create table hits (id serial primary key, run_id text not null, block text not null)`)
  close = async () => {
    await conn.close()
    await pg.stop()
  }
})
afterAll(async () => {
  child?.kill('SIGKILL')
  await close?.()
})

it('resumes a run on another worker after kill -9, without re-running completed blocks', async () => {
  child = fork(fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    execArgv: ['--import', 'tsx', '--no-node-snapshot'],
    env: { ...process.env, DATABASE_URL: url, TZ: 'UTC' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  await once(child, 'message')

  const run = await queueRun(
    db,
    wf(
      [hit('first'), sql('slow', 'select pg_sleep(2)'), hit('last')],
      [
        ['startTrigger', 'first'],
        ['first', 'slow'],
        ['slow', 'last'],
      ],
    ),
  )
  // Kill the worker once `first` is committed and `slow` is in flight.
  await waitFor(async () => {
    const blocks = await blocksOf(db, run.id)
    return blocks.first?.status === 'succeeded' && blocks.slow?.status === 'running'
  })
  child.kill('SIGKILL')
  await once(child, 'exit')
  expect(await getRun(db, run.id)).toMatchObject({ status: 'running', leaseOwner: 'doomed-worker', epoch: 1 })

  const pool = new PoolManager({ sweepIntervalMs: 0 })
  const survivor = new Dispatcher({
    db,
    pool,
    resources: postgresResources(url),
    workerId: 'survivor',
    pollIntervalMs: 100,
    reapIntervalMs: 100,
  })
  await survivor.start()
  try {
    const done = await waitForFinish(db, run.id)
    expect(done).toMatchObject({ status: 'succeeded', recoveries: 1, epoch: 3, leaseOwner: null })
    // `first` ran once, on the killed worker, and its result was reused; `slow` was re-run by the survivor.
    expect(await hitsOf(db, run.id)).toEqual({ first: 1, last: 1 })
    expect(await blocksOf(db, run.id)).toMatchObject({
      startTrigger: { status: 'succeeded', epoch: 1 },
      first: { status: 'succeeded', epoch: 1 },
      slow: { status: 'succeeded', epoch: 3 },
      last: { status: 'succeeded', epoch: 3 },
    })
  } finally {
    await survivor.stop()
    await pool.closeAll()
  }
})

it('resumes a 10,000-iteration loop after kill -9, re-running only iterations that were not committed', async () => {
  const total = 10_000
  child = fork(fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    execArgv: ['--import', 'tsx', '--no-node-snapshot'],
    env: { ...process.env, DATABASE_URL: url, TZ: 'UTC' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  await once(child, 'message')

  // Each iteration records its index in `hits`, so executions can be counted.
  const run = await queueRun(
    db,
    wf(
      [
        {
          name: 'each',
          type: 'loop',
          config: {
            input: `{{ _.range(${total}) }}`,
            concurrency: 20,
            runner: {
              kind: 'query',
              resource: 'db',
              query: {
                sql: 'insert into hits (run_id, block) values ({{ workflowContext.runId }}, {{ String(index) }}) returning {{ index }}::int * 3 as v',
              },
            },
          },
        },
        {
          name: 'check',
          type: 'code',
          config: { code: 'return each.data.every((rows, i) => rows[0].v === i * 3)' },
        },
      ],
      [
        ['startTrigger', 'each'],
        ['each', 'check'],
      ],
    ),
  )
  const committed = async () => {
    const [row] = await db.execute<{ n: number }>(dsql`
      select count(*)::int as n from block_runs where run_id = ${run.id} and block_key like 'each[%'`)
    return row!.n
  }
  // Kill the worker a third of the way through.
  await waitFor(async () => (await committed()) >= total / 3, 120_000)
  child.kill('SIGKILL')
  await once(child, 'exit')
  const before = await committed()
  expect(before).toBeLessThan(total)

  const pool = new PoolManager({ sweepIntervalMs: 0 })
  const survivor = new Dispatcher({
    db,
    pool,
    resources: postgresResources(url),
    workerId: 'survivor',
    pollIntervalMs: 100,
    reapIntervalMs: 100,
  })
  await survivor.start()
  try {
    const done = await waitForFinish(db, run.id, 180_000)
    expect(done).toMatchObject({ status: 'succeeded', recoveries: 1 })
    const blocks = await blocksOf(db, run.id)
    expect(blocks.each).toMatchObject({ status: 'succeeded' })
    expect(await committed()).toBe(total)

    const [counts] = await db.execute<{ distinct: number; executions: number }>(dsql`
      select count(distinct block)::int as distinct, count(*)::int as executions from hits where run_id = ${run.id}`)
    // Every iteration ran; only those in flight or not yet committed when the worker died ran twice.
    expect(counts!.distinct).toBe(total)
    expect(counts!.executions - total).toBeLessThanOrEqual(total - before)
    expect(counts!.executions - total).toBeLessThan(500)

    const [result] = await db.execute<{ data: boolean; resumed: number }>(dsql`
      select p.data, (b2.metadata->'iterations'->>'resumed')::int as resumed
      from block_runs b join block_run_payloads p on p.block_run_id = b.id
      join block_runs b2 on b2.run_id = b.run_id and b2.block_key = 'each'
      where b.run_id = ${run.id} and b.block_key = 'check'`)
    expect(result).toEqual({ data: true, resumed: before })
  } finally {
    await survivor.stop()
    await pool.closeAll()
  }
}, 300_000)
