import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PubSubClient, resourcePath } from '../src/pubsub/client'
import { type FakePubSub, startFakePubSub } from '../src/pubsub/fake'
import { ConnectorError } from '../src/types'

// The REST client against the fake endpoint (src/pubsub/fake.ts), where a Pub/Sub second lasts 50 ms.
let pubsub: FakePubSub
const signal = () => AbortSignal.timeout(5000)
const client = (token = 'good') =>
  new PubSubClient({ project: 'fake-project', tokens: { token: async () => token }, url: pubsub.url })

beforeAll(async () => {
  pubsub = await startFakePubSub({
    tokens: ['good'],
    secondMs: 50,
    pullWaitMs: 100,
    deny: ['projects/fake-project/subscriptions/secret'],
  })
  pubsub.createTopic('orders')
  pubsub.createTopic('orders-dead')
  pubsub.createSubscription('orders-sub', { topic: 'orders', ackDeadlineSeconds: 4 })
  pubsub.createSubscription('orders-dl', {
    topic: 'orders',
    deadLetterPolicy: { deadLetterTopic: 'orders-dead', maxDeliveryAttempts: 2 },
  })
  pubsub.createSubscription('ordered', { topic: 'orders', enableMessageOrdering: true })
  pubsub.createSubscription('secret', { topic: 'orders' })
})
afterAll(() => pubsub.close())

describe('names', () => {
  it('makes full names, keeps other projects, refuses what Pub/Sub would', () => {
    expect(resourcePath('p', 'subscriptions', 'orders-sub')).toBe('projects/p/subscriptions/orders-sub')
    expect(resourcePath('p', 'topics', 'projects/q/topics/t1x')).toBe('projects/q/topics/t1x')
    expect(() => resourcePath('p', 'topics', 'projects/q/subscriptions/x')).toThrow(ConnectorError)
    expect(() => resourcePath('p', 'topics', '1bad')).toThrow(/isn't a topic name/)
    expect(() => resourcePath('p', 'topics', 'a/b')).toThrow(ConnectorError)
  })
})

describe('PubSubClient', () => {
  it('publishes and pulls data, attributes and ordering keys; an ack takes it off', async () => {
    const c = client()
    const ids = await c.publish(
      'orders',
      [
        { data: '{"id":1}', attributes: { kind: 'created' } },
        { data: Buffer.from([0xff, 0x00]), orderingKey: 'k1' },
      ],
      signal(),
    )
    expect(ids).toHaveLength(2)
    const got = await c.pull('orders-sub', 10, signal())
    expect(got.map((r) => r.message.messageId)).toEqual(ids)
    expect(got[0]!.message).toMatchObject({ attributes: { kind: 'created' } })
    expect(got[0]!.message.data.toString()).toBe('{"id":1}')
    expect(got[1]!.message.orderingKey).toBe('k1')
    expect(got[0]!.deliveryAttempt).toBeUndefined()
    await c.acknowledge(
      'orders-sub',
      got.map((r) => r.ackId),
      signal(),
    )
    expect(await c.pull('orders-sub', 10, signal())).toEqual([])
  })

  it('redelivers after a nack or a passed deadline, with a new ack id; extending keeps it', async () => {
    const c = client()
    pubsub.publish('orders', 'again')
    const [first] = await c.pull('orders-sub', 1, signal())
    await c.nack('orders-sub', [first!.ackId], signal())
    const [second] = await c.pull('orders-sub', 1, signal())
    expect(second!.message.messageId).toBe(first!.message.messageId)
    expect(second!.ackId).not.toBe(first!.ackId)
    // Extended past its 4 s (200 ms) deadline: not redelivered meanwhile.
    await c.modifyAckDeadline('orders-sub', [second!.ackId], 20, signal())
    await new Promise((r) => setTimeout(r, 300))
    expect(await c.pull('orders-sub', 1, signal())).toEqual([])
    // A stale ack id does nothing; the current one acks.
    await c.acknowledge('orders-sub', [first!.ackId], signal())
    expect(pubsub.outstanding('orders-sub')).toBe(1)
    await c.acknowledge('orders-sub', [second!.ackId], signal())
    expect(pubsub.outstanding('orders-sub')).toBe(0)
    // Left alone past the deadline, it goes out again.
    pubsub.publish('orders', 'expires')
    const [out] = await c.pull('orders-sub', 1, signal())
    await new Promise((r) => setTimeout(r, 300))
    const [back] = await c.pull('orders-sub', 1, signal())
    expect(back!.message.messageId).toBe(out!.message.messageId)
    await c.acknowledge('orders-sub', [back!.ackId], signal())
  })

  it('sends an acked message out again when told to, as a lost ack would', async () => {
    const c = client()
    for (const r of await c.pull('orders-sub', 50, signal()))
      await c.acknowledge('orders-sub', [r.ackId], signal())
    const id = pubsub.publish('orders', 'twice')
    const [first] = await c.pull('orders-sub', 1, signal())
    await c.acknowledge('orders-sub', [first!.ackId], signal())
    pubsub.redeliver('orders-sub', id)
    const [again] = await c.pull('orders-sub', 1, signal())
    expect(again!.message.messageId).toBe(id)
    await c.acknowledge('orders-sub', [again!.ackId], signal())
    expect(pubsub.messages('orders-sub').find((m) => m.messageId === id)).toMatchObject({
      deliveries: 2,
      acked: true,
    })
  })

  it('counts delivery attempts and dead-letters past the policy', async () => {
    const c = client()
    for (const r of await c.pull('orders-dl', 10, signal()))
      await c.acknowledge('orders-dl', [r.ackId], signal())
    pubsub.publish('orders', 'poison')
    const [one] = await c.pull('orders-dl', 1, signal())
    expect(one!.deliveryAttempt).toBe(1)
    await c.nack('orders-dl', [one!.ackId], signal())
    const [two] = await c.pull('orders-dl', 1, signal())
    expect(two!.deliveryAttempt).toBe(2)
    await c.nack('orders-dl', [two!.ackId], signal())
    expect(await c.pull('orders-dl', 1, signal())).toEqual([])
    expect(pubsub.published('orders-dead').map((m) => m.data)).toEqual(['poison'])
    const info = await c.getSubscription('orders-dl', signal())
    expect(info).toMatchObject({
      topic: 'projects/fake-project/topics/orders',
      deadLetterPolicy: {
        deadLetterTopic: 'projects/fake-project/topics/orders-dead',
        maxDeliveryAttempts: 2,
      },
    })
  })

  it("holds a key's next message until the one before is acked", async () => {
    const c = client()
    for (const r of await c.pull('ordered', 50, signal())) await c.acknowledge('ordered', [r.ackId], signal())
    await c.publish(
      'orders',
      [1, 2, 3].map((n) => ({ data: `k${n}`, orderingKey: 'k' })),
      signal(),
    )
    const first = await c.pull('ordered', 10, signal())
    expect(first.map((r) => r.message.data.toString())).toEqual(['k1'])
    await c.acknowledge('ordered', [first[0]!.ackId], signal())
    expect((await c.pull('ordered', 10, signal())).map((r) => r.message.data.toString())).toEqual(['k2'])
  })

  it("says what's wrong: no access, not found, a refused token, and what's worth retrying", async () => {
    const denied = await client()
      .pull('secret', 1, signal())
      .catch((e: unknown) => e)
    expect(denied).toBeInstanceOf(ConnectorError)
    expect(denied).toMatchObject({ code: 'connection', details: { status: 403, retryable: false } })
    expect((denied as Error).message).toContain('roles/pubsub.subscriber')
    const missing = await client()
      .getSubscription('nope', signal())
      .catch((e: unknown) => e)
    expect(missing).toMatchObject({ code: 'query', details: { status: 404 } })
    expect((missing as Error).message).toContain('Resource not found')
    const refused = await client('stale')
      .getTopic('orders', signal())
      .catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'connection', details: { status: 401 } })
    pubsub.failNext('pull', 503, 'The service was unable to fulfill your request.')
    const busy = await client()
      .pull('orders-sub', 1, signal())
      .catch((e: unknown) => e)
    expect(busy).toMatchObject({ code: 'query', details: { status: 503, retryable: true } })
  })

  it('takes a fresh token once after a 401', async () => {
    const asked: boolean[] = []
    const c = new PubSubClient({
      project: 'fake-project',
      url: pubsub.url,
      tokens: {
        token: async (_s, force) => {
          asked.push(!!force)
          return force ? 'good' : 'stale'
        },
      },
    })
    expect(await c.getTopic('orders', signal())).toEqual({ name: 'projects/fake-project/topics/orders' })
    expect(asked).toEqual([false, true])
  })
})
