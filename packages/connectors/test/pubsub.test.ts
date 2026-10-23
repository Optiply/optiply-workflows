import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serverIdentity } from '../src/google-auth'
import { PoolManager } from '../src/pool'
import { configurePubSub, pubsubConnector } from '../src/pubsub/connector'
import { type FakePubSub, startFakePubSub } from '../src/pubsub/fake'
import { runQuery, testResource } from '../src/run'
import { FakeGoogle } from './google-fake'
import { codeEvaluator, resource } from './helpers'

// The `pubsub` resource (M19) against the fake Pub/Sub endpoint; a fake Google issues the key's tokens (`sa-N`) and
// the metadata server's (`md-N`).
const google = new FakeGoogle()
let pubsub: FakePubSub
const pool = new PoolManager()
const keyed = (config: Record<string, unknown> = {}) =>
  resource({ identity: 'key', ...config }, { serviceAccountKey: google.keyJson })
const publish = (res: ReturnType<typeof resource>, topic: string, messages: string, values = {}) =>
  runQuery(pool, pubsubConnector, res, { topic, messages }, { evaluate: codeEvaluator(values) })

beforeAll(async () => {
  await google.start()
  pubsub = await startFakePubSub({ project: 'fake-project', pullWaitMs: 50 })
  pubsub.createTopic('orders')
  pubsub.createSubscription('orders-sub', { topic: 'orders' })
  configurePubSub({ url: pubsub.url, tokenUrl: google.tokenUrl })
})
afterEach(() => configurePubSub({ url: pubsub.url, tokenUrl: google.tokenUrl }))
afterAll(async () => {
  configurePubSub({})
  await pool.closeAll()
  await pubsub.close()
  await google.stop()
})

describe('pubsub resource', () => {
  it("tests the connection as the key's account, in the key's project by default", async () => {
    const tested = await testResource(pubsubConnector, keyed())
    expect(tested).toMatchObject({
      ok: true,
      message: 'Pub/Sub project fake-project as tunnel@fake-project.iam.gserviceaccount.com',
    })
  })

  it("passes Test connection when it may not list topics (subscribing doesn't need it)", async () => {
    pubsub.failNext('list', 403, 'User not authorized to perform this action.')
    const tested = await testResource(pubsubConnector, keyed())
    expect(tested).toMatchObject({ ok: true, message: expect.stringContaining("it can't list topics") })
  })

  it('publishes one message or many, data as JSON unless text, with attributes and ordering keys', async () => {
    const one = await publish(keyed(), 'orders', '{"data": {{ order }}, "attributes": {"kind": "created"}}', {
      order: { id: 7 },
    })
    expect(one.data).toEqual([{ messageId: expect.any(String) }])
    expect(one.metadata).toEqual({ topic: 'orders', published: 1 })
    const many = await publish(keyed(), 'projects/fake-project/topics/orders', '{{ batch }}', {
      batch: [
        { data: 'plain text', orderingKey: 'k' },
        { data: 42, attributes: { n: 1 } },
      ],
    })
    expect(many.data).toHaveLength(2)
    expect(pubsub.published('orders').slice(-3)).toEqual([
      {
        messageId: one.data && (one.data as { messageId: string }[])[0]!.messageId,
        data: '{"id":7}',
        attributes: { kind: 'created' },
      },
      expect.objectContaining({ data: 'plain text', orderingKey: 'k' }),
      expect.objectContaining({ data: '42', attributes: { n: '1' } }),
    ])
  })

  it("refuses messages that aren't {data, …}, and too many at once", async () => {
    await expect(publish(keyed(), 'orders', '{{ x }}', { x: [{ nope: 1 }] })).rejects.toThrow(
      'Message 1: write it as {"data": …, "attributes": {…}}',
    )
    await expect(publish(keyed(), 'orders', '{{ x }}', { x: [] })).rejects.toThrow('No messages to publish')
    await expect(
      publish(keyed(), 'orders', '{{ x }}', { x: Array.from({ length: 1001 }, () => ({ data: 1 })) }),
    ).rejects.toThrow('At most 1000 messages')
    await expect(publish(keyed(), 'nope', '{"data": 1}')).rejects.toThrow(/Resource not found/)
  })

  it("uses the server's identity only where the instance allows it, in a project named for it", async () => {
    const server = resource({ identity: 'server', project: 'fake-project' })
    const refused = await testResource(pubsubConnector, server)
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
    expect(refused.ok === false && refused.error.message).toContain(
      "doesn't let resources use its own Google identity",
    )
    configurePubSub({
      url: pubsub.url,
      tokenUrl: google.tokenUrl,
      serverIdentity: serverIdentity({ scope: 's', env: { GCE_METADATA_HOST: google.metadataHost } }),
    })
    expect(await testResource(pubsubConnector, server)).toMatchObject({
      ok: true,
      message: 'Pub/Sub project fake-project as vm@fake-project.iam.gserviceaccount.com',
    })
    // The server's identity was approved for its project only: other projects' names are refused.
    const elsewhere = await publish(server, 'projects/secret-prod/topics/x', '{"data": 1}').catch(
      (e: Error) => e,
    )
    expect(elsewhere).toMatchObject({ code: 'invalid_query' })
    expect((elsewhere as Error).message).toContain('for project fake-project only')
    // A key may name another project (its own roles decide).
    await expect(publish(keyed(), 'projects/secret-prod/topics/x', '{"data": 1}')).rejects.toThrow(
      /Resource not found/,
    )
    const noProject = await testResource(pubsubConnector, resource({ identity: 'server' }))
    expect(noProject).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', message: expect.stringContaining('Name the project') },
    })
  })

  it('needs a key that is one for identity key', async () => {
    const missing = await testResource(pubsubConnector, resource({ identity: 'key' }))
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', message: expect.stringContaining('serviceAccountKey') },
    })
    expect(pubsubConnector.secretsSchema.safeParse({ serviceAccountKey: '{"no":1}' }).success).toBe(false)
  })
})
