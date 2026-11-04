import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { ServiceHandler } from './fake'
import { jsonError } from './fake'

// A fake of Kinesis Data Streams for tests (M30): streams of shards over the 128-bit hash range (a record's shard by
// the MD5 of its partition key, as Kinesis does), PutRecords, ListShards, GetShardIterator (TRIM_HORIZON, LATEST,
// AT_/AFTER_SEQUENCE_NUMBER), GetRecords (a closed shard read to its end answers no next iterator), splitting a
// shard in two and merging two adjacent ones (the parents close; the children take new records), and throttling a
// shard's next read fail.

export interface FakeKinesisShard {
  id: string
  parent?: string
  /** A merge's second parent. */
  adjacentParent?: string
  start: bigint
  end: bigint
  closed: boolean
  records: { seq: string; key: string; data: Buffer; at: number }[]
}

export interface FakeKinesis {
  createStream(name: string, shards?: number): void
  /** Splits a shard at the middle of its range: it closes, two children take its new records. */
  split(stream: string, shardId: string): [string, string]
  /** Merges two adjacent shards (`a` below `b`): both close, one child (parent `a`, adjacent parent `b`). */
  merge(stream: string, a: string, b: string): string
  /** The shard's next GetRecords fails with this error code (one the SDK doesn't retry itself, to reach the caller). */
  failNext(stream: string, shardId: string, code: string): void
  shards(stream: string): FakeKinesisShard[]
  /** Puts a record directly (as another producer would). */
  put(stream: string, data: string, partitionKey: string): { shardId: string; seq: string }
}

const MAX = (1n << 128n) - 1n

export function fakeKinesis(handlers: Map<string, ServiceHandler>, account: string): FakeKinesis {
  const streams = new Map<string, FakeKinesisShard[]>()
  let seq = 0n
  let shardSeq = 0
  const failing = new Map<string, string>()
  const nextSeq = () => (49_000_000_000_000_000_000n + ++seq).toString()
  const shardId = () => `shardId-${String(shardSeq++).padStart(12, '0')}`
  const nameOf = (body: Record<string, unknown>) => {
    const arn = body.StreamARN as string | undefined
    return arn ? arn.split('/').pop()! : String(body.StreamName ?? '')
  }

  const put = (stream: string, data: Buffer, key: string) => {
    const shards = streams.get(stream)
    if (!shards)
      throw Object.assign(new Error(`Stream ${stream} under account ${account} not found.`), {
        code: 'ResourceNotFoundException',
      })
    const hash = BigInt(`0x${createHash('md5').update(key).digest('hex')}`)
    const shard = shards.find((s) => !s.closed && hash >= s.start && hash <= s.end)!
    const record = { seq: nextSeq(), key, data, at: Date.now() / 1000 }
    shard.records.push(record)
    return { shardId: shard.id, seq: record.seq }
  }

  const reply = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
    res.end(JSON.stringify(body))
  }

  handlers.set('kinesis', async (req, res) => {
    const action = String(req.headers['x-amz-target'] ?? '')
      .split('.')
      .pop()
    const body = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>
    const fail = (code: string, message: string, status = 400) => jsonError(res, status, code, message)
    try {
      switch (action) {
        case 'PutRecords': {
          const name = nameOf(body)
          if (!streams.has(name))
            return fail('ResourceNotFoundException', `Stream ${name} under account ${account} not found.`)
          const records = (body.Records as { Data: string; PartitionKey: string }[]) ?? []
          if (records.length > 500) return fail('ValidationException', 'Records has more than 500 elements')
          const out = records.map((r) => {
            const p = put(name, Buffer.from(r.Data, 'base64'), r.PartitionKey)
            return { ShardId: p.shardId, SequenceNumber: p.seq }
          })
          return reply(res, { FailedRecordCount: 0, Records: out })
        }
        case 'ListShards': {
          const name = body.NextToken ? String(body.NextToken) : nameOf(body)
          const shards = streams.get(name)
          if (!shards)
            return fail('ResourceNotFoundException', `Stream ${name} under account ${account} not found.`)
          return reply(res, {
            Shards: shards.map((s) => ({
              ShardId: s.id,
              ...(s.parent && { ParentShardId: s.parent }),
              ...(s.adjacentParent && { AdjacentParentShardId: s.adjacentParent }),
              HashKeyRange: { StartingHashKey: s.start.toString(), EndingHashKey: s.end.toString() },
              SequenceNumberRange: {
                StartingSequenceNumber: s.records[0]?.seq ?? '0',
                ...(s.closed && { EndingSequenceNumber: s.records.at(-1)?.seq ?? '0' }),
              },
            })),
          })
        }
        case 'GetShardIterator': {
          const shards = streams.get(nameOf(body))
          const shard = shards?.find((s) => s.id === body.ShardId)
          if (!shard) return fail('ResourceNotFoundException', `Shard ${String(body.ShardId)} not found.`)
          const type = String(body.ShardIteratorType)
          const at = String(body.StartingSequenceNumber ?? '')
          let index: number
          if (type === 'TRIM_HORIZON') index = 0
          else if (type === 'LATEST') index = shard.records.length
          else if (type === 'AT_SEQUENCE_NUMBER')
            index = Math.max(
              0,
              shard.records.findIndex((r) => BigInt(r.seq) >= BigInt(at)),
            )
          else if (type === 'AFTER_SEQUENCE_NUMBER') {
            const i = shard.records.findIndex((r) => BigInt(r.seq) > BigInt(at))
            index = i === -1 ? shard.records.length : i
          } else return fail('ValidationException', `ShardIteratorType ${type}`)
          return reply(res, {
            ShardIterator: Buffer.from(`${nameOf(body)}|${shard.id}|${index}`).toString('base64'),
          })
        }
        case 'GetRecords': {
          const [name, id, start] = Buffer.from(String(body.ShardIterator), 'base64').toString().split('|')
          const shard = streams.get(name!)?.find((s) => s.id === id)
          if (!shard) return fail('ExpiredIteratorException', 'Iterator expired')
          const failure = failing.get(`${name}|${id}`)
          if (failure) {
            failing.delete(`${name}|${id}`)
            return fail(failure, `The fake failed this read (${failure})`)
          }
          const from = Number(start)
          const limit = Number(body.Limit ?? 10_000)
          const page = shard.records.slice(from, from + limit)
          const next = from + page.length
          const done = shard.closed && next >= shard.records.length
          return reply(res, {
            Records: page.map((r) => ({
              SequenceNumber: r.seq,
              PartitionKey: r.key,
              Data: r.data.toString('base64'),
              ApproximateArrivalTimestamp: r.at,
            })),
            ...(done ? {} : { NextShardIterator: Buffer.from(`${name}|${id}|${next}`).toString('base64') }),
            MillisBehindLatest: 0,
            ...(done && {
              ChildShards: streams
                .get(name!)!
                .filter((s) => s.parent === id || s.adjacentParent === id)
                .map((s) => ({ ShardId: s.id, ParentShards: [s.parent, s.adjacentParent].filter(Boolean) })),
            }),
          })
        }
        default:
          return fail('UnknownOperationException', `The fake doesn't do ${action}`)
      }
    } catch (err) {
      return fail((err as { code?: string }).code ?? 'InternalFailure', (err as Error).message, 400)
    }
  })

  return {
    createStream(name, count = 1) {
      const shards: FakeKinesisShard[] = []
      const size = (MAX + 1n) / BigInt(count)
      for (let i = 0; i < count; i++)
        shards.push({
          id: shardId(),
          start: size * BigInt(i),
          end: i === count - 1 ? MAX : size * BigInt(i + 1) - 1n,
          closed: false,
          records: [],
        })
      streams.set(name, shards)
    },
    split(stream, id) {
      const shards = streams.get(stream)!
      const parent = shards.find((s) => s.id === id)!
      parent.closed = true
      const mid = parent.start + (parent.end - parent.start) / 2n
      const a = { id: shardId(), parent: id, start: parent.start, end: mid, closed: false, records: [] }
      const b = { id: shardId(), parent: id, start: mid + 1n, end: parent.end, closed: false, records: [] }
      shards.push(a, b)
      return [a.id, b.id]
    },
    merge(stream, a, b) {
      const shards = streams.get(stream)!
      const low = shards.find((s) => s.id === a)!
      const high = shards.find((s) => s.id === b)!
      low.closed = true
      high.closed = true
      const child = {
        id: shardId(),
        parent: a,
        adjacentParent: b,
        start: low.start,
        end: high.end,
        closed: false,
        records: [],
      }
      shards.push(child)
      return child.id
    },
    failNext(stream, id, code) {
      failing.set(`${stream}|${id}`, code)
    },
    shards: (stream) => streams.get(stream) ?? [],
    put: (stream, data, key) => put(stream, Buffer.from(data), key),
  }
}
