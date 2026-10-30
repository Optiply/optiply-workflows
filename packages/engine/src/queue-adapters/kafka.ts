import {
  ConnectorError,
  type KafkaConsumerHandle,
  type KafkaPartition,
  type KafkaReceived,
  type KafkaResourceClient,
  kafkaConsumer,
  kafkaResourceClient,
  parseResource,
  produceTo,
} from '@ow/connectors'
import type { KafkaTrigger } from '@ow/definition'
import type { AdapterContext, HeldMessage, QueueAdapter, QueueMessage } from '../queue-consumer'
import type { KafkaRunMessage } from '../types'
import { textOrJson } from './pubsub'

type Config = KafkaTrigger &
  Required<Pick<KafkaTrigger, 'groupId' | 'startAt' | 'maxAttempts' | 'retryBackoffSeconds' | 'maxInFlight'>>

/** A fetched message on its way through: buffered, handed out (its run under way), or waiting for a retry. */
interface Entry {
  id: string
  received: KafkaReceived
  /** Messages with a key run one at a time, in order: its partition and key. */
  keyId: string | null
}

/** A partition's offsets: those fetched and not yet settled, in order, and the next one to commit. */
interface PartitionState {
  pending: number[]
  settled: Set<number>
  commitAt: number | null
  dirty: boolean
}

/** Messages kept in the buffer at most, per in-flight slot: past this, partitions are paused. */
const BUFFER_PER_SLOT = 25

/**
 * Kafka (M26, architecture §2.29): the trigger's worker is one member of its consumer group. A background loop polls
 * (so a long run never stalls the group's heartbeat: librdkafka drops a member that stops polling), buffers messages
 * and pauses partitions while the buffer is full. Messages with one key (in one partition) run one at a time, in
 * order; others in parallel. A message settles when its run succeeds, past `maxHoldMinutes`, or after its last attempt
 * (sent to the dead-letter topic, or dropped); a failed one is offered again after its backoff for the next attempt.
 * Offsets are committed up to the lowest unsettled message of each partition, every 5 s and when partitions go.
 */
export function kafkaAdapter(ctx: AdapterContext): QueueAdapter {
  const raw = ctx.trigger.config as unknown as KafkaTrigger
  const config: Config = {
    ...raw,
    groupId: raw.groupId ?? `ow-${ctx.trigger.workflow_id}-${raw.name}`,
    startAt: raw.startAt ?? 'latest',
    maxAttempts: raw.maxAttempts ?? 3,
    retryBackoffSeconds: raw.retryBackoffSeconds ?? 10,
    maxInFlight: raw.maxInFlight ?? 4,
  }
  const secondMs = ctx.opts.backoffSecondMs ?? 1_000

  let client: KafkaResourceClient | undefined
  let consumer: KafkaConsumerHandle | undefined
  let starting: Promise<KafkaConsumerHandle> | undefined
  /** Bumped by each reset: a replaced consumer's late rebalance callbacks (it leaves in the background) are ignored. */
  let generation = 0
  let pumping: Promise<void> | undefined
  let pumpError: Error | undefined
  let stopped = false
  let wake: (() => void) | undefined
  let commitTimer: NodeJS.Timeout | undefined

  /** Fetched, in offset order, not yet handed out. */
  let buffer: Entry[] = []
  /** Handed out (their runs under way) or waiting for a retry: by message id. */
  const outstanding = new Map<string, Entry>()
  /** Failed messages waiting for their next attempt: when each is due. */
  const retries = new Map<string, number>()
  /** Keys with a message handed out or waiting for a retry: their next messages wait. */
  const busyKeys = new Set<string>()
  const partitions = new Map<string, PartitionState>()
  const paused = new Set<string>()

  const pkey = (p: KafkaPartition) => `${p.topic}/${p.partition}`
  const notify = () => wake?.()

  async function resourceClient(): Promise<KafkaResourceClient> {
    if (client) return client
    const { connector, resource } = await ctx.resources.resolve(config.resource, ctx.trigger.environment_id)
    if (connector.type !== 'kafka')
      throw new ConnectorError('invalid_config', `"${config.resource}" isn't a Kafka resource`)
    const parsed = parseResource(connector, resource)
    client = kafkaResourceClient(
      parsed.config as Parameters<typeof kafkaResourceClient>[0],
      parsed.secrets as Parameters<typeof kafkaResourceClient>[1],
    )
    return client
  }

  /** The consumer, joined on first use and after a reset; its poll and commit loops start with it. */
  function start(): Promise<KafkaConsumerHandle> {
    starting ??= (async () => {
      const mine = generation
      const made = await kafkaConsumer(await resourceClient(), {
        groupId: config.groupId,
        topics: config.topics,
        startAt: config.startAt,
        onAssign(assigned) {
          if (mine !== generation) return
          for (const p of assigned)
            if (!partitions.has(pkey(p)))
              partitions.set(pkey(p), { pending: [], settled: new Set(), commitAt: null, dirty: false })
          ctx.log('info', { partitions: assigned.map(pkey) }, 'partitions assigned')
        },
        onRevoke(revoked) {
          if (mine !== generation) return
          commit(true, revoked)
          forget(revoked)
          ctx.log('info', { partitions: revoked.map(pkey) }, 'partitions revoked')
        },
      })
      consumer = made
      pumping = pump(made)
      commitTimer = setInterval(() => commit(false), 5_000)
      commitTimer.unref()
      return made
    })().catch((err: unknown) => {
      starting = undefined
      throw err
    })
    return starting
  }

  /** Polls until stopped or reset: buffers what comes, pauses partitions while the buffer is full. */
  async function pump(c: KafkaConsumerHandle): Promise<void> {
    const limit = config.maxInFlight * BUFFER_PER_SLOT
    while (!stopped && consumer === c) {
      try {
        const got = await c.consume(100, 500)
        for (const received of got) {
          const state = partitions.get(pkey(received))
          if (!state) continue // revoked meanwhile
          state.pending.push(received.offset)
          buffer.push({
            // With its timestamp: a topic made again restarts its offsets, and an old record mustn't answer for a new
            // message at the same offset (a redelivery of this one has the same timestamp).
            id: `${received.topic}/${received.partition}/${received.offset}@${received.timestamp}`,
            received,
            keyId: received.key === null ? null : `${pkey(received)}/${received.key}`,
          })
        }
        if (got.length) notify()
        // Full: stop fetching (polling goes on, so the group keeps the member). Room again: fetch.
        if (buffer.length >= limit) {
          const toPause = c.assignments().filter((p) => !paused.has(pkey(p)))
          c.pause(toPause)
          for (const p of toPause) paused.add(pkey(p))
        } else if (paused.size && buffer.length < limit / 2) {
          const toResume = c.assignments().filter((p) => paused.has(pkey(p)))
          c.resume(toResume)
          paused.clear()
        }
        const fatal = c.errors().find((e) => (e as { isFatal?: boolean }).isFatal)
        if (fatal) throw fatal
      } catch (err) {
        if (stopped || consumer !== c) return
        pumpError = err instanceof Error ? err : new Error(String(err))
        notify()
        return
      }
    }
  }

  /** Commits each partition's contiguous settled offsets: in the background, or at once (partitions going). */
  function commit(now: boolean, only?: KafkaPartition[]): void {
    const c = consumer
    if (!c) return
    const offsets: (KafkaPartition & { offset: number })[] = []
    for (const [key, state] of partitions) {
      if (only && !only.some((p) => pkey(p) === key)) continue
      if (!state.dirty || state.commitAt === null) continue
      const at = key.lastIndexOf('/')
      offsets.push({ topic: key.slice(0, at), partition: Number(key.slice(at + 1)), offset: state.commitAt })
      state.dirty = false
    }
    try {
      if (now) c.commitNow(offsets)
      else c.commit(offsets)
    } catch (err) {
      // Not committed: those messages may come again, and their delivery records answer for them.
      for (const o of offsets) {
        const state = partitions.get(pkey(o))
        if (state) state.dirty = true
      }
      ctx.log('warn', { err: (err as Error).message }, 'offset commit failed')
    }
  }

  /** Drops what was buffered or waiting for revoked partitions: their next owner reads them from the committed offset. */
  function forget(revoked: KafkaPartition[]): void {
    const gone = new Set(revoked.map(pkey))
    buffer = buffer.filter((e) => !gone.has(pkey(e.received)))
    for (const [id, entry] of outstanding) {
      if (!gone.has(pkey(entry.received)) || !retries.has(id)) continue
      retries.delete(id)
      outstanding.delete(id)
      if (entry.keyId) busyKeys.delete(entry.keyId)
    }
    for (const key of gone) {
      partitions.delete(key)
      paused.delete(key)
    }
  }

  /** A message is done with: its offset can be committed past, and its key's next message may run. */
  function settle(id: string): void {
    const entry = outstanding.get(id)
    if (!entry) return
    outstanding.delete(id)
    retries.delete(id)
    if (entry.keyId) busyKeys.delete(entry.keyId)
    const state = partitions.get(pkey(entry.received))
    if (state) {
      state.settled.add(entry.received.offset)
      while (state.pending.length && state.settled.has(state.pending[0]!)) {
        const offset = state.pending.shift()!
        state.settled.delete(offset)
        state.commitAt = offset + 1
        state.dirty = true
      }
    }
    notify()
  }

  /** Up to `max` messages ready to run: retries now due, then buffered ones whose key is free, in offset order. */
  function take(max: number): Entry[] {
    const out: Entry[] = []
    const now = Date.now()
    for (const [id, due] of retries) {
      if (out.length >= max) break
      if (due > now) continue
      retries.delete(id)
      out.push(outstanding.get(id)!)
    }
    if (out.length < max) {
      const keep: Entry[] = []
      for (const entry of buffer) {
        if (out.length < max && (entry.keyId === null || !busyKeys.has(entry.keyId))) {
          if (entry.keyId) busyKeys.add(entry.keyId)
          outstanding.set(entry.id, entry)
          out.push(entry)
        } else keep.push(entry)
      }
      buffer = keep
    }
    return out
  }

  function toMessage(entry: Entry): QueueMessage {
    const r = entry.received
    return {
      id: entry.id,
      handle: entry.id,
      input: (attempt) => {
        const message: KafkaRunMessage = {
          topic: r.topic,
          partition: r.partition,
          offset: String(r.offset),
          key: r.key,
          headers: r.headers,
          timestamp: new Date(r.timestamp).toISOString(),
          attempt,
          groupId: config.groupId,
        }
        return { data: r.value === null ? null : textOrJson(r.value.toString('utf8')), message }
      },
    }
  }

  async function deadLetter(entry: Entry, held: HeldMessage, error: string | null, signal: AbortSignal) {
    const r = entry.received
    await produceTo(
      await resourceClient(),
      config.deadLetterTopic!,
      [
        {
          ...(r.key !== null ? { key: r.key } : {}),
          value: r.value,
          headers: {
            ...r.headers,
            'ow-error': error ?? 'the run failed',
            'ow-workflow': ctx.trigger.workflow_id,
            'ow-run-id': held.runId,
            'ow-source-topic': r.topic,
            'ow-source-partition': String(r.partition),
            'ow-source-offset': String(r.offset),
            'ow-attempts': String(held.attempt),
          },
        },
      ],
      signal,
    )
  }

  /** Sends a dead letter that failed again after the backoff, until it goes, then settles its message. */
  function retryDeadLetter(entry: Entry, held: HeldMessage, error: string | null): void {
    const timer = setTimeout(async () => {
      if (stopped || outstanding.get(entry.id) !== entry) return
      try {
        await deadLetter(entry, held, error, AbortSignal.timeout(30_000))
        await ctx.settled(held, 'dead_lettered').catch(() => {})
        settle(entry.id)
        ctx.log('info', { messageId: entry.id }, 'message dead-lettered on a later try')
      } catch (err) {
        ctx.log('warn', { messageId: entry.id, err: (err as Error).message }, 'dead letter failed again')
        retryDeadLetter(entry, held, error)
      }
    }, config.retryBackoffSeconds * secondMs)
    timer.unref()
  }

  return {
    async pull(max, signal) {
      await start()
      const deadline = Date.now() + 5_000
      for (;;) {
        if (pumpError) {
          const err = pumpError
          pumpError = undefined
          throw err
        }
        const ready = take(max)
        if (ready.length) return ready.map(toMessage)
        if (signal.aborted || Date.now() >= deadline) return []
        // Woken by a fetch, a settled message, or the next retry coming due.
        const nextDue = Math.min(...retries.values(), deadline)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            wake = undefined
            resolve()
          }
          const timer = setTimeout(done, Math.max(10, nextDue - Date.now()))
          signal.addEventListener('abort', done, { once: true })
          wake = done
        })
      }
    },
    // No deadline to hold: Kafka keeps a message until its offset is committed past.
    async extend() {},
    async ack(held) {
      settle(held.id)
    },
    async fail(held, error, signal) {
      const entry = outstanding.get(held.id)
      if (!entry) return 'nacked' // its partition went to another member, which reads it again
      if (held.attempt < config.maxAttempts) {
        const wait = Math.min(config.retryBackoffSeconds * 2 ** (held.attempt - 1), 900) * secondMs
        retries.set(held.id, Date.now() + wait)
        notify()
        return 'retried'
      }
      if (config.deadLetterTopic) {
        try {
          await deadLetter(entry, held, error, signal)
        } catch (err) {
          // Not sent (the topic missing, no access): sent again later without another run; its partition waits.
          ctx.log(
            'warn',
            { messageId: held.id, err: (err as Error).message },
            'dead letter failed: sent again later',
          )
          retryDeadLetter(entry, held, error)
          throw err
        }
        settle(held.id)
        return 'dead_lettered'
      }
      settle(held.id)
      return 'dropped'
    },
    async close() {
      stopped = true
      clearInterval(commitTimer)
      notify()
      const c = consumer ?? (await starting?.catch(() => undefined))
      await pumping
      if (c) {
        try {
          commit(true)
        } catch {}
        await c.close()
      }
      consumer = undefined
      await client?.close()
      client = undefined
    },
    undelivered(message) {
      // Its run didn't start: offered again after the backoff (its key stays busy meanwhile, keeping the order).
      if (outstanding.has(message.id)) {
        retries.set(message.id, Date.now() + config.retryBackoffSeconds * secondMs)
        notify()
      }
    },
    reset() {
      // Leaves the group (what was handed out is held on; its partitions may come back) and joins afresh next pull.
      generation++
      const c = consumer
      consumer = undefined
      starting = undefined
      clearInterval(commitTimer)
      buffer = []
      for (const [id, entry] of outstanding)
        if (retries.has(id)) {
          retries.delete(id)
          outstanding.delete(id)
          if (entry.keyId) busyKeys.delete(entry.keyId)
        }
      partitions.clear()
      paused.clear()
      const oldClient = client
      client = undefined
      void (async () => {
        await c?.close()
        await oldClient?.close()
      })()
    },
  }
}
