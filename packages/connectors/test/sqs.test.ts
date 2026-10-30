import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureAws } from '../src/aws/credentials'
import { type FakeAws, type FakeAwsKey, startFakeAws } from '../src/aws/fake'
import { sqsClient, sqsConnector } from '../src/aws/sqs'
import { PoolManager } from '../src/pool'
import { runQuery, testResource } from '../src/run'
import { codeEvaluator, resource } from './helpers'

// The `sqs` resource (M26 step 2b) against the fake AWS (STS and SQS, signatures checked); an SQS second is 50 ms.
let aws: FakeAws
let user: FakeAwsKey
const pool = new PoolManager()
const region = 'eu-west-1'
const keyed = (config: Record<string, unknown> = {}) =>
  resource(
    { region, identity: 'key', accessKeyId: user.accessKeyId, ...config },
    { secretAccessKey: user.secretAccessKey },
  )
const send = (res: ReturnType<typeof resource>, queue: string, messages: string, values = {}) =>
  runQuery(pool, sqsConnector, res, { queue, messages }, { evaluate: codeEvaluator(values) })
const signal = () => AbortSignal.timeout(5_000)

beforeAll(async () => {
  aws = await startFakeAws({ sqs: { secondMs: 50 } })
  user = aws.addUser('workflows')
  configureAws({ stsEndpoint: aws.url, sqsEndpoint: aws.url })
  aws.sqs.createQueue('orders')
  aws.sqs.createQueue('orders.fifo')
  aws.sqs.createQueue('jobs-dlq')
  aws.sqs.createQueue('jobs', {
    visibilityTimeout: 2,
    redrive: { deadLetterQueue: 'jobs-dlq', maxReceiveCount: 2 },
  })
})
afterAll(async () => {
  configureAws({})
  await pool.closeAll()
  await aws.close()
})

describe('sqs resource', () => {
  it("tests the connection as the key's user", async () => {
    expect(await testResource(sqsConnector, keyed())).toMatchObject({
      ok: true,
      message: `SQS in eu-west-1 as ${user.arn}`,
    })
  })

  it('passes Test connection when it may not list queues, and fails on a wrong secret', async () => {
    aws.fail('ListQueues', 'AccessDenied', 403)
    expect(await testResource(sqsConnector, keyed())).toMatchObject({
      ok: true,
      message: expect.stringContaining("it can't list queues"),
    })
    const wrong = resource(
      { region, identity: 'key', accessKeyId: user.accessKeyId },
      { secretAccessKey: 'nope' },
    )
    expect(await testResource(sqsConnector, wrong)).toMatchObject({
      ok: false,
      error: { code: 'connection', message: expect.stringContaining('SignatureDoesNotMatch') },
    })
  })

  it('sends one message or many, by queue name or URL, bodies as JSON unless text, with typed attributes', async () => {
    const one = await send(
      keyed(),
      'orders',
      '{"body": {{ order }}, "attributes": {"kind": "created", "n": 3}}',
      {
        order: { id: 7 },
      },
    )
    expect(one.data).toEqual([{ messageId: expect.any(String) }])
    expect(one.metadata).toEqual({ queue: aws.sqs.queueUrl('orders'), sent: 1 })
    const many = await send(keyed(), aws.sqs.queueUrl('orders'), '{{ batch }}', {
      batch: Array.from({ length: 12 }, (_, i) => ({ body: i === 0 ? 'plain text' : i })),
    })
    expect(many.data).toHaveLength(12)
    const stored = aws.sqs.messages('orders')
    expect(stored[0]).toMatchObject({
      body: '{"id":7}',
      attributes: {
        kind: { DataType: 'String', StringValue: 'created' },
        n: { DataType: 'Number', StringValue: '3' },
      },
    })
    expect(stored.slice(1).map((m) => m.body)).toEqual([
      'plain text',
      ...Array.from({ length: 11 }, (_, i) => String(i + 1)),
    ])
    // Two batches of SendMessageBatch (10 and 2), signed by the user.
    expect(aws.calls.filter((c) => c.action === 'SendMessageBatch').slice(-2)).toEqual([
      { service: 'sqs', action: 'SendMessageBatch', arn: user.arn },
      { service: 'sqs', action: 'SendMessageBatch', arn: user.arn },
    ])
  })

  it('sends to a FIFO queue with groups, and reports a message SQS refused with what went out before', async () => {
    const sent = await send(keyed(), 'orders.fifo', '{{ x }}', {
      x: [
        { body: 'a', groupId: 'g', deduplicationId: '1' },
        { body: 'b', groupId: 'g', deduplicationId: '2' },
      ],
    })
    expect(sent.data).toEqual([
      { messageId: expect.any(String), sequenceNumber: expect.any(String) },
      { messageId: expect.any(String), sequenceNumber: expect.any(String) },
    ])
    await expect(send(keyed(), 'orders.fifo', '{{ x }}', { x: [{ body: 'no group' }] })).rejects.toThrow(
      "Message 1 wasn't sent: The request must contain MessageGroupId.",
    )
  })

  it('names a queue that is not there, and refuses messages that are not {body, …}', async () => {
    await expect(send(keyed(), 'nowhere', '{"body": 1}')).rejects.toThrow('No queue "nowhere" in eu-west-1')
    await expect(send(keyed(), 'orders', '{{ x }}', { x: [{ nope: 1 }] })).rejects.toThrow(
      'Message 1: write it as {"body": …, "attributes": {…}}',
    )
    await expect(send(keyed(), 'orders', '{{ x }}', { x: [] })).rejects.toThrow('No messages to send')
    await expect(send(keyed(), 'orders', '{"body": 1, "delaySeconds": 901}')).rejects.toThrow(
      'delaySeconds is 0–900',
    )
  })
})

describe('the SQS client the trigger receives with', () => {
  it('receives with attributes, keeps a message by its visibility, deletes it; a failed one comes back, then to the DLQ', async () => {
    const client = sqsClient(
      { region, identity: 'key', accessKeyId: user.accessKeyId },
      { secretAccessKey: user.secretAccessKey },
    )
    try {
      const url = await client.queueUrl('jobs', signal())
      aws.sqs.send('jobs', '{"job":1}', { attributes: { kind: 'x' } })
      aws.sqs.send('jobs', 'two')
      const [first, second] = await client.receive(url, 10, 1, signal())
      expect(first).toMatchObject({
        body: '{"job":1}',
        messageAttributes: { kind: 'x' },
        attributes: { ApproximateReceiveCount: '1', SentTimestamp: expect.any(String) },
      })
      // Kept invisible past its 2 s (100 ms) timeout, then deleted.
      await client.changeVisibility(url, [first!.receiptHandle, second!.receiptHandle], 60, signal())
      await new Promise((r) => setTimeout(r, 200))
      await client.delete(url, first!.receiptHandle, signal())
      // The second handed back at once (a failed run), received again, handed back again: its count passes the
      // redrive policy's 2, and the next receive moves it to the dead-letter queue.
      await client.changeVisibility(url, [second!.receiptHandle], 0, signal())
      const again = await client.receive(url, 10, 1, signal())
      expect(again).toMatchObject([{ body: 'two', attributes: { ApproximateReceiveCount: '2' } }])
      await client.changeVisibility(url, [again[0]!.receiptHandle], 0, signal())
      expect(await client.receive(url, 10, 0, signal())).toEqual([])
      expect(aws.sqs.messages('jobs-dlq')).toMatchObject([{ body: 'two', movedFrom: 'jobs' }])
      expect(aws.sqs.messages('jobs').filter((m) => !m.deleted)).toEqual([])
    } finally {
      client.close()
    }
  })

  it('long-polls until a message arrives', async () => {
    const client = sqsClient(
      { region, identity: 'key', accessKeyId: user.accessKeyId },
      { secretAccessKey: user.secretAccessKey },
    )
    try {
      const url = await client.queueUrl('orders.fifo', signal())
      for (const m of await client.receive(url, 10, 0, signal()))
        await client.delete(url, m.receiptHandle, signal())
      setTimeout(() => aws.sqs.send('orders.fifo', 'late', { groupId: 'g', deduplicationId: 'late' }), 100)
      const got = await client.receive(url, 1, 20, signal())
      expect(got).toMatchObject([{ body: 'late', attributes: { MessageGroupId: 'g' } }])
    } finally {
      client.close()
    }
  })
})
