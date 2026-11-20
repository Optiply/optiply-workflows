/**
 * Waits, the run timeout and cancel on Postgres: runs pause and free their worker, resume on time (on any worker,
 * after a restart), don't spend their timeout while waiting, and stop when cancelled, aborting in-flight SQL and
 * fetches.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CodeFetcher, PoolManager } from '@ow/connectors'
import { blockRuns, type Db, workflowRuns } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { sql as dsql, eq } from 'drizzle-orm'
import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelRun,
  Dispatcher,
  type DispatcherOptions,
  type ResourceProvider,
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
let fetcher: CodeFetcher
let server: Server
let origin: string
/** Requests to /slow still open. */
let openRequests = 0
let stopAll: () => Promise<void>
const dispatchers: Dispatcher[] = []

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = connect(pg.url)
  db = conn.db
  listener = conn.sql
  resources = postgresResources(pg.url)
  pool = new PoolManager({ sweepIntervalMs: 0 })
  fetcher = new CodeFetcher({ allowPrivateNetwork: true })
  await db.execute(dsql`create table hits (id serial primary key, run_id text not null, block text not null)`)
  server = createServer((_req, res) => {
    openRequests++
    const timer = setTimeout(() => res.end('late'), 30_000)
    res.on('close', () => {
      openRequests--
      clearTimeout(timer)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  stopAll = async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fetcher.close()
    await pool.closeAll()
    await conn.close()
    await pg.stop()
  }
})
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.stop()))
})
afterAll(() => stopAll?.())

function dispatcher(opts: Partial<DispatcherOptions> = {}) {
  const d = new Dispatcher({
    db,
    listener,
    pool,
    resources,
    fetcher,
    pollIntervalMs: 100,
    reapIntervalMs: 100,
    ...opts,
  })
  dispatchers.push(d)
  return d
}

const pause = (name: string, seconds: number) => ({
  name,
  type: 'wait',
  config: { kind: 'duration', amount: String(seconds), unit: 'seconds' },
})

const waitForStatus = (id: string, status: string) =>
  waitFor(async () => {
    const run = await getRun(db, id)
    return run.status === status && run
  })

/** Active backends running `text` (the test database is the resource, so its queries show up here). */
async function activeQueries(text: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(dsql`
    select count(*)::int as n from pg_stat_activity
    where state = 'active' and query like ${`%${text}%`} and query not like '%pg_stat_activity%'`)
  return row!.n
}

describe('waiting', () => {
  it('pauses at a wait, frees its slot for other runs, and resumes on time', async () => {
    await dispatcher({ concurrency: 1 }).start()
    const waiting = await queueRun(
      db,
      wf(
        [pause('pause', 2), hit('after')],
        [
          ['startTrigger', 'pause'],
          ['pause', 'after'],
        ],
      ),
    )
    const paused = await waitForStatus(waiting.id, 'waiting')
    expect(paused).toMatchObject({ leaseOwner: null, leaseExpiresAt: null })
    expect(paused.suspendedAt).not.toBeNull()
    const rows = await db.select().from(blockRuns).where(eq(blockRuns.runId, waiting.id))
    expect(rows.find((r) => r.blockKey === 'pause')!.metadata).toEqual({ until: expect.any(String) })
    const pausedBlocks = await blocksOf(db, waiting.id)
    expect(pausedBlocks.pause!.status).toBe('waiting')

    // The only slot is free while it waits: another run starts before the wait ends. (Checked by when it started, not
    // by the first run still waiting once the other finished: on a slow CI runner the other run once outlasted the
    // 2 s wait, and the first had rightly resumed by then.)
    const until = new Date((rows.find((r) => r.blockKey === 'pause')!.metadata as { until: string }).until)
    const other = await queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))
    const otherDone = await waitForFinish(db, other.id)
    expect(otherDone.status).toBe('succeeded')
    expect(otherDone.startedAt!.getTime()).toBeLessThan(until.getTime())

    const done = await waitForFinish(db, waiting.id)
    expect(done.status).toBe('succeeded')
    expect(done.finishedAt!.getTime() - done.startedAt!.getTime()).toBeGreaterThanOrEqual(1900)
    // Claimed, paused (which fences the old lease off) and claimed again.
    expect(done.epoch).toBe(3)
    expect(done.suspendedAt).toBeNull()
    // Waiting doesn't count: the deadline moved on by the time spent waiting.
    expect(done.deadlineAt!.getTime() - done.startedAt!.getTime()).toBeGreaterThan(15 * 60_000 + 1500)
    expect(await hitsOf(db, waiting.id)).toEqual({ after: 1 })
    const blocks = await blocksOf(db, waiting.id)
    expect(blocks.pause).toMatchObject({ status: 'succeeded', attempt: 1 })
  })

  it('survives every worker stopping, and resumes on the next one', async () => {
    const first = dispatcher()
    await first.start()
    const run = await queueRun(
      db,
      wf(
        [hit('before'), pause('pause', 2), hit('after')],
        [
          ['startTrigger', 'before'],
          ['before', 'pause'],
          ['pause', 'after'],
        ],
      ),
    )
    await waitForStatus(run.id, 'waiting')
    await first.stop()

    await new Promise((r) => setTimeout(r, 2200))
    expect((await getRun(db, run.id)).status).toBe('waiting')
    await dispatcher().start()
    expect((await waitForFinish(db, run.id)).status).toBe('succeeded')
    expect(await hitsOf(db, run.id)).toEqual({ before: 1, after: 1 })
  })

  it("doesn't count time spent waiting toward the run timeout", async () => {
    await dispatcher().start()
    const definition = {
      ...wf(
        [pause('pause', 2.5), hit('after')],
        [
          ['startTrigger', 'pause'],
          ['pause', 'after'],
        ],
      ),
      settings: { timeoutMs: 1500 },
    }
    const run = await queueRun(db, definition)
    const done = await waitForFinish(db, run.id)
    expect(done).toMatchObject({ status: 'succeeded', error: null })
    expect(await hitsOf(db, run.id)).toEqual({ after: 1 })
  })
})

describe('cancel', () => {
  it('stops a running run, cancelling its SQL in Postgres', async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      wf(
        [sql('sleep', 'select pg_sleep(30)', { timeoutMs: 60_000 }), hit('after')],
        [
          ['startTrigger', 'sleep'],
          ['sleep', 'after'],
        ],
      ),
    )
    await waitFor(async () => (await activeQueries('pg_sleep(30)')) === 1)
    const started = Date.now()
    expect(await cancelRun(db, run.id)).toBe('requested')

    const done = await waitForFinish(db, run.id)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(done).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' }, leaseOwner: null })
    expect(done.cancelRequestedAt).not.toBeNull()
    expect((await blocksOf(db, run.id)).sleep!.status).toBe('cancelled')
    await waitFor(async () => (await activeQueries('pg_sleep(30)')) === 0, 3000)
    expect(await hitsOf(db, run.id)).toEqual({})
    expect(await cancelRun(db, run.id)).toBe('finished')
  })

  it('aborts an in-flight fetch', async () => {
    await dispatcher().start()
    const run = await queueRun(
      db,
      wf(
        [
          {
            name: 'call',
            type: 'code',
            config: { code: `return await (await fetch("${origin}/slow")).text()` },
            settings: { timeoutMs: 60_000 },
          },
        ],
        [['startTrigger', 'call']],
      ),
    )
    await waitFor(async () => openRequests === 1)
    expect(await cancelRun(db, run.id)).toBe('requested')
    expect(await waitForFinish(db, run.id)).toMatchObject({ status: 'cancelled' })
    await waitFor(async () => openRequests === 0, 3000)
  })

  it('notices a cancel through the lease when the NOTIFY is missed', async () => {
    await dispatcher({ listener: undefined, leaseMs: 900 }).start()
    const run = await queueRun(
      db,
      wf([sql('sleep', 'select pg_sleep(20)', { timeoutMs: 60_000 })], [['startTrigger', 'sleep']]),
    )
    await waitFor(async () => (await activeQueries('pg_sleep(20)')) === 1)
    expect(await cancelRun(db, run.id)).toBe('requested')
    expect(await waitForFinish(db, run.id, 3000)).toMatchObject({ status: 'cancelled' })
  })

  it('cancels queued and waiting runs at once', async () => {
    const queued = await queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))
    expect(await cancelRun(db, queued.id)).toBe('cancelled')
    expect(await getRun(db, queued.id)).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } })

    await dispatcher().start()
    const waiting = await queueRun(db, wf([pause('pause', 60)], [['startTrigger', 'pause']]))
    await waitForStatus(waiting.id, 'waiting')
    expect(await cancelRun(db, waiting.id)).toBe('cancelled')
    expect(await getRun(db, waiting.id)).toMatchObject({ status: 'cancelled', suspendedAt: null })
    expect((await blocksOf(db, waiting.id)).pause!.status).toBe('cancelled')

    expect(await cancelRun(db, '00000000-0000-7000-8000-000000000000')).toBe('not_found')
  })

  it('cancels a run whose worker died after the cancel was requested', async () => {
    const run = await queueRun(db, wf([hit('a')], [['startTrigger', 'a']]))
    await db
      .update(workflowRuns)
      .set({
        status: 'running',
        leaseOwner: 'ghost',
        leaseExpiresAt: new Date(Date.now() - 1000),
        cancelRequestedAt: new Date(),
      })
      .where(eq(workflowRuns.id, run.id))
    expect(await reapExpiredLeases(db, 3)).toEqual({ requeued: [], failed: [], cancelled: [run.id] })
    expect(await getRun(db, run.id)).toMatchObject({ status: 'cancelled', leaseOwner: null })
  })
})
