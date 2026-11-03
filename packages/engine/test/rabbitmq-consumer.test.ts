import { rabbitmqConnector } from '@ow/connectors'
import { rabbitAvailable, startTestRabbit, type TestRabbit } from '@ow/connectors/testing'
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
import type { RabbitRunMessage } from '../src/types'
import { connect, wf } from './pg-harness'

// The consumer's RabbitMQ adapter (M30 step 2) against Postgres and a throwaway RabbitMQ. Runs aren't executed here:
// they stay queued, i.e. under way, until a test ends them. Skipped locally without Docker; CI runs it.
const available = rabbitAvailable()
let db: Db
let prodId: string
let stopDb: () => Promise<void>
let rabbit: TestRabbit
const consumers: QueueConsumer[] = []

const resources: ResourceProvider = {
  async resolve(slug, environmentId) {
    return {
      connector: rabbitmqConnector,
      resource: {
        id: `${slug}-${environmentId}`,
        resourceId: slug,
        environmentId,
        version: '1',
        config: {
          host: rabbit.host,
          port: rabbit.port,
          username: rabbit.username,
          allowPrivateNetwork: true,
        },
        secrets: { password: rabbit.password },
      },
    }
  },
}

beforeAll(async () => {
  if (!available) return
  const pg = await startTestDatabase()
  const conn = connect(pg.url)
  db = conn.db
  prodId = (await db.select().from(environments)).find((e) => e.slug === 'production')!.id
  rabbit = await startTestRabbit()
  stopDb = async () => {
    await conn.close()
    await pg.stop()
  }
}, 120_000)
afterEach(async () => {
  if (!available) return
  await Promise.all(consumers.splice(0).map((c) => c.stop()))
  await db.execute(dsql`truncate workflow_runs, workflow_triggers cascade`)
})
afterAll(async () => {
  await rabbit?.stop()
  await stopDb?.()
})

const definition = wf([{ name: 'a', type: 'code', config: { code: 'return 1' } }], [['startTrigger', 'a']])
let n = 0

/** A queue of its own with a dead-letter queue, and a workflow whose live release has a RabbitMQ trigger on it. */
async function queued(opts: { maxInFlight?: number } = {}) {
  const i = ++n
  const queue = `jobs-${i}`
  const dlq = `jobs-${i}-dead`
  await rabbit.declare(queue, { deadLetterQueue: dlq })
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `rabbit_${i}`, name: 'Rabbit', draftDefinition: definition })
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
      kind: 'rabbitmq',
      name: 'jobs',
      config: {
        name: 'jobs',
        enabled: true,
        resource: 'broker',
        queue,
        maxInFlight: opts.maxInFlight ?? 4,
        maxHoldMinutes: 60,
      },
      environmentId: prodId,
    })
    .returning()
  return { queue, dlq, trigger: trigger! }
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
const messageOf = (run: { input: unknown }) => (run.input as { message: RabbitRunMessage }).message
const delivery = async (triggerId: string, messageId: string) =>
  (
    await db
      .select()
      .from(queueDeliveries)
      .where(and(eq(queueDeliveries.triggerId, triggerId), eq(queueDeliveries.messageId, messageId)))
  )[0]

describe.skipIf(!available)('QueueConsumer: RabbitMQ', () => {
  it('starts a run per message with its body and properties, and acks it when the run succeeds', async () => {
    const { trigger, queue } = await queued()
    await rabbit.send(queue, '{"order": 7}', { messageId: 'm-7', headers: { shop: 'nl' } })
    const before = { ...queueStats.rabbitmq }
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, { timeout: 10_000 }).toBe(1)
    const [run] = await runsOf(trigger.id)
    expect(run).toMatchObject({ triggerType: 'rabbitmq', idempotencyKey: `rabbitmq:${trigger.id}:id:m-7:1` })
    expect((run!.input as { data: unknown }).data).toEqual({ order: 7 })
    expect(messageOf(run!)).toMatchObject({
      queue,
      exchange: '',
      routingKey: queue,
      redelivered: false,
      headers: { shop: 'nl' },
      messageId: 'm-7',
    })
    await end(run!.id, 'succeeded')
    await expect.poll(async () => (await delivery(trigger.id, 'id:m-7'))?.outcome).toBe('succeeded')
    expect(queueStats.rabbitmq.acked - before.acked).toBe(1)
    // Acked: gone from the queue, not in the dead-letter queue.
    await consumers.splice(0)[0]!.stop()
    expect(await rabbit.drain(queue)).toEqual([])
  })

  it('nacks a failed message without requeueing: the dead-letter exchange takes it', async () => {
    const { trigger, queue, dlq } = await queued()
    await rabbit.send(queue, 'broken', { messageId: 'b-1' })
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, { timeout: 10_000 }).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'failed')
    await expect.poll(async () => (await rabbit.drain(dlq)).map((m) => m.body)).toEqual(['broken'])
    expect(await runsOf(trigger.id)).toHaveLength(1)
    expect(await delivery(trigger.id, 'id:b-1')).toMatchObject({ outcome: 'failed', runs: 1 })
  })

  it('holds no more than the prefetch at once, and hands unfinished messages back when it stops', async () => {
    const { trigger, queue } = await queued({ maxInFlight: 2 })
    for (let i = 1; i <= 5; i++) await rabbit.send(queue, `job ${i}`, { messageId: `j-${i}` })
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, { timeout: 10_000 }).toBe(2)
    await new Promise((r) => setTimeout(r, 300))
    expect(await runsOf(trigger.id)).toHaveLength(2)
    // One finishes: the next comes.
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(async () => (await runsOf(trigger.id)).length, { timeout: 10_000 }).toBe(3)
    // Stopping hands the two held ones back: still in the queue, marked redelivered, and recognised as the same.
    await consumers.splice(0)[0]!.stop()
    const left = await rabbit.drain(queue)
    expect(left.map((m) => m.body)).toEqual(
      ['job 2', 'job 3', 'job 4', 'job 5'].filter((b) => left.some((m) => m.body === b)),
    )
    expect(left.filter((m) => m.redelivered).length).toBe(2)
  })

  it('reports a queue that does not exist, and starts once it does', async () => {
    const { trigger, queue } = await queued()
    // Point the trigger at a queue nobody declared.
    await db
      .update(workflowTriggers)
      .set({ config: { ...(trigger.config as object), queue: `${queue}-later` } })
      .where(eq(workflowTriggers.id, trigger.id))
    consumer().start()
    await expect
      .poll(
        async () =>
          (
            (await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, trigger.id)))[0]!
              .state as { lastError?: string } | null
          )?.lastError ?? '',
        { timeout: 10_000 },
      )
      .toMatch(/NOT_FOUND|no queue/i)
    await rabbit.declare(`${queue}-later`)
    await rabbit.send(`${queue}-later`, 'finally', { messageId: 'late' })
    await expect.poll(async () => (await runsOf(trigger.id)).length, { timeout: 15_000 }).toBe(1)
  })
})
