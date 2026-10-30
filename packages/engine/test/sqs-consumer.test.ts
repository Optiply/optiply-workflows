import { configureAws, sqsConnector } from '@ow/connectors'
import { type FakeAws, type FakeAwsKey, startFakeAws } from '@ow/connectors/testing'
import {
  type Db,
  environments,
  queueDeliveries,
  workflowReleases,
  workflowRuns,
  workflows,
  workflowTriggers,
} from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { and, asc, sql as dsql, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { QueueConsumer, type QueueConsumerOptions, queueStats, type ResourceProvider } from '../src'
import type { SqsRunMessage } from '../src/types'
import { connect, wf } from './pg-harness'

// The consumer's SQS adapter (M26 step 2c) against Postgres and the fake AWS, where an SQS second lasts 50 ms (a
// queue's 2 s visibility timeout passes in 100 ms). Runs aren't executed here: they stay queued, i.e. under way.
let db: Db
let prodId: string
let stopDb: () => Promise<void>
let aws: FakeAws
let user: FakeAwsKey
const consumers: QueueConsumer[] = []

const resources: ResourceProvider = {
  async resolve(slug, environmentId) {
    return {
      connector: sqsConnector,
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
  aws = await startFakeAws({ sqs: { secondMs: 50 } })
  user = aws.addUser('consumer')
  configureAws({ stsEndpoint: aws.url, sqsEndpoint: aws.url })
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

/** A queue of its own, and a workflow whose live release has an SQS trigger on it. */
async function queued(
  opts: { fifo?: boolean; maxInFlight?: number; visibilityTimeout?: number; maxReceiveCount?: number } = {},
) {
  const i = ++n
  const queue = `jobs-${i}${opts.fifo ? '.fifo' : ''}`
  const dlq = `jobs-${i}-dlq${opts.fifo ? '.fifo' : ''}`
  aws.sqs.createQueue(dlq)
  aws.sqs.createQueue(queue, {
    visibilityTimeout: opts.visibilityTimeout ?? 30,
    ...(opts.maxReceiveCount
      ? { redrive: { deadLetterQueue: dlq, maxReceiveCount: opts.maxReceiveCount } }
      : {}),
  })
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `queued_${i}`, name: 'Queued', draftDefinition: definition })
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
      kind: 'sqs',
      name: 'jobs',
      config: {
        name: 'jobs',
        enabled: true,
        resource: 'queues',
        queue,
        maxInFlight: opts.maxInFlight ?? 4,
        maxHoldMinutes: 60,
      },
      environmentId: prodId,
    })
    .returning()
  let dedup = 0
  return {
    queue,
    dlq,
    trigger: trigger!,
    send: (body: string, m: { attributes?: Record<string, string>; groupId?: string } = {}) =>
      aws.sqs.send(queue, body, { ...m, ...(opts.fifo ? { deduplicationId: String(++dedup) } : {}) }),
    message: (id: string) => aws.sqs.messages(queue).find((m) => m.messageId === id)!,
  }
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
const end = (runId: string, status: 'succeeded' | 'failed' | 'cancelled') =>
  db.update(workflowRuns).set({ status, finishedAt: new Date() }).where(eq(workflowRuns.id, runId))
const messageOf = (run: { input: unknown }) => (run.input as { message: SqsRunMessage }).message
const runFor = async (triggerId: string, messageId: string) =>
  (await runsOf(triggerId)).filter((r) => messageOf(r).messageId === messageId).at(-1)!
const delivery = async (triggerId: string, messageId: string) =>
  (
    await db
      .select()
      .from(queueDeliveries)
      .where(and(eq(queueDeliveries.triggerId, triggerId), eq(queueDeliveries.messageId, messageId)))
  )[0]!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('QueueConsumer: SQS', () => {
  it('starts a run per message with its body and attributes, and deletes it when the run succeeds', async () => {
    const { trigger, send, queue, message } = await queued()
    const id = send('{"order": 7}', { attributes: { kind: 'created' } })
    const before = { ...queueStats.sqs }
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    const [run] = await runsOf(trigger.id)
    expect(run).toMatchObject({ triggerType: 'sqs', idempotencyKey: `sqs:${trigger.id}:${id}:1` })
    expect((run!.input as { data: unknown }).data).toEqual({ order: 7 })
    expect(messageOf(run!)).toMatchObject({
      messageId: id,
      queue: aws.sqs.queueUrl(queue),
      messageAttributes: { kind: 'created' },
      receiveCount: 1,
      sentAt: expect.any(String),
    })
    await end(run!.id, 'succeeded')
    await expect.poll(() => message(id).deleted).toBe(true)
    expect(await delivery(trigger.id, id)).toMatchObject({ outcome: 'succeeded', runs: 1 })
    expect(queueStats.sqs.acked - before.acked).toBe(1)
  })

  it('hands a failed message back to the queue: run again, then to the dead-letter queue by the redrive policy', async () => {
    const { trigger, send, dlq } = await queued({ maxReceiveCount: 2 })
    const flaky = send('flaky')
    const broken = send('broken')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(2)
    await end((await runFor(trigger.id, flaky)).id, 'failed')
    await end((await runFor(trigger.id, broken)).id, 'failed')
    // Visible again at once: received a second time and run again.
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(4)
    expect(messageOf(await runFor(trigger.id, flaky))).toMatchObject({ receiveCount: 2 })
    await end((await runFor(trigger.id, flaky)).id, 'succeeded')
    await end((await runFor(trigger.id, broken)).id, 'cancelled')
    // Past 2 receives, SQS moves it to the dead-letter queue instead of handing it out a third time.
    await expect.poll(() => aws.sqs.messages(dlq).map((m) => m.body), { timeout: 5000 }).toEqual(['broken'])
    expect(await runsOf(trigger.id)).toHaveLength(4)
    expect(await delivery(trigger.id, flaky)).toMatchObject({ outcome: 'succeeded', runs: 2 })
  })

  it('keeps a message whose run outlasts the visibility timeout: no second receive', async () => {
    const { trigger, send, message } = await queued({ visibilityTimeout: 2 })
    const id = send('slow')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    // 2 s of SQS time is 100 ms here: ten timeouts pass while the run lasts.
    await sleep(1_000)
    expect(message(id).receiveCount).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(() => message(id).deleted).toBe(true)
  })

  it('runs a FIFO group one message at a time, in order, other groups alongside', async () => {
    const { trigger, send } = await queued({ fifo: true })
    const a1 = send('a1', { groupId: 'a' })
    const a2 = send('a2', { groupId: 'a' })
    const b1 = send('b1', { groupId: 'b' })
    consumer().start()
    await expect
      .poll(async () => (await runsOf(trigger.id)).map((r) => messageOf(r).messageId))
      .toEqual([a1, b1])
    await sleep(300)
    expect(await runsOf(trigger.id)).toHaveLength(2)
    await end((await runFor(trigger.id, a1)).id, 'succeeded')
    await expect
      .poll(async () => (await runsOf(trigger.id)).map((r) => messageOf(r).messageId))
      .toEqual([a1, b1, a2])
    expect(messageOf(await runFor(trigger.id, a2))).toMatchObject({
      groupId: 'a',
      sequenceNumber: expect.any(String),
    })
  })

  it('keeps to maxInFlight', async () => {
    const { trigger, send } = await queued({ maxInFlight: 1 })
    send('one')
    send('two')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    await sleep(300)
    expect(await runsOf(trigger.id)).toHaveLength(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(2)
  })

  it('deletes without a run a message SQS hands out again after its run succeeded (a lost delete)', async () => {
    const { trigger, send, queue, message } = await queued()
    const id = send('once')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(() => message(id).deleted).toBe(true)
    const duplicates = queueStats.sqs.duplicate
    aws.sqs.redeliver(queue, id)
    await expect.poll(() => queueStats.sqs.duplicate - duplicates).toBe(1)
    await expect.poll(() => message(id).deleted).toBe(true)
    expect(await runsOf(trigger.id)).toHaveLength(1)
  })

  it('hands held messages back when its worker stops: the next holds them for the same run and deletes them', async () => {
    const { trigger, send, message } = await queued()
    const id = send('handed over')
    const one = consumer('w1')
    one.start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    await one.stop()
    const two = consumer('w2')
    two.start()
    await expect.poll(() => two.stats.inFlight, { timeout: 5000 }).toBe(1)
    expect(message(id).receiveCount).toBeGreaterThanOrEqual(2)
    expect(await runsOf(trigger.id)).toHaveLength(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(() => message(id).deleted).toBe(true)
  })

  it('reports a queue that is not there on the trigger, and picks it up once it is', async () => {
    const { trigger } = await queued()
    const queue = `late-${n}`
    await db
      .update(workflowTriggers)
      .set({ config: { ...(trigger.config as object), queue } })
      .where(eq(workflowTriggers.id, trigger.id))
    const warnings: string[] = []
    consumer('w1', { log: { info: () => {}, warn: (_o, msg) => warnings.push(msg ?? '') } }).start()
    await expect.poll(() => warnings.includes('sqs pull failed')).toBe(true)
    await expect
      .poll(
        async () =>
          (await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, trigger.id)))[0]!.state,
      )
      .toMatchObject({ lastError: expect.stringContaining(`No queue "${queue}"`) })
    aws.sqs.createQueue(queue)
    const id = aws.sqs.send(queue, 'finally')
    await expect
      .poll(async () => (await runsOf(trigger.id)).map((r) => messageOf(r).messageId), { timeout: 5000 })
      .toEqual([id])
  })
})
