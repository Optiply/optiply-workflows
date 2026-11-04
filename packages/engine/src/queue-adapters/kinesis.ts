import {
  ConnectorError,
  type KinesisRecord,
  type KinesisResourceClient,
  kinesisClient,
  parseResource,
} from '@ow/connectors'
import { kinesisCheckpoints } from '@ow/db'
import type { KinesisTrigger } from '@ow/definition'
import { eq, sql } from 'drizzle-orm'
import type { AdapterContext, QueueAdapter, QueueMessage } from '../queue-consumer'
import type { KinesisRunMessage } from '../types'
import { bodyData } from './pubsub'

type Config = KinesisTrigger &
  Required<Pick<KinesisTrigger, 'startAt' | 'maxAttempts' | 'retryBackoffSeconds'>>

interface ShardState {
  id: string
  /** The shards it was split or merged from (a merge has two): it starts once they're read to their end. */
  parents: string[]
  /** Closed when first listed (a split or merge had ended it). */
  closed: boolean
  /** Read by this trigger (it has a checkpoint, or was opened while open): its children carry on from their start. */
  followed: boolean
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
        parents: [s.ParentShardId, s.AdjacentParentShardId].filter((p): p is string => !!p),
        closed: !!s.SequenceNumberRange?.EndingSequenceNumber,
        followed: !!cp,
        iterator: null,
        fresh: true,
        buffer: [],
        finished: cp?.finished ?? false,
        ...(cp?.sequenceNumber && { checkpoint: cp.sequenceNumber }),
      })
    }
    listedAt = Date.now()
  }

  /** A shard may be read once its parents (those the stream still lists) are read to their end. */
  const ready = (s: ShardState) => !s.finished && s.parents.every((p) => shards.get(p)?.finished ?? true)

  /**
   * Saves a shard's checkpoint while the trigger still reads this stream from this resource: a release that changes
   * them clears the trigger's checkpoints (they'd name another stream's shards), and this adapter may still be settling
   * a record until the consumer restarts it. The trigger's row is locked for share, so a save waits for such a release
   * to commit, and then doesn't happen.
   */
  async function save(shardId: string, sequenceNumber: string | undefined, finished: boolean) {
    await db.execute(sql`
      insert into kinesis_checkpoints (trigger_id, shard_id, sequence_number, finished)
      select ${ctx.trigger.id}, ${shardId}, ${sequenceNumber ?? null}, ${finished}
      where exists (
        select 1 from workflow_triggers
        where id = ${ctx.trigger.id}
          and config->>'stream' = ${config.stream}
          and config->>'resource' = ${config.resource}
          and environment_id is not distinct from ${ctx.trigger.environment_id}
        for share)
      on conflict (trigger_id, shard_id) do update
        set sequence_number = coalesce(excluded.sequence_number, kinesis_checkpoints.sequence_number),
            finished = excluded.finished,
            updated_at = now()`)
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
        // Without a checkpoint: from the start when the trigger says so, or when the shard carries on from one this
        // trigger read (a split or merge of it); else from now, and a shard already closed has nothing new to give.
        const fromStart = config.startAt === 'trimHorizon' || s.parents.some((p) => shards.get(p)?.followed)
        if (!s.checkpoint && !fromStart && s.closed) {
          s.finished = true
          return null
        }
        s.iterator = await k.iterator(
          config.stream,
          s.id,
          s.checkpoint
            ? { type: 'AFTER_SEQUENCE_NUMBER', sequenceNumber: s.checkpoint }
            : { type: fromStart ? 'TRIM_HORIZON' : 'LATEST' },
          signal,
        )
        s.fresh = false
        s.followed = true
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
          let record: KinesisRecord | null
          try {
            record = await next(s, signal)
          } catch (err) {
            // Records already taken this round are handed out (their shards wait for them); the next pull meets the
            // error again if it lasts.
            if (out.length) return out
            throw err
          }
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
