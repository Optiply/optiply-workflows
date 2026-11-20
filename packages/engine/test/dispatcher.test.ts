import { PoolManager } from '@ow/connectors'
import { blockRuns, type Db, runLogs, workflowRuns } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { sql as dsql, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type Claim,
  Dispatcher,
  type DispatcherOptions,
  enqueueRun,
  finishRun,
  LeaseLostError,
  loadCheckpoints,
  PgRunStore,
  type ResourceProvider,
  RUN_EVENTS_CHANNEL,
  type RunEvent,
  reapExpiredLeases,
} from '../src'
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

let db: Db
let listener: postgres.Sql
let resources: ResourceProvider
let pool: PoolManager
let stopDb: () => Promise<void>
const dispatchers: Dispatcher[] = []

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = connect(pg.url)
  db = conn.db
  listener = conn.sql
  resources = postgresResources(pg.url)
  pool = new PoolManager({ sweepIntervalMs: 0 })
  await db.execute(dsql`create table hits (id serial primary key, run_id text not null, block text not null)`)
  stopDb = async () => {
    await pool.closeAll()
    await conn.close()
    await pg.stop()
  }
})
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.stop()))
})
afterAll(() => stopDb?.())

function dispatcher(opts: Partial<DispatcherOptions> = {}) {
  const d = new Dispatcher({
    db,
    listener,
    pool,
    resources,
    pollIntervalMs: 200,
    reapIntervalMs: 100,
    ...opts,
  })
  dispatchers.push(d)
  return d
}

describe('dispatcher', () => {
  it('claims a queued run, checkpoints every block and finishes the run', async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      wf(
        [
          sql('load', 'select {{ startTrigger.data.n }}::int * 2 as v'),
          {
            name: 'check',
            type: 'branch',
            config: { conditions: [{ id: 'big', expression: 'load.data[0].v > 5' }] },
          },
          {
            name: 'shout',
            type: 'code',
            config: { code: 'console.log("big", load.data[0].v); return "BIG"' },
          },
          { name: 'reply', type: 'response', config: { body: '{"v": {{ load.data[0].v }}}' } },
        ],
        [
          ['startTrigger', 'load'],
          ['load', 'check'],
          ['check', 'shout', 'cond:big'],
          ['load', 'reply'],
        ],
      ),
      { data: { n: 21 } },
    )
    const done = await waitForFinish(db, run.id)
    expect(done).toMatchObject({
      status: 'succeeded',
      epoch: 1,
      recoveries: 0,
      leaseOwner: null,
      response: { status: 200, headers: {}, body: { v: 42 } },
    })
    // The run's 15-minute deadline is set when it starts executing, a moment after the claim stamped startedAt (both by
    // the database's clock): at least 15 minutes after the start, and not much more. A busy CI runner once took 545 ms
    // between the two, past `toBeCloseTo`'s ±500 ms.
    const deadlineAfterStart = done.deadlineAt!.getTime() - done.startedAt!.getTime()
    expect(deadlineAfterStart).toBeGreaterThanOrEqual(15 * 60_000)
    expect(deadlineAfterStart).toBeLessThan(15 * 60_000 + 10_000)
    expect(await blocksOf(db, run.id)).toEqual({
      startTrigger: { status: 'succeeded', epoch: 1, attempt: 1, port: 'out' },
      load: { status: 'succeeded', epoch: 1, attempt: 1, port: 'out' },
      check: { status: 'succeeded', epoch: 1, attempt: 1, port: 'cond:big' },
      shout: { status: 'succeeded', epoch: 1, attempt: 1, port: 'out' },
      reply: { status: 'succeeded', epoch: 1, attempt: 1, port: 'out' },
    })
    const payloads = await db.execute<{ block_key: string; data: unknown }>(dsql`
      select b.block_key, p.data from block_run_payloads p join block_runs b on b.id = p.block_run_id
      where b.run_id = ${run.id} order by b.block_key`)
    expect(payloads.find((p) => p.block_key === 'load')!.data).toEqual([{ v: 42 }])
    await waitFor(async () => (await db.select().from(runLogs).where(eq(runLogs.runId, run.id))).length > 0)
    expect(
      await db.select({ message: runLogs.message }).from(runLogs).where(eq(runLogs.runId, run.id)),
    ).toEqual([{ message: 'big 42' }])
  })

  it("gives code the workflow's name and the run's start, as Retool's workflowContext does (M36)", async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      wf(
        [
          {
            name: 'context',
            type: 'code',
            config: {
              code: 'const c = workflowContext; return { name: c.name, id: c.currentRun.id, started: c.currentRun.startedAtEpochMs, runId: c.runId }',
            },
          },
          { name: 'reply', type: 'response', config: { body: '{{ context.data }}' } },
        ],
        [
          ['startTrigger', 'context'],
          ['context', 'reply'],
        ],
      ),
    )
    const done = await waitForFinish(db, run.id)
    expect(done.response).toMatchObject({
      body: { name: 'Test', id: run.id, runId: run.id, started: done.startedAt!.getTime() },
    })
  })

  it('publishes every run and block status change on the run events channel', async () => {
    const events: RunEvent[] = []
    const { unlisten } = await listener.listen(RUN_EVENTS_CHANNEL, (payload) =>
      events.push(JSON.parse(payload)),
    )
    try {
      await dispatcher().start()
      const run = await queueRun(
        db,
        wf(
          [
            { name: 'pick', type: 'branch', config: { conditions: [{ id: 'yes', expression: 'false' }] } },
            hit('onYes'),
            hit('onNo'),
          ],
          [
            ['startTrigger', 'pick'],
            ['pick', 'onYes', 'cond:yes'],
            ['pick', 'onNo', 'else'],
          ],
        ),
      )
      await waitForFinish(db, run.id)
      await waitFor(async () =>
        events.some((e) => e.runId === run.id && e.type === 'run' && e.status === 'succeeded'),
      )
      const mine = events
        .filter((e) => e.runId === run.id)
        .map((e) =>
          e.type === 'run'
            ? `run ${e.status}`
            : e.type === 'block'
              ? `${e.key} ${e.status}${e.port ? ` ${e.port}` : ''}`
              : e.type,
        )
      expect(mine[0]).toBe('run running')
      expect(mine.at(-1)).toBe('run succeeded')
      expect(new Set(mine)).toEqual(
        new Set([
          'run running',
          'startTrigger running',
          'startTrigger succeeded out',
          'pick running',
          'pick succeeded else',
          'onYes skipped',
          'onNo running',
          'onNo succeeded out',
          'run succeeded',
        ]),
      )
      expect(mine).toHaveLength(9)
    } finally {
      await unlisten()
    }
  })

  it('records a failed run with the failing block', async () => {
    await dispatcher().start()
    const run = await queueRun(db, wf([sql('bad', 'select * from nope')], [['startTrigger', 'bad']]))
    const done = await waitForFinish(db, run.id)
    expect(done.status).toBe('failed')
    expect(done.error).toMatchObject({ code: 'query', block: 'bad' })
  })

  it("exposes the caller's idempotency key to code, or the run id when there's none", async () => {
    await dispatcher().start()
    const definition = wf(
      [{ name: 'key', type: 'code', config: { code: 'return idempotencyKey' } }],
      [['startTrigger', 'key']],
    )
    const plain = await queueRun(db, definition)
    const keyed = await queueRun(db, definition, {}, { idempotencyKey: 'order-42' })
    await waitForFinish(db, plain.id)
    await waitForFinish(db, keyed.id)
    const keyOf = async (id: string) => (await loadCheckpoints(db, id)).find((c) => c.key === 'key')!.data
    expect(await keyOf(plain.id)).toBe(plain.id)
    expect(await keyOf(keyed.id)).toBe('order-42')
  })

  it('wakes on NOTIFY rather than waiting for the next poll', async () => {
    await dispatcher({ pollIntervalMs: 60_000 }).start()
    await new Promise((r) => setTimeout(r, 200)) // Let it go idle.
    const started = Date.now()
    const run = await queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))
    await waitForFinish(db, run.id)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('never runs a run twice when several workers compete', async () => {
    await Promise.all([dispatcher({ concurrency: 3 }).start(), dispatcher({ concurrency: 3 }).start()])
    const runs = await Promise.all(
      Array.from({ length: 20 }, () => queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))),
    )
    for (const run of runs) expect((await waitForFinish(db, run.id)).status).toBe('succeeded')
    for (const run of runs) expect(await hitsOf(db, run.id)).toEqual({ a: 1 })
    const owners = await db.execute<{ epoch: number }>(
      dsql`select distinct epoch from workflow_runs where id in ${runs.map((r) => r.id)}`,
    )
    expect(owners).toEqual([{ epoch: 1 }])
  })
})

describe('run block', () => {
  it('runs one block with upstream results seeded from an earlier run', async () => {
    await dispatcher().start()
    const definition = wf(
      [
        hit('load'),
        { name: 'double', type: 'code', config: { code: 'return load.data[0].id * 2' } },
        hit('after'),
      ],
      [
        ['startTrigger', 'load'],
        ['load', 'double'],
        ['double', 'after'],
      ],
    )
    const first = await queueRun(db, definition)
    await waitForFinish(db, first.id)
    const seed = (await loadCheckpoints(db, first.id))
      .filter((c) => c.key === 'startTrigger' || c.key === 'load')
      .map((c) => ({ ...c, metadata: { ...c.metadata, cachedFrom: first.id } }))

    const again = await enqueueRun(
      db,
      {
        workflowId: first.workflowId,
        releaseId: first.releaseId,
        environmentId: first.environmentId,
        triggerType: 'manual',
        targetBlocks: ['double'],
      },
      { seed },
    )
    const done = await waitForFinish(db, again.id)
    expect(done.status).toBe('succeeded')
    // `load` wasn't executed again and `after` didn't run at all.
    expect(await hitsOf(db, again.id)).toEqual({})
    expect(await blocksOf(db, again.id)).toEqual({
      startTrigger: { status: 'succeeded', epoch: 0, attempt: 1, port: 'out' },
      load: { status: 'succeeded', epoch: 0, attempt: 1, port: 'out' },
      double: { status: 'succeeded', epoch: 1, attempt: 1, port: 'out' },
    })
    const loadId = (await loadCheckpoints(db, first.id)).find((c) => c.key === 'load')!.data as {
      id: number
    }[]
    expect((await loadCheckpoints(db, again.id)).find((c) => c.key === 'double')!.data).toBe(
      loadId[0]!.id * 2,
    )
  })
})

describe('fencing', () => {
  it('fences off a zombie worker: its late writes are rejected and the new owner finishes the run', async () => {
    // Worker A hangs (stops renewing) in the middle of a slow block. Its lease expires, B recovers and takes
    // the run over, and when A's block finally returns, A's writes must all be rejected.
    const zombieLog: { msg?: string; obj: object }[] = []
    const record = (obj: object, msg?: string) => zombieLog.push({ obj, msg })
    const zombie = dispatcher({
      workerId: 'zombie',
      leaseMs: 400,
      renewLeases: false,
      reapIntervalMs: 60_000,
      log: { info: record, warn: record, error: record },
    })
    await zombie.start()
    const run = await queueRun(
      db,
      wf(
        [sql('slow', 'select pg_sleep(1.5), {{ workflowContext.runId }} as r'), hit('after')],
        [
          ['startTrigger', 'slow'],
          ['slow', 'after'],
        ],
      ),
    )
    await waitFor(async () => (await blocksOf(db, run.id)).slow?.status === 'running')
    await zombie.drain()

    const rescuer = dispatcher({ workerId: 'rescuer', leaseMs: 5000, reapIntervalMs: 100 })
    await rescuer.start()
    const done = await waitForFinish(db, run.id)

    expect(done).toMatchObject({ status: 'succeeded', recoveries: 1, epoch: 3 })
    expect(await hitsOf(db, run.id)).toEqual({ after: 1 })
    expect(await blocksOf(db, run.id)).toMatchObject({
      slow: { status: 'succeeded', epoch: 3 },
      after: { status: 'succeeded', epoch: 3 },
    })
    // A's own block finished after the takeover; its commit was refused and it never ran `after`.
    await waitFor(async () => zombie.activeRuns.length === 0)
    expect(zombieLog).toContainEqual({
      msg: 'run interrupted',
      obj: {
        runId: run.id,
        error: expect.objectContaining({ message: `Lost the lease on run ${run.id} (epoch 1)` }),
      },
    })

    // The same holds for any write at the old epoch.
    const stale: Claim = { runId: run.id, epoch: 1 }
    const store = new PgRunStore(db, stale)
    await expect(store.blockStarted('after', 1, new Date())).rejects.toBeInstanceOf(LeaseLostError)
    await expect(
      store.blockFinished({
        key: 'after',
        status: 'failed',
        data: null,
        sizeBytes: 0,
        error: { code: 'x', message: 'zombie' },
        metadata: {},
        port: null,
        attempt: 1,
        startedAt: null,
        finishedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect(await finishRun(db, stale, { status: 'failed', error: null })).toBe(false)
    expect(await getRun(db, run.id)).toMatchObject({ status: 'succeeded', epoch: 3 })
  })

  it('never overwrites a committed result, even from the lease that wrote it', async () => {
    const run = await queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))
    await db
      .update(workflowRuns)
      .set({ status: 'running', leaseOwner: 'test', leaseExpiresAt: new Date(Date.now() + 60_000), epoch: 1 })
      .where(eq(workflowRuns.id, run.id))
    const store = new PgRunStore(db, { runId: run.id, epoch: 1 })
    const result = (data: unknown) => ({
      key: 'a',
      status: 'succeeded' as const,
      data,
      sizeBytes: JSON.stringify(data).length,
      error: null,
      metadata: {},
      port: 'out',
      attempt: 1,
      startedAt: null,
      finishedAt: new Date(),
    })
    await store.blockFinished(result('first'))
    await store.blockFinished(result('second'))
    await store.blockStarted('a', 2, new Date())
    const [committed] = await loadCheckpoints(db, run.id)
    expect(committed).toMatchObject({ key: 'a', status: 'succeeded', data: 'first', attempt: 1 })
  })

  it('recovers runs whose lease expired and fails one that keeps losing its worker', async () => {
    const run = await queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))
    const loseWorker = () =>
      db
        .update(workflowRuns)
        .set({ status: 'running', leaseOwner: 'ghost', leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(workflowRuns.id, run.id))
    await db.insert(blockRuns).values({ runId: run.id, blockKey: 'a', status: 'running', epoch: 0 })

    for (let i = 1; i <= 3; i++) {
      await loseWorker()
      expect(await reapExpiredLeases(db, 3)).toEqual({ requeued: [run.id], failed: [], cancelled: [] })
      expect(await getRun(db, run.id)).toMatchObject({
        status: 'queued',
        recoveries: i,
        epoch: i,
        leaseOwner: null,
      })
    }
    expect((await blocksOf(db, run.id)).a!.status).toBe('interrupted')

    await loseWorker()
    expect(await reapExpiredLeases(db, 3)).toEqual({ requeued: [], failed: [run.id], cancelled: [] })
    const failed = await getRun(db, run.id)
    expect(failed).toMatchObject({ status: 'failed', recoveries: 3, error: { code: 'worker_lost' } })
    expect(failed.finishedAt).not.toBeNull()
  })

  it('hands in-flight runs back on shutdown without counting a recovery', async () => {
    const first = dispatcher({ workerId: 'first' })
    await first.start()
    const run = await queueRun(
      db,
      wf(
        [hit('before'), sql('slow', 'select pg_sleep(5)'), hit('after')],
        [
          ['startTrigger', 'before'],
          ['before', 'slow'],
          ['slow', 'after'],
        ],
      ),
    )
    await waitFor(async () => (await blocksOf(db, run.id)).slow?.status === 'running')
    await first.stop()
    expect(await getRun(db, run.id)).toMatchObject({ status: 'queued', recoveries: 0, epoch: 2 })

    await dispatcher({ workerId: 'second' }).start()
    const done = await waitForFinish(db, run.id)
    expect(done).toMatchObject({ status: 'succeeded', recoveries: 0, epoch: 3 })
    expect(await hitsOf(db, run.id)).toEqual({ before: 1, after: 1 })
  })
})
