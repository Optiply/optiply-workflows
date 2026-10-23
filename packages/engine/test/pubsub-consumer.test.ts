import { configurePubSub, pubsubConnector } from '@ow/connectors'
import { type FakePubSub, startFakePubSub } from '@ow/connectors/testing'
import {
  type Db,
  environments,
  pubsubDeliveries,
  workflowReleases,
  workflowRuns,
  workflows,
  workflowTriggers,
} from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { asc, sql as dsql, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PubSubConsumer, type ResourceProvider } from '../src'
import { connect, wf } from './pg-harness'

// The consumer (M19 step 3a) against Postgres and the fake Pub/Sub, where a second lasts 50 ms (a subscription's 10 s
// ack deadline passes in 500 ms). Runs aren't executed here: they stay queued, i.e. still under way.
let db: Db
let prodId: string
let stopDb: () => Promise<void>
let pubsub: FakePubSub
const consumers: PubSubConsumer[] = []

/** The `events` resource, signed in as a stand-in for the server's identity. */
const resources: ResourceProvider = {
  async resolve(slug, environmentId) {
    return {
      connector: pubsubConnector,
      resource: {
        id: `${slug}-${environmentId}`,
        resourceId: slug,
        environmentId,
        version: '1',
        config: { identity: 'server', project: 'fake-project' },
        secrets: {},
      },
    }
  },
}

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = connect(pg.url)
  db = conn.db
  prodId = (await db.select().from(environments)).find((e) => e.slug === 'production')!.id
  pubsub = await startFakePubSub({ project: 'fake-project', secondMs: 50, pullWaitMs: 50 })
  configurePubSub({
    url: pubsub.url,
    serverIdentity: { token: async () => 't', describe: async () => 'the server' },
  })
  stopDb = async () => {
    await conn.close()
    await pg.stop()
  }
})
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()))
  // Each test's triggers are its own: a later consumer would lease them too.
  await db.execute(dsql`truncate workflow_runs, workflow_triggers cascade`)
})
afterAll(async () => {
  configurePubSub({})
  await pubsub?.close()
  await stopDb?.()
})

const definition = wf([{ name: 'a', type: 'code', config: { code: 'return 1' } }], [['startTrigger', 'a']])
let n = 0

/** A topic and subscription of their own, and a workflow whose live release has a Pub/Sub trigger on it. */
async function subscribed(config: { maxInFlight?: number } = {}) {
  const i = ++n
  const topic = `topic-${i}`
  const subscription = `sub-${i}`
  pubsub.createTopic(topic)
  pubsub.createSubscription(subscription, { topic })
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `subscribed_${i}`, name: 'Subscribed', draftDefinition: definition })
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
      kind: 'pubsub',
      name: 'orders',
      config: {
        name: 'orders',
        enabled: true,
        resource: 'events',
        subscription,
        maxInFlight: config.maxInFlight ?? 4,
        maxHoldMinutes: 60,
      },
      environmentId: prodId,
    })
    .returning()
  return {
    topic,
    subscription,
    trigger: trigger!,
    publish: (data: string, attrs?: Record<string, string>) => pubsub.publish(topic, data, attrs),
  }
}

function consumer(workerId = 'w1') {
  const c = new PubSubConsumer({ db, resources, workerId, intervalMs: 100, leaseMs: 30_000, retryMs: 50 })
  consumers.push(c)
  return c
}

const runsOf = (triggerId: string) =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.triggerId, triggerId))
    .orderBy(asc(workflowRuns.createdAt))
const triggerRow = async (id: string) =>
  (await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, id)))[0]!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('PubSubConsumer', () => {
  it('leases the trigger and starts a run per message, with its data and the message', async () => {
    const { trigger, publish, subscription } = await subscribed()
    const first = publish('{"order": 1}', { kind: 'created' })
    const second = publish('plain text')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(2)
    const runs = await runsOf(trigger.id)
    expect(runs.map((r) => r.idempotencyKey).sort()).toEqual(
      [`pubsub:${trigger.id}:${first}:1`, `pubsub:${trigger.id}:${second}:1`].sort(),
    )
    const byMessage = new Map(
      runs.map((r) => [(r.input as { message: { messageId: string } }).message.messageId, r]),
    )
    expect(byMessage.get(first)).toMatchObject({
      triggerType: 'pubsub',
      environmentId: prodId,
      status: 'queued',
      input: {
        data: { order: 1 },
        message: {
          messageId: first,
          attributes: { kind: 'created' },
          subscription,
          dataBase64: Buffer.from('{"order": 1}').toString('base64'),
          publishTime: expect.any(String),
        },
      },
    })
    expect((byMessage.get(second)!.input as { data: unknown }).data).toBe('plain text')
    expect(await triggerRow(trigger.id)).toMatchObject({ leaseOwner: 'w1' })
    expect(consumers[0]!.stats).toEqual({ triggers: 1, inFlight: 2 })
  })

  it('holds a redelivered message whose run is still under way, instead of running it again', async () => {
    const { trigger, publish, subscription } = await subscribed()
    publish('once')
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    // Past its 500 ms deadline (no extension yet: step 3b), Pub/Sub delivers it again.
    await expect
      .poll(() => pubsub.messages(subscription)[0]!.deliveries, { timeout: 5000 })
      .toBeGreaterThan(1)
    await sleep(200)
    expect(await runsOf(trigger.id)).toHaveLength(1)
    expect(consumers[0]!.stats.inFlight).toBe(1)
  })

  it('acks a redelivery of a message whose run succeeded, and runs again after one that failed', async () => {
    const { trigger, publish, subscription } = await subscribed()
    const done = publish('done already')
    const failed = publish('failed before')
    // As if an earlier run of each had ended (step 3b records it).
    for (const [messageId, outcome] of [
      [done, 'succeeded'],
      [failed, 'failed'],
    ] as const)
      await db.insert(pubsubDeliveries).values({ triggerId: trigger.id, messageId, runs: 1, outcome })
    consumer().start()
    await expect.poll(() => pubsub.messages(subscription).find((m) => m.messageId === done)!.acked).toBe(true)
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    const [rerun] = await runsOf(trigger.id)
    expect(rerun!.idempotencyKey).toBe(`pubsub:${trigger.id}:${failed}:2`)
    const [delivery] = await db.select().from(pubsubDeliveries).where(eq(pubsubDeliveries.messageId, failed))
    expect(delivery).toMatchObject({ runs: 2, lastRunId: rerun!.id, outcome: null })
  })

  it('keeps to maxInFlight', async () => {
    const { trigger, publish, subscription } = await subscribed({ maxInFlight: 2 })
    for (let i = 0; i < 5; i++) publish(`m${i}`)
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(2)
    await sleep(300)
    expect(await runsOf(trigger.id)).toHaveLength(2)
    expect(pubsub.outstanding(subscription)).toBeLessThanOrEqual(2)
  })

  it('lets another worker take a trigger whose lease lapsed, and the first stops pulling it', async () => {
    const { trigger } = await subscribed()
    const one = consumer('w1')
    const two = consumer('w2')
    await one.tick()
    await two.tick()
    expect(await triggerRow(trigger.id)).toMatchObject({ leaseOwner: 'w1' })
    expect(two.stats.triggers).toBe(0)
    // w1 stopped renewing (gone without a goodbye).
    await db
      .update(workflowTriggers)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(workflowTriggers.id, trigger.id))
    await two.tick()
    expect(await triggerRow(trigger.id)).toMatchObject({ leaseOwner: 'w2' })
    await one.tick()
    expect(one.stats.triggers).toBe(0)
    expect(two.stats.triggers).toBe(1)
  })

  it('gives its leases up on stop, and stops pulling a trigger disabled or dropped', async () => {
    const { trigger } = await subscribed()
    const other = await subscribed()
    const one = consumer('w1')
    await one.tick()
    expect(one.stats.triggers).toBeGreaterThanOrEqual(2)
    await db.update(workflowTriggers).set({ enabled: false }).where(eq(workflowTriggers.id, trigger.id))
    await db.delete(workflowTriggers).where(eq(workflowTriggers.id, other.trigger.id))
    const before = one.stats.triggers
    await one.tick()
    expect(one.stats.triggers).toBe(before - 2)
    await one.stop()
    const leased = await db.execute<{ n: number }>(
      dsql`select count(*)::int as n from workflow_triggers where lease_owner = 'w1'`,
    )
    expect(leased[0]!.n).toBe(0)
  })

  it('keeps trying a subscription it may not read, and says why', async () => {
    const { trigger } = await subscribed()
    await db
      .update(workflowTriggers)
      .set({ config: dsql`config || '{"subscription": "missing-sub"}'::jsonb` })
      .where(eq(workflowTriggers.id, trigger.id))
    const warnings: { obj: Record<string, unknown>; msg?: string }[] = []
    const c = new PubSubConsumer({
      db,
      resources,
      workerId: 'w9',
      intervalMs: 100,
      retryMs: 50,
      log: {
        info: () => {},
        warn: (obj, msg) => warnings.push({ obj: obj as Record<string, unknown>, msg }),
      },
    })
    consumers.push(c)
    c.start()
    await expect.poll(() => warnings.filter((w) => w.msg === 'pubsub pull failed').length).toBeGreaterThan(1)
    expect(warnings.find((w) => w.msg === 'pubsub pull failed')!.obj).toMatchObject({
      triggerId: expect.any(String),
      err: expect.stringContaining('Resource not found'),
    })
  })
})
