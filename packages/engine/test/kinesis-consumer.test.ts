import { configureAws, kinesisConnector } from '@ow/connectors'
import { type FakeAws, type FakeAwsKey, startFakeAws } from '@ow/connectors/testing'
import {
  type Db,
  environments,
  kinesisCheckpoints,
  queueDeliveries,
  workflowReleases,
  workflowRuns,
  workflows,
  workflowTriggers,
} from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { and, asc, sql as dsql, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { QueueConsumer, type QueueConsumerOptions, type ResourceProvider } from '../src'
import type { KinesisRunMessage } from '../src/types'
import { connect, wf } from './pg-harness'

// The consumer's Kinesis adapter (M30 step 4) against Postgres and the fake AWS. Runs aren't executed: a test ends
// them. Backoffs are counted in 50 ms "seconds".
let db: Db
let prodId: string
let stopDb: () => Promise<void>
let aws: FakeAws
let user: FakeAwsKey
const consumers: QueueConsumer[] = []

const resources: ResourceProvider = {
  async resolve(slug, environmentId) {
    return {
      connector: kinesisConnector,
      resource: {
        id: `${slug}-${environmentId}`,
        resourceId: slug,
        environmentId,
        version: '1',
        config: { region: 'eu-west-1', identity: 'key', accessKeyId: user.accessKeyId },
        secrets: { secretAccessKey: user.secretAccessKey },
      },
    }
  },
}

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = connect(pg.url)
  db = conn.db
  prodId = (await db.select().from(environments)).find((e) => e.slug === 'production')!.id
  aws = await startFakeAws()
  user = aws.addUser('reader')
  configureAws({ stsEndpoint: aws.url, kinesisEndpoint: aws.url })
  stopDb = async () => {
    await conn.close()
    await pg.stop()
  }
})
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()))
  await db.execute(dsql`truncate workflow_runs, workflow_triggers cascade`)
})
afterAll(async () => {
  configureAws({})
  await aws?.close()
  await stopDb?.()
})

const definition = wf([{ name: 'a', type: 'code', config: { code: 'return 1' } }], [['startTrigger', 'a']])
let n = 0

async function streamed(opts: { shards?: number; maxAttempts?: number; maxInFlight?: number } = {}) {
  const i = ++n
  const stream = `events-${i}`
  aws.kinesis.createStream(stream, opts.shards ?? 1)
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `kin_${i}`, name: 'Kinesis', draftDefinition: definition })
    .returning()
  const [release] = await db
    .insert(workflowReleases)
    .values({ workflowId: workflow!.id, version: '1.0.0', definition, definitionHash: 'a'.repeat(64) })
    .returning()
  const [trigger] = await db
    .insert(workflowTriggers)
    .values({
      workflowId: workflow!.id,
      releaseId: release!.id,
      kind: 'kinesis',
      name: 'events',
      config: {
        name: 'events',
        enabled: true,
        resource: 'streams',
        stream,
        startAt: 'trimHorizon',
        maxInFlight: opts.maxInFlight ?? 4,
        maxAttempts: opts.maxAttempts ?? 3,
        retryBackoffSeconds: 1,
        maxHoldMinutes: 60,
      },
      environmentId: prodId,
    })
    .returning()
  return { stream, trigger: trigger! }
}

function consumer(workerId = 'w1', over: Partial<QueueConsumerOptions> = {}) {
  const c = new QueueConsumer({
    db,
    resources,
    workerId,
    intervalMs: 100,
    leaseMs: 30_000,
    retryMs: 50,
    checkMs: 50,
    extendEveryMs: 200,
    backoffSecondMs: 50,
    ...over,
  })
  consumers.push(c)
  return c
}

const runsOf = (triggerId: string) =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.triggerId, triggerId))
    .orderBy(asc(workflowRuns.createdAt))
const end = (runId: string, status: 'succeeded' | 'failed') =>
  db.update(workflowRuns).set({ status, finishedAt: new Date() }).where(eq(workflowRuns.id, runId))
const messageOf = (run: { input: unknown }) => (run.input as { message: KinesisRunMessage }).message
const dataOf = (run: { input: unknown }) => (run.input as { data: unknown }).data
const poll = { timeout: 10_000 }
/** Ends every queued run of the trigger, as it comes, until `count` have ended. */
async function endAll(triggerId: string, count: number, status: 'succeeded' | 'failed' = 'succeeded') {
  const ended = new Set<string>()
  await expect
    .poll(async () => {
      for (const r of await runsOf(triggerId))
        if (r.status === 'queued' && !ended.has(r.id)) {
          await end(r.id, status)
          ended.add(r.id)
        }
      return ended.size
    }, poll)
    .toBeGreaterThanOrEqual(count)
}

describe('QueueConsumer: Kinesis', () => {
  it('runs a shard’s records one at a time, in order, and carries on from the checkpoint after a restart', async () => {
    const { stream, trigger } = await streamed()
    for (let i = 1; i <= 3; i++) aws.kinesis.put(stream, `{"n": ${i}}`, 'order-7')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, poll).toBe(1)
    await new Promise((r) => setTimeout(r, 300))
    // One at a time: the next waits for the first run to end.
    expect(await runsOf(trigger.id)).toHaveLength(1)
    await endAll(trigger.id, 3)
    const runs = await runsOf(trigger.id)
    expect(runs.map(dataOf)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(messageOf(runs[0]!)).toMatchObject({ stream, partitionKey: 'order-7', attempt: 1 })
    const [cp] = await db
      .select()
      .from(kinesisCheckpoints)
      .where(eq(kinesisCheckpoints.triggerId, trigger.id))
    await expect
      .poll(
        async () =>
          (await db.select().from(kinesisCheckpoints).where(eq(kinesisCheckpoints.triggerId, trigger.id)))[0]
            ?.sequenceNumber,
        poll,
      )
      .toBe(messageOf(runs[2]!).sequenceNumber)
    expect(cp).toBeTruthy()

    // A restart (another worker) reads on from the checkpoint: no record runs twice.
    await Promise.all(consumers.splice(0).map((c) => c.stop()))
    aws.kinesis.put(stream, '{"n": 4}', 'order-7')
    consumer('w2').start()
    await endAll(trigger.id, 1)
    expect((await runsOf(trigger.id)).map(dataOf)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
  })

  it('retries a failed record before the ones after it, then skips it after its attempts', async () => {
    const { stream, trigger } = await streamed({ maxAttempts: 2 })
    aws.kinesis.put(stream, 'bad', 'k')
    aws.kinesis.put(stream, 'good', 'k')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, poll).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'failed')
    // Run again (attempt 2), still before "good".
    await expect.poll(async () => (await runsOf(trigger.id)).length, poll).toBe(2)
    const second = (await runsOf(trigger.id))[1]!
    expect([dataOf(second), messageOf(second).attempt]).toEqual(['bad', 2])
    await end(second.id, 'failed')
    // Skipped: the shard moves on.
    await expect.poll(async () => (await runsOf(trigger.id)).length, poll).toBe(3)
    expect(dataOf((await runsOf(trigger.id))[2]!)).toBe('good')
    const [delivery] = await db
      .select()
      .from(queueDeliveries)
      .where(
        and(
          eq(queueDeliveries.triggerId, trigger.id),
          eq(queueDeliveries.messageId, `${messageOf(second).shardId}/${messageOf(second).sequenceNumber}`),
        ),
      )
    expect(delivery).toMatchObject({ outcome: 'dropped', runs: 2 })
  })

  it('reads a split shard to its end before its children, and shards side by side', async () => {
    const { stream, trigger } = await streamed({ shards: 1, maxInFlight: 4 })
    const [parent] = aws.kinesis.shards(stream)
    aws.kinesis.put(stream, 'before split', 'a')
    const [left, right] = aws.kinesis.split(stream, parent!.id)
    // Keys landing on each child (by MD5), so both children have a record.
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) aws.kinesis.put(stream, `after ${key}`, key)
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, poll).toBe(1)
    expect(dataOf((await runsOf(trigger.id))[0]!)).toBe('before split')
    await new Promise((r) => setTimeout(r, 300))
    // The children wait for the parent's record.
    expect(await runsOf(trigger.id)).toHaveLength(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    // Then both children run at once (one record each at a time).
    await expect
      .poll(async () => (await runsOf(trigger.id)).filter((r) => r.status === 'queued').length, poll)
      .toBe(2)
    const shardsRunning = new Set(
      (await runsOf(trigger.id)).filter((r) => r.status === 'queued').map((r) => messageOf(r).shardId),
    )
    expect(shardsRunning).toEqual(new Set([left, right]))
    await endAll(trigger.id, 8)
    expect((await runsOf(trigger.id)).length).toBe(9)
    const finished = await db
      .select()
      .from(kinesisCheckpoints)
      .where(and(eq(kinesisCheckpoints.triggerId, trigger.id), eq(kinesisCheckpoints.shardId, parent!.id)))
    expect(finished[0]?.finished).toBe(true)
  })
})
