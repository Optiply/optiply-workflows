import {
  ConnectorError,
  type KinesisRecord,
  type KinesisResourceClient,
  kinesisClient,
  parseResource,
} from '@ow/connectors'
import { kinesisCheckpoints } from '@ow/db'
import type { KinesisTrigger } from '@ow/definition'
import { eq } from 'drizzle-orm'
import type { AdapterContext, QueueAdapter, QueueMessage } from '../queue-consumer'
import type { KinesisRunMessage } from '../types'
import { bodyData } from './pubsub'

type Config = KinesisTrigger &
  Required<Pick<KinesisTrigger, 'startAt' | 'maxAttempts' | 'retryBackoffSeconds'>>

interface ShardState {
  id: string
  parent?: string
  iterator: string | null
  /** No iterator asked for yet (one is made from the checkpoint or `startAt`). */
  fresh: boolean
  buffer: KinesisRecord[]
  /** The record whose run is under way: the shard waits for it (records run in order). */
  busy?: string
  /** A failed record waiting for its next attempt. */
  retry?: { record: KinesisRecord; at: number }
  /** Read to its end (a closed shard): its children may start. */
  finished: boolean
  /** The last record whose run ended. */
  checkpoint?: string
}

/**
 * Kinesis (M30): every shard of the stream, read from its checkpoint (or `startAt`), one record per shard at a time so
 * each shard's records run in order; a shard split or merged away is read to its end before its children start.
 * A record's success moves its shard's checkpoint (kept in `kinesis_checkpoints`, so another worker or a restart
 * carries on there); a failure is retried after the backoff, doubling, up to `maxAttempts` runs, then skipped
 * (`dropped`). Nothing to hold or extend: Kinesis keeps records for the stream's retention.
 */
export function kinesisAdapter(ctx: AdapterContext): QueueAdapter {
  const raw = ctx.trigger.config as unknown as KinesisTrigger
  const config: Config = {
    ...raw,
    startAt: raw.startAt ?? 'latest',
    maxAttempts: raw.maxAttempts ?? 3,
    retryBackoffSeconds: raw.retryBackoffSeconds ?? 10,
  }
  const db = ctx.opts.db
  const secondMs = ctx.opts.backoffSecondMs ?? 1_000
  let client: KinesisResourceClient | undefined
  const shards = new Map<string, ShardState>()
  const records = new Map<string, { shard: string; record: KinesisRecord }>()
  let listedAt = 0

  async function kinesis(): Promise<KinesisResourceClient> {
    if (client) return client
    const { connector, resource } = await ctx.resources.resolve(config.resource, ctx.trigger.environment_id)
    if (connector.type !== 'kinesis')
      throw new ConnectorError('invalid_config', `"${config.resource}" isn't a Kinesis resource`)
    const parsed = parseResource(connector, resource)
    client = kinesisClient(
      parsed.config as Parameters<typeof kinesisClient>[0],
      parsed.secrets as Parameters<typeof kinesisClient>[1],
    )
    return client
  }

  /** The stream's shards (every 30 s, for splits and merges) with their checkpoints. */
  async function listShards(signal: AbortSignal) {
    if (shards.size && Date.now() - listedAt < 30_000) return
    const k = await kinesis()
    const list = await k.shards(config.stream, signal)
    const saved = await db
      .select()
      .from(kinesisCheckpoints)
      .where(eq(kinesisCheckpoints.triggerId, ctx.trigger.id))
    const byShard = new Map(saved.map((r) => [r.shardId, r]))
    for (const s of list) {
      if (!s.ShardId || shards.has(s.ShardId)) continue
      const cp = byShard.get(s.ShardId)
      shards.set(s.ShardId, {
        id: s.ShardId,
        ...(s.ParentShardId && { parent: s.ParentShardId }),
        iterator: null,
        fresh: true,
        buffer: [],
        finished: cp?.finished ?? false,
        ...(cp?.sequenceNumber && { checkpoint: cp.sequenceNumber }),
      })
    }
    listedAt = Date.now()
  }

  /** A shard may be read once its parent (if the stream still lists it) is read to its end. */
  const ready = (s: ShardState) => {
    if (s.finished) return false
    const parent = s.parent ? shards.get(s.parent) : undefined
    return !parent || parent.finished
  }

  async function save(shardId: string, sequenceNumber: string | undefined, finished: boolean) {
    await db
      .insert(kinesisCheckpoints)
      .values({ triggerId: ctx.trigger.id, shardId, sequenceNumber: sequenceNumber ?? null, finished })
      .onConflictDoUpdate({
        target: [kinesisCheckpoints.triggerId, kinesisCheckpoints.shardId],
        set: { ...(sequenceNumber && { sequenceNumber }), finished, updatedAt: new Date() },
      })
  }

  function toMessage(s: ShardState, record: KinesisRecord): QueueMessage {
    const id = `${s.id}/${record.sequenceNumber}`
    records.set(id, { shard: s.id, record })
    s.busy = id
    return {
      id,
      handle: id,
      input: (attempt: number) => {
        const message: KinesisRunMessage = {
          stream: config.stream,
          shardId: s.id,
          sequenceNumber: record.sequenceNumber,
          partitionKey: record.partitionKey,
          arrivedAt: record.arrivedAt,
          attempt,
        }
        const body = bodyData(record.data)
        if (body.binary) message.encoding = 'base64'
        return { data: body.data, message }
      },
    }
  }

  /** The shard's next record, reading a page when its buffer is empty; null when there's none now. */
  async function next(s: ShardState, signal: AbortSignal): Promise<KinesisRecord | null> {
    if (!s.buffer.length) {
      const k = await kinesis()
      if (s.fresh) {
        s.iterator = await k.iterator(
          config.stream,
          s.id,
          s.checkpoint
            ? { type: 'AFTER_SEQUENCE_NUMBER', sequenceNumber: s.checkpoint }
            : // A child of a split or merge starts at its beginning; a shard of its own where the trigger says.
              { type: s.parent || config.startAt === 'trimHorizon' ? 'TRIM_HORIZON' : 'LATEST' },
          signal,
        )
        s.fresh = false
      }
      if (!s.iterator) {
        s.finished = true
        await save(s.id, s.checkpoint, true)
        return null
      }
      try {
        const page = await k.records(s.iterator, 100, signal)
        s.buffer.push(...page.records)
        s.iterator = page.next
      } catch (err) {
        // An expired iterator (5 minutes unused): a new one from the checkpoint next time.
        if ((err as { name?: string }).name === 'ExpiredIteratorException') {
          s.fresh = true
          return null
        }
        throw err
      }
      if (!s.buffer.length && !s.iterator) {
        s.finished = true
        await save(s.id, s.checkpoint, true)
        return null
      }
    }
    return s.buffer.shift() ?? null
  }

  const settle = async (id: string, advance: boolean) => {
    const entry = records.get(id)
    records.delete(id)
    const s = entry ? shards.get(entry.shard) : undefined
    if (!entry || !s || s.busy !== id) return
    s.busy = undefined
    s.retry = undefined
    if (advance) {
      s.checkpoint = entry.record.sequenceNumber
      await save(s.id, s.checkpoint, false)
    }
  }

  return {
    async pull(max, signal) {
      const deadline = Date.now() + 5_000
      for (;;) {
        await listShards(signal)
        const out: QueueMessage[] = []
        for (const s of shards.values()) {
          if (out.length >= max) break
          if (!ready(s) || s.busy) continue
          if (s.retry) {
            if (s.retry.at <= Date.now()) out.push(toMessage(s, s.retry.record))
            continue
          }
          const record = await next(s, signal)
          if (record) out.push(toMessage(s, record))
        }
        if (out.length || Date.now() > deadline || signal.aborted) return out
        // Kinesis allows 5 reads a second per shard: a pause between empty rounds.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1_000)
          function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          signal.addEventListener('abort', done, { once: true })
        })
      }
    },
    async extend() {},
    async ack(held) {
      await settle(held.id, true)
    },
    async fail(held) {
      const entry = records.get(held.id)
      const s = entry ? shards.get(entry.shard) : undefined
      if (!entry || !s) return 'nacked'
      if (held.attempt < config.maxAttempts) {
        // The shard waits for it: it runs again after the backoff, before anything after it.
        s.busy = undefined
        s.retry = {
          record: entry.record,
          at: Date.now() + Math.min(config.retryBackoffSeconds * 2 ** (held.attempt - 1), 900) * secondMs,
        }
        return 'retried'
      }
      await settle(held.id, true)
      return 'dropped'
    },
    async close() {
      client?.close()
      client = undefined
      shards.clear()
      records.clear()
    },
    reset() {
      client?.close()
      client = undefined
      // Read again from the checkpoints (records under way stay recorded; their runs settle them).
      for (const s of shards.values()) {
        s.fresh = true
        s.buffer = []
      }
      listedAt = 0
    },
    undelivered(message) {
      const entry = records.get(message.id)
      const s = entry ? shards.get(entry.shard) : undefined
      if (!entry || !s) return
      s.busy = undefined
      s.retry = { record: entry.record, at: Date.now() + config.retryBackoffSeconds * secondMs }
    },
  }
}
