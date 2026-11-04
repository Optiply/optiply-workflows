import Confluent from '@confluentinc/kafka-javascript'
import { ConnectorError } from '../types'
import type { KafkaResourceClient } from './client'

export interface KafkaPartition {
  topic: string
  partition: number
}

/** A fetched message, its key and headers as text. */
export interface KafkaReceived extends KafkaPartition {
  offset: number
  key: string | null
  value: Buffer | null
  headers: Record<string, string>
  timestamp: number
}

export interface KafkaConsumerOptions {
  groupId: string
  topics: string[]
  /** Where a group with no committed offsets starts. */
  startAt: 'latest' | 'earliest'
  /** Partitions taken away (a rebalance, or leaving): called before they go, so their offsets can be committed. */
  onRevoke(partitions: KafkaPartition[]): void
  onAssign(partitions: KafkaPartition[]): void
}

/**
 * One member of a consumer group (M26), over librdkafka's own consumer: polled with `consume`, offsets committed only
 * when asked (no auto-commit), partitions paused and resumed. Made from a Kafka resource's client settings.
 */
export interface KafkaConsumerHandle {
  /** Up to `max` messages, waiting up to `waitMs` for some. */
  consume(max: number, waitMs: number): Promise<KafkaReceived[]>
  /** Commits the next offset to read for each partition, in the background (failures are retried by the caller). */
  commit(offsets: (KafkaPartition & { offset: number })[]): void
  /** The same, before returning: for revoked partitions and leaving. */
  commitNow(offsets: (KafkaPartition & { offset: number })[]): void
  pause(partitions: KafkaPartition[]): void
  resume(partitions: KafkaPartition[]): void
  assignments(): KafkaPartition[]
  /** Errors librdkafka reported since the last call (a fatal one ends the consumer). */
  errors(): Error[]
  close(): Promise<void>
}

export async function kafkaConsumer(
  client: KafkaResourceClient,
  opts: KafkaConsumerOptions,
): Promise<KafkaConsumerHandle> {
  const errors: Error[] = []
  const consumer = new Confluent.KafkaConsumer(
    {
      ...(client.settings as object),
      'group.id': opts.groupId,
      'enable.auto.commit': false,
      'enable.auto.offset.store': false,
      // Bounded prefetch: messages wait in our buffer, not librdkafka's.
      'queued.max.messages.kbytes': 4096,
      rebalance_cb: true,
      event_cb: true,
    } as never,
    { 'auto.offset.reset': opts.startAt },
  )
  const tp = (a: { topic: string; partition: number }) => ({ topic: a.topic, partition: a.partition })
  consumer.on('rebalance', (err, assignment) => {
    // Emitted before the consumer assigns or unassigns: revoked partitions can still be committed here.
    if (err?.code === -174) opts.onRevoke(assignment.map(tp))
    else if (err?.code === -175) opts.onAssign(assignment.map(tp))
  })
  consumer.on('event.error', (err) => {
    errors.push(Object.assign(new Error(err.message), { code: err.code, isFatal: err.isFatal }))
    if (errors.length > 20) errors.shift()
  })
  await new Promise<void>((resolve, reject) =>
    consumer.connect({ timeout: 15_000 }, (err) =>
      err
        ? reject(new ConnectorError('connection', `Couldn't join the consumer group: ${err.message}`))
        : resolve(),
    ),
  )
  consumer.subscribe(opts.topics)
  let closed = false

  return {
    consume(max, waitMs) {
      consumer.setDefaultConsumeTimeout(waitMs)
      return new Promise((resolve, reject) =>
        consumer.consume(max, (err, messages) => {
          if (err)
            return reject(new ConnectorError('connection', `Kafka: ${err.message}`, { kafkaError: err.code }))
          resolve(
            messages.map((m) => ({
              topic: m.topic,
              partition: m.partition,
              offset: m.offset,
              key: m.key === undefined || m.key === null ? null : m.key.toString(),
              value: m.value,
              headers: Object.fromEntries(
                (m.headers ?? []).flatMap((h) => Object.entries(h).map(([k, v]) => [k, v.toString()])),
              ),
              timestamp: m.timestamp ?? Date.now(),
            })),
          )
        }),
      )
    },
    commit(offsets) {
      if (offsets.length && !closed) consumer.commit(offsets)
    },
    commitNow(offsets) {
      if (offsets.length && !closed) consumer.commitSync(offsets)
    },
    pause(partitions) {
      if (partitions.length) consumer.pause(partitions)
    },
    resume(partitions) {
      if (partitions.length) consumer.resume(partitions)
    },
    assignments() {
      return consumer.assignments().map(tp)
    },
    errors() {
      return errors.splice(0)
    },
    close() {
      closed = true
      return new Promise((resolve) => {
        consumer.disconnect(() => resolve())
        // librdkafka may wait for a broker that's gone: don't hang a worker's stop on it.
        setTimeout(resolve, 10_000).unref()
      })
    },
  }
}
