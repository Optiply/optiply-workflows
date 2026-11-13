import { describe, expect, it } from 'vitest'
import { queueMessageLine } from './runs-api'

describe('queueMessageLine (M26)', () => {
  it("names a queue-triggered run's message, and nothing for other runs", () => {
    expect(
      queueMessageLine({
        triggerType: 'pubsub',
        input: { message: { messageId: 'm1', publishTime: '', attributes: {}, subscription: 'orders-sub' } },
      }),
    ).toBe('Pub/Sub message m1 · orders-sub')
    expect(
      queueMessageLine({
        triggerType: 'sqs',
        input: {
          message: {
            messageId: 's1',
            queue: 'https://sqs.eu-west-1.amazonaws.com/1/orders',
            receiveCount: 2,
          },
        },
      }),
    ).toBe('SQS message s1 · orders · receive 2')
    expect(
      queueMessageLine({
        triggerType: 'kafka',
        input: { message: { topic: 'orders', partition: 1, offset: '42', key: 'k', attempt: 3 } },
      }),
    ).toBe('Kafka orders/1@42 · key k · attempt 3')
    // M30: decoded by the Schema Registry.
    expect(
      queueMessageLine({
        triggerType: 'kafka',
        input: {
          message: { topic: 'orders', partition: 0, offset: '7', key: null, schemaId: 3, attempt: 1 },
        },
      }),
    ).toBe('Kafka orders/0@7 · schema 3')
    expect(queueMessageLine({ triggerType: 'webhook', input: { data: {} } })).toBeUndefined()
  })
})
