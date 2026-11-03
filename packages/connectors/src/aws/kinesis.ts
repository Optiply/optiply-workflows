import { randomUUID } from 'node:crypto'
import {
  GetRecordsCommand,
  GetShardIteratorCommand,
  KinesisClient,
  ListShardsCommand,
  PutRecordsCommand,
  type Shard,
  type ShardIteratorType,
} from '@aws-sdk/client-kinesis'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { z } from 'zod'
import { type ActionQuery, actionQuerySchema, fieldReader, validateActionQuery } from '../services/common'
import { type Connector, ConnectorError, type QueryResult } from '../types'
import {
  awsCredentials,
  awsDefaults,
  awsError,
  awsIdentityConfig,
  awsIdentitySecrets,
  describeAws,
} from './credentials'

// Kinesis Data Streams (M30): putRecords with M26's AWS identity, and the reads the trigger's adapter makes
// (`packages/engine`): shards, iterators, records.

const configSchema = z.object({ ...awsIdentityConfig })
const secretsSchema = z.object(awsIdentitySecrets)
export type KinesisConfig = z.output<typeof configSchema>
export type KinesisSecrets = z.output<typeof secretsSchema>

export interface KinesisRecord {
  sequenceNumber: string
  partitionKey: string
  data: Buffer
  arrivedAt: string
}

export interface KinesisResourceClient {
  region: string
  kinesis: KinesisClient
  describe(signal: AbortSignal): Promise<string>
  /** Every shard of the stream, open and closed (paged). */
  shards(stream: string, signal: AbortSignal): Promise<Shard[]>
  iterator(
    stream: string,
    shardId: string,
    from: { type: ShardIteratorType; sequenceNumber?: string },
    signal: AbortSignal,
  ): Promise<string | null>
  /** Records after an iterator, and the next iterator (null once a closed shard is read to its end). */
  records(
    iterator: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ records: KinesisRecord[]; next: string | null; behindMs: number }>
  close(): void
}

/** A stream named by name or ARN, as the API takes it. */
export function streamRef(stream: string): { StreamName: string } | { StreamARN: string } {
  return stream.startsWith('arn:') ? { StreamARN: stream } : { StreamName: stream }
}

export function kinesisClient(config: KinesisConfig, secrets: KinesisSecrets): KinesisResourceClient {
  const credentials = awsCredentials({ ...config, ...secrets })
  const endpoint = awsDefaults().kinesisEndpoint
  // HTTP/1.1: the SDK's default HTTP/2 handler is for SubscribeToShard, which this doesn't use; every call made here
  // works over HTTP/1.1, as through proxies and test fakes.
  const kinesis = new KinesisClient({
    region: config.region,
    credentials,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler(),
    ...(endpoint ? { endpoint } : {}),
  })
  return {
    region: config.region,
    kinesis,
    describe: (signal) => describeAws(config.region, credentials, signal),
    async shards(stream, signal) {
      const out: Shard[] = []
      let token: string | undefined
      do {
        const res = await kinesis
          .send(new ListShardsCommand(token ? { NextToken: token } : { ...streamRef(stream) }), {
            abortSignal: signal,
          })
          .catch((err: unknown) => {
            throw awsError(err, `list the shards of ${stream}`)
          })
        out.push(...(res.Shards ?? []))
        token = res.NextToken
      } while (token)
      return out
    },
    async iterator(stream, shardId, from, signal) {
      const res = await kinesis
        .send(
          new GetShardIteratorCommand({
            ...streamRef(stream),
            ShardId: shardId,
            ShardIteratorType: from.type,
            ...(from.sequenceNumber && { StartingSequenceNumber: from.sequenceNumber }),
          }),
          { abortSignal: signal },
        )
        .catch((err: unknown) => {
          throw awsError(err, `read shard ${shardId} of ${stream}`)
        })
      return res.ShardIterator ?? null
    },
    async records(iterator, limit, signal) {
      const res = await kinesis.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: limit }), {
        abortSignal: signal,
      })
      return {
        records: (res.Records ?? []).map((r) => ({
          sequenceNumber: r.SequenceNumber ?? '',
          partitionKey: r.PartitionKey ?? '',
          data: Buffer.from(r.Data ?? new Uint8Array()),
          arrivedAt: (r.ApproximateArrivalTimestamp ?? new Date()).toISOString(),
        })),
        next: res.NextShardIterator ?? null,
        behindMs: res.MillisBehindLatest ?? 0,
      }
    },
    close() {
      kinesis.destroy()
    },
  }
}

const MAX_RECORDS = 5000

/** One record of a putRecords query: data that isn't a string as JSON; a random partition key without one. */
export function kinesisRecord(
  item: unknown,
  i: number,
): { Data: Uint8Array; PartitionKey: string; ExplicitHashKey?: string } {
  const where = `Record ${i + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('data' in item))
    throw new ConnectorError('invalid_query', `${where} needs data ({"data": …})`)
  const r = item as Record<string, unknown>
  const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
  const key =
    r.partitionKey === undefined || r.partitionKey === null || r.partitionKey === ''
      ? randomUUID()
      : String(r.partitionKey)
  if (key.length > 256)
    throw new ConnectorError('invalid_query', `${where}: a partition key is at most 256 characters`)
  return {
    Data: Buffer.from(text),
    PartitionKey: key,
    ...(r.explicitHashKey !== undefined && { ExplicitHashKey: String(r.explicitHashKey) }),
  }
}

export const kinesisConnector: Connector<KinesisConfig, KinesisSecrets, ActionQuery, KinesisResourceClient> =
  {
    type: 'kinesis',
    label: 'Amazon Kinesis',
    configSchema,
    secretsSchema,
    querySchema: actionQuerySchema('kinesis'),

    createClient({ config, secrets }) {
      return kinesisClient(config, secrets)
    },

    async destroyClient(client) {
      client.close()
    },

    async testConnection(client, { signal }) {
      return { message: `Kinesis in ${client.region} as ${await client.describe(signal)}` }
    },

    validateQuery: validateActionQuery,

    async execute(client, query, ctx): Promise<QueryResult> {
      const f = fieldReader('kinesis', query, ctx)
      if (query.action !== 'putRecords')
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
      const stream = await f.required('stream')
      const rendered = await f.json('records')
      const items = Array.isArray(rendered) ? rendered : rendered === undefined ? [] : [rendered]
      if (!items.length) throw new ConnectorError('invalid_query', 'No records to put')
      if (items.length > MAX_RECORDS)
        throw new ConnectorError(
          'invalid_query',
          `At most ${MAX_RECORDS} records per query (got ${items.length})`,
        )
      const records = items.map(kinesisRecord)
      const put: { shardId: string; sequenceNumber: string }[] = []
      const failed: { index: number; code: string; message: string }[] = []
      for (let i = 0; i < records.length; i += 500) {
        const res = await client.kinesis
          .send(new PutRecordsCommand({ ...streamRef(stream), Records: records.slice(i, i + 500) }), {
            abortSignal: ctx.signal,
          })
          .catch((err: unknown) => {
            throw awsError(err, `put records into ${stream}`)
          })
        ;(res.Records ?? []).forEach((r, j) => {
          if (r.ErrorCode) failed.push({ index: i + j, code: r.ErrorCode, message: r.ErrorMessage ?? '' })
          else put.push({ shardId: r.ShardId ?? '', sequenceNumber: r.SequenceNumber ?? '' })
        })
      }
      if (failed.length && !put.length)
        throw new ConnectorError(
          'query',
          `Kinesis refused every record: ${failed[0]!.code} ${failed[0]!.message}`,
          { failed },
        )
      return { data: put, metadata: { stream, put: put.length, ...(failed.length && { failed }) } }
    },
  }
