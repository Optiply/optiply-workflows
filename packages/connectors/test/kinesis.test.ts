import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAws,
  kinesisClient,
  kinesisConnector,
  kinesisRecord,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import { type FakeAws, type FakeAwsKey, startFakeAws } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// The `kinesis` resource (M30 step 4) against the fake AWS.
let aws: FakeAws
let user: FakeAwsKey
const pool = new PoolManager()

beforeAll(async () => {
  aws = await startFakeAws()
  user = aws.addUser('producer')
  configureAws({ stsEndpoint: aws.url, kinesisEndpoint: aws.url })
})
afterAll(async () => {
  await pool.closeAll()
  configureAws({})
  await aws.close()
})

const config = () => ({ region: 'eu-west-1', identity: 'key' as const, accessKeyId: user.accessKeyId })
const streams = () => resource(config(), { secretAccessKey: user.secretAccessKey }, 'kinesis')
const put = (fields: Record<string, string>, scope = {}) =>
  runQuery(
    pool,
    kinesisConnector,
    streams(),
    { action: 'putRecords', ...fields },
    { evaluate: scopeEvaluator(scope) },
  )

describe('kinesis', () => {
  it('reads a record: JSON data, a random key without one', () => {
    const r = kinesisRecord({ data: { n: 1 }, partitionKey: 'order-1' }, 0)
    expect(Buffer.from(r.Data).toString()).toBe('{"n":1}')
    expect(r.PartitionKey).toBe('order-1')
    expect(kinesisRecord({ data: 'x' }, 0).PartitionKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => kinesisRecord({ value: 1 }, 1)).toThrow(/Record 2 needs data/)
  })

  it('puts records (in 500s), keeps a key on one shard, and reads them back in order', async () => {
    expect(await testResource(kinesisConnector, streams())).toMatchObject({
      ok: true,
      message: `Kinesis in eu-west-1 as ${user.arn}`,
    })
    aws.kinesis.createStream('orders', 2)
    const items = Array.from({ length: 520 }, (_, i) => ({ data: { n: i }, partitionKey: `k${i % 3}` }))
    const out = await put({ stream: 'orders', records: '{{ items }}' }, { items })
    expect(out.metadata).toMatchObject({ stream: 'orders', put: 520 })
    const shardOf = new Map<string, Set<string>>()
    for (const [i, r] of (out.data as { shardId: string }[]).entries()) {
      const key = items[i]!.partitionKey
      shardOf.set(key, (shardOf.get(key) ?? new Set()).add(r.shardId))
    }
    for (const shards of shardOf.values()) expect(shards.size).toBe(1)

    const client = kinesisClient(config(), { secretAccessKey: user.secretAccessKey })
    const signal = AbortSignal.timeout(5000)
    const shards = await client.shards('orders', signal)
    expect(shards).toHaveLength(2)
    let seen = 0
    for (const s of shards) {
      let it = await client.iterator('orders', s.ShardId!, { type: 'TRIM_HORIZON' }, signal)
      let last = -1n
      while (it) {
        const page = await client.records(it, 100, signal)
        for (const r of page.records) {
          expect(BigInt(r.sequenceNumber) > last).toBe(true)
          last = BigInt(r.sequenceNumber)
          seen++
        }
        if (!page.records.length) break
        it = page.next
      }
    }
    expect(seen).toBe(520)
    client.close()
    await expect(put({ stream: 'nope', records: '{"data": 1}' })).rejects.toThrow(/not found/)
  })
})
