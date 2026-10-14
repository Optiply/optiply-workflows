import { PoolManager } from '@ow/connectors'
import { type Db, environments, workflowReleases, workflowRuns, workflows } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InlineRunner, type RunResponse, startRun } from '../src'
import { connect, getRun, postgresResources, waitFor, wf } from './pg-harness'

let db: Db
let pool: PoolManager
let prodId: string
let url: string
let stopDb: () => Promise<void>

beforeAll(async () => {
  const pg = await startTestDatabase()
  url = pg.url
  const conn = connect(pg.url)
  db = conn.db
  pool = new PoolManager({ sweepIntervalMs: 0 })
  prodId = (await db.select().from(environments).where(eq(environments.slug, 'production')))[0]!.id
  stopDb = async () => {
    await pool.closeAll()
    await conn.close()
    await pg.stop()
  }
})
afterAll(() => stopDb?.())

let n = 0
async function release(
  definition = wf(
    [{ name: 'reply', type: 'response', config: { body: '"hi"' } }],
    [['startTrigger', 'reply']],
  ),
  limit?: number,
) {
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `inline_${++n}`, name: 'Inline', draftDefinition: definition, maxConcurrentRuns: limit })
    .returning()
  const [rel] = await db
    .insert(workflowReleases)
    .values({ workflowId: workflow!.id, version: '1.0.0', definition, definitionHash: 'b'.repeat(64) })
    .returning()
  const values = {
    workflowId: workflow!.id,
    releaseId: rel!.id,
    environmentId: prodId,
    triggerType: 'webhook' as const,
    input: { data: null },
  }
  return values
}

const runner = (concurrency = 8) =>
  new InlineRunner({ db, pool, resources: postgresResources(url), concurrency, workerId: 'api-test' })

describe('startRun', () => {
  it('claims the run for the caller, or queues it when the workflow is at its limit', async () => {
    const values = await release(undefined, 1)
    const first = await startRun(db, values, { claimAs: { workerId: 'api', leaseMs: 30_000 } })
    expect(first.claim).toEqual({ runId: first.run.id, epoch: 1 })
    expect(first.run).toMatchObject({ status: 'running', leaseOwner: 'api', epoch: 1 })
    const second = await startRun(db, values, { claimAs: { workerId: 'api', leaseMs: 30_000 } })
    expect(second.claim).toBeNull()
    expect(second.run.status).toBe('queued')
  })

  it('returns the earlier run for a repeated idempotency key', async () => {
    const values = { ...(await release()), idempotencyKey: 'k-1' }
    const [a, b] = await Promise.all([startRun(db, values), startRun(db, values)])
    expect(a.run.id).toBe(b.run.id)
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, 'k-1'))).toHaveLength(1)
  })
})

describe('InlineRunner', () => {
  it('executes a run in-process and reports its reply as soon as it is recorded', async () => {
    const r = runner()
    const responses: RunResponse[] = []
    let done = false
    const { run, claim } = await r.start(await release(), {
      onResponse: (res) => responses.push(res),
      onDone: () => {
        done = true
      },
    })
    expect(claim).not.toBeNull()
    await waitFor(async () => done)
    expect(responses).toEqual([{ status: 200, headers: {}, body: 'hi' }])
    expect(await getRun(db, run.id)).toMatchObject({ status: 'succeeded', leaseOwner: null })
    await r.stop()
  })

  it('queues runs for the workers when it has no free slot', async () => {
    const r = runner(0)
    const { run, claim } = await r.start(await release())
    expect(claim).toBeNull()
    expect((await getRun(db, run.id)).status).toBe('queued')
    await r.stop()
  })

  it('hands in-flight runs back to the queue when it stops', async () => {
    const slow = wf(
      [
        {
          name: 'spin',
          type: 'code',
          config: { code: 'const t = Date.now(); while (Date.now() - t < 3000) {} return 1' },
        },
      ],
      [['startTrigger', 'spin']],
    )
    const r = runner()
    const { run } = await r.start(await release(slow))
    await waitFor(async () => (await getRun(db, run.id)).status === 'running' && r.activeRuns.length === 1)
    await r.stop()
    const back = await getRun(db, run.id)
    // Handed back without counting a recovery, for a worker to resume.
    expect(back).toMatchObject({ status: 'queued', leaseOwner: null, recoveries: 0 })
  })
})
