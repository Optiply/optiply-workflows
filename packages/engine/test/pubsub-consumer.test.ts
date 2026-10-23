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
import { PubSubConsumer, type PubSubConsumerOptions, pubsubStats, type ResourceProvider } from '../src'
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
async function subscribed(config: { maxInFlight?: number; maxHoldMinutes?: number } = {}) {
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
        maxHoldMinutes: config.maxHoldMinutes ?? 60,
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

function consumer(workerId = 'w1', over: Partial<PubSubConsumerOptions> = {}) {
  const c = new PubSubConsumer({
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
    // Reported on the trigger's row at the next lease tick, for the editor.
    await expect
      .poll(async () => (await triggerRow(trigger.id)).state)
      .toMatchObject({
        inFlight: 2,
        lastMessageAt: expect.any(String),
        lastPullAt: expect.any(String),
        lastError: null,
      })
  })

  it('holds a redelivered message whose run is still under way, instead of running it again', async () => {
    const { trigger, publish, subscription } = await subscribed()
    publish('once')
    // Held for 10 s (500 ms here) and not extended in time: Pub/Sub delivers it again.
    consumer('w1', { holdDeadlineSeconds: 10, extendEveryMs: 60_000 }).start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
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
    // The disabled one's lease is given up at once, not left to lapse.
    expect(await triggerRow(trigger.id)).toMatchObject({ leaseOwner: null, leaseExpiresAt: null })
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
    await expect
      .poll(async () => (await triggerRow(trigger.id)).state)
      .toMatchObject({
        lastError: expect.stringContaining('Resource not found'),
        lastErrorAt: expect.any(String),
        lastPullAt: null,
      })
  })
})

/** A run's end, as the dispatcher would write it. */
const end = (runId: string, status: 'succeeded' | 'failed' | 'cancelled') =>
  db.update(workflowRuns).set({ status, finishedAt: new Date() }).where(eq(workflowRuns.id, runId))
const delivery = async (messageId: string) =>
  (await db.select().from(pubsubDeliveries).where(eq(pubsubDeliveries.messageId, messageId)))[0]!

describe('holding messages until their runs end (3b)', () => {
  it('acks when the run succeeds; nacks when it fails or is cancelled, and Pub/Sub delivers it again', async () => {
    const { trigger, publish, subscription } = await subscribed()
    const ok = publish('fine')
    const bad = publish('breaks')
    const stopped = publish('cancelled')
    const before = { ...pubsubStats }
    consumer().start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(3)
    const runFor = async (messageId: string) =>
      (await runsOf(trigger.id)).find(
        (r) => (r.input as { message: { messageId: string } }).message.messageId === messageId,
      )!
    await end((await runFor(ok)).id, 'succeeded')
    await end((await runFor(bad)).id, 'failed')
    await end((await runFor(stopped)).id, 'cancelled')
    const message = (id: string) => pubsub.messages(subscription).find((m) => m.messageId === id)!
    await expect.poll(() => message(ok).acked).toBe(true)
    expect(await delivery(ok)).toMatchObject({ outcome: 'succeeded', runs: 1 })
    // Nacked: delivered again at once, and run again.
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(5)
    expect(message(bad).deliveries).toBe(2)
    expect(await delivery(bad)).toMatchObject({ runs: 2, outcome: null })
    expect(pubsubStats.acked - before.acked).toBe(1)
    expect(pubsubStats.nacked - before.nacked).toBe(2)
  })

  it("keeps a message whose run outlasts the subscription's deadline: no redelivery", async () => {
    const { trigger, publish, subscription } = await subscribed()
    const id = publish('slow')
    // Held 20 s (1 s here) at a time, extended every 200 ms; the subscription's own deadline is 500 ms.
    consumer('w1', { holdDeadlineSeconds: 20 }).start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    await sleep(1500)
    expect(pubsub.messages(subscription)[0]!.deliveries).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(() => pubsub.messages(subscription)[0]!.acked).toBe(true)
    expect(await delivery(id)).toMatchObject({ outcome: 'succeeded' })
  })

  it('acks a message held past maxHoldMinutes, and its run goes on', async () => {
    const { trigger, publish, subscription } = await subscribed({ maxHoldMinutes: 1 })
    const id = publish('long')
    const warnings: string[] = []
    consumer('w1', {
      holdMinuteMs: 300,
      log: { info: () => {}, warn: (_o, msg) => warnings.push(msg ?? '') },
    }).start()
    await expect.poll(() => pubsub.messages(subscription)[0]?.acked ?? false).toBe(true)
    expect(await delivery(id)).toMatchObject({ outcome: 'released' })
    expect((await runsOf(trigger.id))[0]!.status).toBe('queued')
    expect(warnings).toContain('pubsub message held past maxHoldMinutes: acked, its run goes on')
    // Delivered again anyway (at-least-once): acked without a run.
    expect(await runsOf(trigger.id)).toHaveLength(1)
  })

  it('hands a held message over when its worker stops: the next one holds it for the same run, and acks it', async () => {
    const { trigger, publish, subscription } = await subscribed()
    publish('handed over')
    const one = consumer('w1')
    one.start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    // w1 stops: it nacks what it held and gives the lease up; w2 takes the trigger and gets the message again.
    await one.stop()
    const two = consumer('w2')
    two.start()
    await expect.poll(() => two.stats.inFlight, { timeout: 5000 }).toBe(1)
    // At least twice: a pull w1 cancelled as it stopped may have taken it once more on the way.
    expect(pubsub.messages(subscription)[0]!.deliveries).toBeGreaterThanOrEqual(2)
    expect(await runsOf(trigger.id)).toHaveLength(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(() => pubsub.messages(subscription)[0]!.acked).toBe(true)
    expect(two.stats.inFlight).toBe(0)
  })
})

describe('review fixes (M19)', () => {
  it('never runs again a message whose run succeeded before its worker recorded it', async () => {
    const { trigger, publish, subscription } = await subscribed()
    const id = publish('once only')
    // w1 never gets to record outcomes: it holds, the run succeeds, and w1 stops (nacking) first.
    const one = consumer('w1', { checkMs: 60_000 })
    one.start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await one.stop()
    consumer('w2').start()
    await expect.poll(() => pubsub.messages(subscription)[0]!.acked, { timeout: 5000 }).toBe(true)
    expect(await runsOf(trigger.id)).toHaveLength(1)
    expect(await delivery(id)).toMatchObject({ outcome: 'succeeded', runs: 1 })
  })

  it('still acks a held message after a failed pull dropped the client', async () => {
    const { trigger, publish, subscription } = await subscribed()
    publish('held through an outage')
    const warnings: string[] = []
    // The next pull is 10 s after the failure: until then there's no client, and the ack must make its own.
    consumer('w1', {
      retryMs: 10_000,
      log: { info: () => {}, warn: (_o, msg) => warnings.push(msg ?? '') },
    }).start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    pubsub.failNext('pull', 503, 'The service was unable to fulfill your request.')
    await expect.poll(() => warnings.includes('pubsub pull failed')).toBe(true)
    await end((await runsOf(trigger.id))[0]!.id, 'succeeded')
    await expect.poll(() => pubsub.messages(subscription)[0]!.acked).toBe(true)
    expect(warnings).not.toContain('pubsub ack or nack failed')
  })

  it('keeps pulling through a new release with the same settings: nothing nacked, new runs on the new release', async () => {
    const { trigger, publish, subscription } = await subscribed()
    const held = publish('before the release')
    const one = consumer('w1')
    one.start()
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(1)
    const [release] = await db
      .insert(workflowReleases)
      .values({
        workflowId: trigger.workflowId,
        version: '1.0.1',
        definition,
        definitionHash: 'b'.repeat(64),
      })
      .returning()
    await db
      .update(workflowTriggers)
      .set({ releaseId: release!.id })
      .where(eq(workflowTriggers.id, trigger.id))
    await one.tick()
    // Not restarted: the held message wasn't nacked (and so not delivered again).
    await sleep(300)
    expect(pubsub.messages(subscription).find((m) => m.messageId === held)!.deliveries).toBe(1)
    expect(one.stats.inFlight).toBe(1)
    publish('after the release')
    await expect.poll(async () => (await runsOf(trigger.id)).length).toBe(2)
    expect((await runsOf(trigger.id))[1]!.releaseId).toBe(release!.id)
  })
})
