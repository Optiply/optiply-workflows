import { kafkaClient, kafkaConnector, kafkaConsumer, produceTo } from '@ow/connectors'
import {
  type FakeRegistry,
  kafkaAvailable,
  startFakeRegistry,
  startTestKafka,
  type TestKafka,
} from '@ow/connectors/testing'
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
import { asc, sql as dsql, eq, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { QueueConsumer, type QueueConsumerOptions, queueStats, type ResourceProvider } from '../src'
import type { KafkaRunMessage } from '../src/types'
import { connect, wf } from './pg-harness'

// The consumer's Kafka adapter (M26 step 3c) against Postgres and a throwaway Kafka 4.1 (plaintext). A second of
// `retryBackoffSeconds` lasts 10 ms. Runs aren't executed here: they stay queued, i.e. under way, until a test ends them.
const available = kafkaAvailable()
let db: Db
let prodId: string
let stopDb: (() => Promise<void>) | undefined
let kafka: TestKafka
const consumers: QueueConsumer[] = []
let registry: FakeRegistry
const settings = () => ({
  brokers: [kafka.plaintext],
  auth: 'none' as const,
  tls: false,
  identity: 'key' as const,
  // M30: a Schema Registry; values not in its wire format are left as they are.
  schemaRegistry: { url: registry.url, username: registry.username, allowPrivateNetwork: true },
})
const secrets = () => ({ schemaRegistryPassword: registry.password })

const resources: ResourceProvider = {
  async resolve(slug, environmentId) {
    return {
      connector: kafkaConnector,
      resource: {
        id: `${slug}-${environmentId}`,
        resourceId: slug,
        environmentId,
        version: '1',
        config: settings(),
        secrets: secrets(),
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
  kafka = await startTestKafka()
  registry = await startFakeRegistry()
  stopDb = async () => {
    await conn.close()
    await pg.stop()
  }
}, 120_000)
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()))
  if (available) await db.execute(dsql`truncate workflow_runs, workflow_triggers cascade`)
})
afterAll(async () => {
  await kafka?.stop()
  await registry?.stop()
  await stopDb?.()
})

const definition = wf([{ name: 'a', type: 'code', config: { code: 'return 1' } }], [['startTrigger', 'a']])
let n = 0

/** A topic of its own, and a workflow whose live release has a Kafka trigger on it. */
async function subscribed(config: Record<string, unknown> = {}) {
  const i = ++n
  const topic = `orders-${i}`
  await kafka.createTopic(topic)
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `kafka_${i}`, name: 'Kafka', draftDefinition: definition })
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
      kind: 'kafka',
      name: 'orders',
      config: {
        name: 'orders',
        enabled: true,
        resource: 'cluster',
        topics: [topic],
        startAt: 'earliest',
        maxInFlight: 4,
        maxHoldMinutes: 60,
        maxAttempts: 3,
        retryBackoffSeconds: 1,
        ...config,
      },
      environmentId: prodId,
    })
    .returning()
  const producer = kafkaClient(settings(), secrets())
  return {
    topic,
    trigger: trigger!,
    groupId: `ow-${workflow!.id}-orders`,
    producer,
    async send(
      ...messages: { key?: string; value: string | Buffer | null; headers?: Record<string, string> }[]
    ) {
      try {
        await produceTo(producer, topic, messages, AbortSignal.timeout(10_000))
      } finally {
        await producer.close()
      }
    },
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
    backoffSecondMs: 10,
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
const end = (runId: string, status: 'succeeded' | 'failed' | 'cancelled', error?: string) =>
  db
    .update(workflowRuns)
    .set({ status, finishedAt: new Date(), ...(error ? { error: { message: error } } : {}) })
    .where(eq(workflowRuns.id, runId))
const messageOf = (run: { input: unknown }) => (run.input as { message: KafkaRunMessage }).message
const dataOf = (run: { input: unknown }) => (run.input as { data: unknown }).data
const values = async (triggerId: string) => (await runsOf(triggerId)).map(dataOf)
const runOf = async (triggerId: string, value: unknown) =>
  (await runsOf(triggerId)).filter((r) => dataOf(r) === value).at(-1)!
const poll = { timeout: 30_000 }

/** What a topic holds, read from the start by a group of its own. */
async function readAll(topic: string, count: number) {
  const client = kafkaClient(settings(), secrets())
  const c = await kafkaConsumer(client, {
    groupId: `reader-${topic}-${Date.now()}`,
    topics: [topic],
    startAt: 'earliest',
    onAssign() {},
    onRevoke() {},
  })
  const got: Awaited<ReturnType<typeof c.consume>> = []
  try {
    const deadline = Date.now() + 30_000
    while (got.length < count && Date.now() < deadline) got.push(...(await c.consume(10, 500)))
    return got
  } finally {
    await c.close()
    await client.close()
  }
}

/** The group's committed offset of partition 0, through the broker's own tool. */
async function committed(topic: string, groupId: string): Promise<number | null> {
  const client = kafkaClient(settings(), secrets())
  try {
    const admin = await client.admin()
    const [entry] = await admin.fetchOffsets({ groupId, topics: [topic] } as never)
    const offset = (entry as unknown as { partitions: { partition: number; offset: string }[] }).partitions[0]
      ?.offset
    return offset === undefined || Number(offset) < 0 ? null : Number(offset)
  } finally {
    await client.close()
  }
}

describe.skipIf(!available)('QueueConsumer: Kafka', () => {
  it("runs a key's messages one at a time and in order, other keys and keyless ones alongside; commits past them", async () => {
    const { trigger, send, topic, groupId } = await subscribed()
    await send(
      { key: 'a', value: '{"n":"a1"}', headers: { kind: 'created' } },
      { key: 'a', value: '{"n":"a2"}' },
      { key: 'b', value: '{"n":"b1"}' },
      { value: 'no key' },
    )
    consumer().start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(3)
    expect(await values(trigger.id)).toEqual([{ n: 'a1' }, { n: 'b1' }, 'no key'])
    const [a1] = await runsOf(trigger.id)
    // The id carries the message's timestamp, so a topic made again isn't taken for the old one.
    expect(a1).toMatchObject({
      triggerType: 'kafka',
      idempotencyKey: expect.stringMatching(new RegExp(`^kafka:${trigger.id}:${topic}/0/0@\\d+:1$`)),
    })
    expect(messageOf(a1!)).toMatchObject({
      topic,
      partition: 0,
      offset: '0',
      key: 'a',
      headers: { kind: 'created' },
      attempt: 1,
      groupId,
      timestamp: expect.any(String),
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(await runsOf(trigger.id)).toHaveLength(3)
    await end(a1!.id, 'succeeded')
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(4)
    expect((await values(trigger.id))[3]).toEqual({ n: 'a2' })
    for (const run of await runsOf(trigger.id)) await end(run.id, 'succeeded')
    // Settled: committed on stop (and every 5 s meanwhile).
    await expect
      .poll(
        async () => (await db.select().from(queueDeliveries)).filter((d) => d.outcome === 'succeeded').length,
        poll,
      )
      .toBe(4)
    await Promise.all(consumers.splice(0).map((c) => c.stop()))
    expect(await committed(topic, groupId)).toBe(4)
  }, 90_000)

  it('retries a failed message after its backoff, then dead-letters it and its key moves on', async () => {
    const { trigger, send } = await subscribed({ maxAttempts: 2, deadLetterTopic: `dlt-${n + 1}` })
    const dlt = `dlt-${n}`
    await kafka.createTopic(dlt)
    await send({ key: 'k', value: 'broken', headers: { trace: 't-1' } }, { key: 'k', value: 'next' })
    const before = { ...queueStats.kafka }
    consumer().start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(1)
    await end((await runOf(trigger.id, 'broken')).id, 'failed', 'boom 1')
    // Attempt 2, after a 1 s (10 ms) backoff; "next" waits behind it.
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(2)
    const second = await runOf(trigger.id, 'broken')
    expect(messageOf(second).attempt).toBe(2)
    expect(await values(trigger.id)).toEqual(['broken', 'broken'])
    await end(second.id, 'failed', 'boom 2')
    await expect.poll(async () => (await values(trigger.id)).at(-1), poll).toBe('next')
    expect(queueStats.kafka.retried - before.retried).toBe(1)
    expect(queueStats.kafka.dead_lettered - before.dead_lettered).toBe(1)
    const [letter] = await readAll(dlt, 1)
    expect(letter).toMatchObject({ key: 'k', value: Buffer.from('broken') })
    expect(letter!.headers).toMatchObject({
      trace: 't-1',
      'ow-error': 'boom 2',
      'ow-workflow': trigger.workflowId,
      'ow-run-id': second.id,
      'ow-source-partition': '0',
      'ow-source-offset': '0',
      'ow-attempts': '2',
    })
    const [delivery] = await db
      .select()
      .from(queueDeliveries)
      .where(like(queueDeliveries.messageId, `${letter!.headers['ow-source-topic']}/0/0@%`))
    expect(delivery).toMatchObject({ outcome: 'dead_lettered', runs: 2 })
  }, 90_000)

  it('drops a message after its last attempt when there is no dead-letter topic', async () => {
    const { trigger, send } = await subscribed({ maxAttempts: 1 })
    await send({ key: 'k', value: 'broken' }, { key: 'k', value: 'next' })
    const before = queueStats.kafka.dropped
    consumer().start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'cancelled')
    await expect.poll(async () => (await values(trigger.id)).at(-1), poll).toBe('next')
    expect(queueStats.kafka.dropped - before).toBe(1)
  }, 90_000)

  it('hands a partition over when its worker stops: the next holds the message for the same run, and loses none', async () => {
    const { trigger, send } = await subscribed()
    await send({ key: 'k', value: 'first' })
    const one = consumer('w1')
    one.start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(1)
    await one.stop()
    await send({ value: 'while away' })
    const two = consumer('w2')
    two.start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(2)
    await expect.poll(() => two.stats.inFlight, poll).toBe(2)
    expect(await values(trigger.id)).toEqual(['first', 'while away'])
    for (const run of await runsOf(trigger.id)) await end(run.id, 'succeeded')
    await expect.poll(() => two.stats.inFlight, poll).toBe(0)
    expect(await runsOf(trigger.id)).toHaveLength(2)
  }, 90_000)

  it('keeps to maxInFlight', async () => {
    const { trigger, send } = await subscribed({ maxInFlight: 1 })
    await send({ value: 'one' }, { value: 'two' })
    consumer().start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(1)
    await new Promise((r) => setTimeout(r, 500))
    expect(await runsOf(trigger.id)).toHaveLength(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(2)
  }, 90_000)

  it("offers a message again when its run couldn't start (review fix): its key isn't stuck", async () => {
    const { trigger, send } = await subscribed()
    await send({ key: 'k', value: 'first' }, { key: 'k', value: 'second' })
    // The database refuses the delivery records for a moment: the first delivery fails.
    await db.execute(dsql`alter table queue_deliveries rename to queue_deliveries_away`)
    const warnings: string[] = []
    consumer('w1', { log: { info: () => {}, warn: (_o, msg) => warnings.push(msg ?? '') } }).start()
    await expect.poll(() => warnings.includes('kafka delivery failed'), poll).toBe(true)
    await db.execute(dsql`alter table queue_deliveries_away rename to queue_deliveries`)
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(async () => (await values(trigger.id)).at(-1), poll).toBe('second')
  }, 90_000)

  it('records a dead letter sent on a later try (review fix)', async () => {
    const dlt = `dlt-late-${n + 1}`
    const { trigger, send } = await subscribed({ maxAttempts: 1, deadLetterTopic: dlt })
    await send({ key: 'k', value: 'broken' })
    consumer().start()
    await expect.poll(async () => (await values(trigger.id)).length, poll).toBe(1)
    // The dead-letter topic doesn't exist yet: the first send fails, a later one goes.
    await end((await runsOf(trigger.id))[0]!.id, 'failed', 'boom')
    await new Promise((r) => setTimeout(r, 300))
    await kafka.createTopic(dlt)
    await expect
      .poll(
        async () =>
          (await db.select().from(queueDeliveries).where(eq(queueDeliveries.triggerId, trigger.id)))[0]
            ?.outcome,
        poll,
      )
      .toBe('dead_lettered')
    expect((await readAll(dlt, 1))[0]).toMatchObject({ key: 'k' })
  }, 90_000)

  it('decodes Schema Registry values (Avro) for the run, and runs an undecodable one as it came', async () => {
    const schemaId = registry.register(`m30-orders-value`, {
      type: 'record',
      name: 'Order',
      fields: [
        { name: 'id', type: 'long' },
        { name: 'sku', type: 'string' },
      ],
    })
    const { trigger, send, producer } = await subscribed()
    const framed = await producer.registry!.encode(
      'm30-orders-value',
      { id: 9, sku: 'A-9' },
      AbortSignal.timeout(5000),
    )
    const unknown = Buffer.concat([Buffer.from([0, 0, 0, 3, 231]), Buffer.from('?')])
    await send({ key: 'a', value: framed }, { key: 'b', value: unknown })
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length, { timeout: 15_000 }).toBe(2)
    const runs = await runsOf(trigger.id)
    const byKey = new Map(
      runs.map((r) => [
        (r.input as { message: KafkaRunMessage }).message.key,
        r.input as { data: unknown; message: KafkaRunMessage },
      ]),
    )
    expect(byKey.get('a')).toMatchObject({ data: { id: 9, sku: 'A-9' }, message: { schemaId } })
    expect(byKey.get('b')!.message.schemaError).toMatch(/Schema not found/)
    // Its bytes hold NULs, which jsonb can't store: base64, so the run starts (it used to fail forever).
    expect(byKey.get('b')).toMatchObject({
      data: unknown.toString('base64'),
      message: { encoding: 'base64' },
    })
    expect(byKey.get('a')!.message.encoding).toBeUndefined()
  })
})
