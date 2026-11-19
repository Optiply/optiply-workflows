/** Loop iterations on Postgres: committed in batches as `<loop>[<index>]` rows, with progress events. */
import { PoolManager } from '@ow/connectors'
import { blockRunPayloads, blockRuns, type Db } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { and, sql as dsql, eq, like } from 'drizzle-orm'
import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { Dispatcher, RUN_EVENTS_CHANNEL, type RunEvent } from '../src'
import { connect, postgresResources, queueRun, waitForFinish, wf } from './pg-harness'

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

const loop = (input: string, runner: object, extra: object = {}) => ({
  name: 'each',
  type: 'loop',
  config: { input, runner, ...extra },
})

async function iterationRows(runId: string) {
  return db
    .select({
      key: blockRuns.blockKey,
      status: blockRuns.status,
      error: blockRuns.error,
      data: blockRunPayloads.data,
    })
    .from(blockRuns)
    .leftJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
    .where(and(eq(blockRuns.runId, runId), like(blockRuns.blockKey, 'each[%')))
}

it('commits iterations in batches as they finish, with progress events', async () => {
  const events: RunEvent[] = []
  const { unlisten } = await listener.listen(RUN_EVENTS_CHANNEL, (payload) =>
    events.push(JSON.parse(payload)),
  )
  await start()
  const run = await queueRun(
    db,
    wf(
      [
        loop('{{ _.range(450) }}', {
          kind: 'query',
          resource: 'db',
          query: { sql: 'select {{ index }}::int * 2 as v' },
        }),
      ],
      [['startTrigger', 'each']],
    ),
  )
  const done = await waitForFinish(db, run.id)
  await unlisten()
  expect(done.status).toBe('succeeded')

  const rows = await iterationRows(run.id)
  expect(rows).toHaveLength(450)
  expect(rows.every((r) => r.status === 'succeeded')).toBe(true)
  expect(rows.find((r) => r.key === 'each[7]')!.data).toEqual([{ v: 14 }])

  const progress = events.filter((e) => e.runId === run.id && e.type === 'iterations')
  expect(progress.reduce((n, e) => n + (e.type === 'iterations' ? e.count : 0), 0)).toBe(450)
  // Batches of up to 200 (or whatever finished within 250 ms), not one write per iteration (that would be 450). How
  // many batches depends on the machine's speed: 34 on a busy CI runner (2026-11-19), so the bound only rules out
  // writing per iteration.
  expect(progress.length).toBeLessThan(100)
})

it('commits a failed iteration that the loop continues past as errored', async () => {
  await start()
  const run = await queueRun(
    db,
    wf(
      [
        loop(
          '{{ [1, 0, 2] }}',
          { kind: 'query', resource: 'db', query: { sql: 'select 10 / {{ value }}::int as v' } },
          { onError: 'continue' },
        ),
      ],
      [['startTrigger', 'each']],
    ),
  )
  expect((await waitForFinish(db, run.id)).status).toBe('succeeded')
  const rows = Object.fromEntries((await iterationRows(run.id)).map((r) => [r.key, r]))
  expect(rows['each[0]']).toMatchObject({ status: 'succeeded', data: [{ v: 10 }] })
  expect(rows['each[1]']).toMatchObject({
    status: 'errored',
    error: { message: expect.stringContaining('division by zero') },
  })
  expect(rows['each[2]']).toMatchObject({ status: 'succeeded', data: [{ v: 5 }] })
  const [loopRow] = await db.execute<{ status: string }>(
    dsql`select status from block_runs where run_id = ${run.id} and block_key = 'each'`,
  )
  expect(loopRow!.status).toBe('succeeded')
})
