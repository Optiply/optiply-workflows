import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureAws, PoolManager, runQuery, snsConnector, snsMessage, testResource } from '../src'
import { type FakeAws, type FakeAwsKey, startFakeAws } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// The `sns` resource (M30 step 3) against the fake AWS.
let aws: FakeAws
let user: FakeAwsKey
const pool = new PoolManager()

beforeAll(async () => {
  aws = await startFakeAws()
  user = aws.addUser('publisher')
  configureAws({ stsEndpoint: aws.url, snsEndpoint: aws.url })
})
afterAll(async () => {
  await pool.closeAll()
  configureAws({})
  await aws.close()
})

const topics = () =>
  resource(
    { region: 'eu-west-1', identity: 'key', accessKeyId: user.accessKeyId },
    { secretAccessKey: user.secretAccessKey },
    'sns',
  )
const publish = (fields: Record<string, string>, scope = {}) =>
  runQuery(
    pool,
    snsConnector,
    topics(),
    { action: 'publish', ...fields },
    { evaluate: scopeEvaluator(scope) },
  )

describe('sns', () => {
  it('reads a message: JSON bodies, subjects, attributes', () => {
    expect(
      snsMessage(
        { message: { sku: 'A' }, subject: 'New', attributes: { shop: 'nl', n: 2 }, groupId: 'g' },
        0,
      ),
    ).toEqual({
      message: '{"sku":"A"}',
      subject: 'New',
      attributes: {
        shop: { DataType: 'String', StringValue: 'nl' },
        n: { DataType: 'Number', StringValue: '2' },
      },
      groupId: 'g',
    })
    expect(() => snsMessage({ body: 'x' }, 2)).toThrow(/Message 3 needs a message/)
  })

  it('tests the identity, publishes in batches of 10, and reports a missing topic', async () => {
    expect(await testResource(snsConnector, topics())).toMatchObject({
      ok: true,
      message: `SNS in eu-west-1 as ${user.arn}`,
    })
    const arn = aws.sns.createTopic('orders')
    const items = Array.from({ length: 12 }, (_, i) => ({ message: { n: i }, attributes: { shop: 'nl' } }))
    const out = await publish({ topicArn: arn, messages: '{{ items }}' }, { items })
    expect(out.metadata).toMatchObject({ topicArn: arn, published: 12 })
    expect(aws.sns.messages.filter((m) => m.topicArn === arn).map((m) => m.message)).toEqual(
      items.map((i) => JSON.stringify(i.message)),
    )
    expect(aws.sns.messages.at(-1)?.attributes).toEqual({ shop: 'nl' })
    expect(aws.calls.filter((c) => c.service === 'sns').length).toBe(2)
    await expect(
      publish({ topicArn: 'arn:aws:sns:eu-west-1:123456789012:nope', messages: '{"message": "x"}' }),
    ).rejects.toThrow(/does not exist|NotFound/)
    await expect(publish({ topicArn: 'orders', messages: '{"message": "x"}' })).rejects.toThrow(
      /isn't a topic ARN/,
    )
    await expect(publish({ topicArn: `${arn}.fifo`, messages: '{"message": "x"}' })).rejects.toThrow(
      /groupId/,
    )
  })
})
