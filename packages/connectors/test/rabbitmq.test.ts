import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PoolManager } from '../src/pool'
import { rabbitMessage, rabbitmqConnector } from '../src/rabbitmq/connector'
import { rabbitAvailable, startTestRabbit, type TestRabbit } from '../src/rabbitmq/test-rabbitmq'
import { runQuery, testResource } from '../src/run'
import { resource, scopeEvaluator } from './helpers'

// The `rabbitmq` resource (M30 step 1) against a throwaway RabbitMQ 4.1. Skipped locally without Docker; CI runs it.
const available = rabbitAvailable()
let rabbit: TestRabbit
const pool = new PoolManager()

beforeAll(async () => {
  if (!available) return
  rabbit = await startTestRabbit()
  await rabbit.declare('orders')
}, 120_000)
afterAll(async () => {
  await pool.closeAll()
  await rabbit?.stop()
})

const broker = (config: object = {}, password = rabbit.password) =>
  resource(
    { host: rabbit.host, port: rabbit.port, username: rabbit.username, allowPrivateNetwork: true, ...config },
    { password },
    `${JSON.stringify(config)}${password}`,
  )
const publish = (query: object, scope = {}, r = broker()) =>
  runQuery(pool, rabbitmqConnector, r, { action: 'publish', ...query }, { evaluate: scopeEvaluator(scope) })

describe('rabbit messages', () => {
  it('reads a message: JSON bodies, headers, persistence, priority', () => {
    expect(rabbitMessage({ body: { sku: 'A' }, headers: { shop: 'nl' }, priority: 3 }, 0)).toEqual({
      body: Buffer.from('{"sku":"A"}'),
      contentType: 'application/json',
      headers: { shop: 'nl' },
      persistent: true,
      priority: 3,
    })
    expect(rabbitMessage({ body: 'plain', persistent: false, messageId: 7 }, 0)).toEqual({
      body: Buffer.from('plain'),
      persistent: false,
      messageId: '7',
    })
    expect(() => rabbitMessage('x', 1)).toThrow(/Message 2 needs a body/)
    expect(() => rabbitMessage({ body: 'x', priority: 300 }, 0)).toThrow(/priority/)
  })
})

describe.skipIf(!available)('rabbitmq resource', () => {
  it('tests the connection, refuses a wrong password and a private host without the setting', async () => {
    expect(await testResource(rabbitmqConnector, broker())).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^RabbitMQ 4\.1\.\d+ at 127\.0\.0\.1$/),
    })
    expect(await testResource(rabbitmqConnector, broker({}, 'wrong'))).toMatchObject({ ok: false })
    const guarded = await testResource(rabbitmqConnector, broker({ allowPrivateNetwork: false }))
    expect(guarded).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })

  it('publishes to a queue through the default exchange, confirmed, with headers and ids', async () => {
    const out = await publish(
      {
        routingKey: 'orders',
        messages:
          '[{"body": {"order": {{ id }}}, "headers": {"shop": "nl"}, "messageId": "o-{{ id }}"}, {"body": "second"}]',
      },
      { id: 12 },
    )
    expect(out).toMatchObject({ data: { published: 2 }, metadata: { exchange: '', routingKey: 'orders' } })
    expect(await rabbit.drain('orders')).toEqual([
      { body: '{"order":12}', headers: { shop: 'nl' }, messageId: 'o-12', redelivered: false },
      { body: 'second', headers: {}, redelivered: false },
    ])
  })

  it('reports a message no queue takes, and an exchange that does not exist', async () => {
    await expect(publish({ routingKey: 'nobody-listens', messages: '{"body": "x"}' })).rejects.toThrow(
      /No queue is bound to the default exchange with routing key "nobody-listens"/,
    )
    await expect(
      publish({ exchange: 'no-such-exchange', routingKey: 'x', messages: '{"body": "x"}' }),
    ).rejects.toThrow(/NOT_FOUND|no exchange/i)
    // The resource still works after the broker closed that channel.
    expect(await publish({ routingKey: 'orders', messages: '{"body": "after"}' })).toMatchObject({
      data: { published: 1 },
    })
    expect((await rabbit.drain('orders')).map((m) => m.body)).toEqual(['after'])
    await expect(publish({ messages: '{"body": "x"}' })).rejects.toThrow(/Give an exchange/)
  })
})
