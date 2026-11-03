import { ConnectorError, parseResource, type RabbitClient, rabbitClient, rabbitError } from '@ow/connectors'
import type { RabbitmqTrigger } from '@ow/definition'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { AdapterContext, QueueAdapter, QueueMessage } from '../queue-consumer'
import type { RabbitRunMessage } from '../types'
import { textOrJson } from './pubsub'

/**
 * RabbitMQ (M30): a consumer on the queue with a prefetch of the trigger's in-flight limit; deliveries wait in a
 * buffer for `pull`. Acked when the run succeeds, nacked without requeueing when it fails (the queue's dead-letter
 * exchange applies, or the broker drops it). Held messages need no extension: unacked deliveries stay with the
 * channel, and a lost channel hands them back to the queue (redelivered), so a new channel starts afresh.
 */
export function rabbitmqAdapter(ctx: AdapterContext): QueueAdapter {
  const config = ctx.trigger.config as unknown as RabbitmqTrigger
  const prefetch = (ctx.trigger.config as { maxInFlight?: number }).maxInFlight ?? 4
  let client: RabbitClient | undefined
  let channel: Channel | undefined
  /** Bumped per channel: a handle from an earlier one is stale (its delivery went back to the queue). */
  let generation = 0
  const buffer: ConsumeMessage[] = []
  const deliveries = new Map<string, { msg: ConsumeMessage; channel: Channel }>()
  let wake: (() => void) | undefined
  let lost: Error | undefined

  const forget = (err?: Error) => {
    channel = undefined
    buffer.length = 0
    deliveries.clear()
    lost = err ?? lost
    wake?.()
  }

  async function open(): Promise<Channel> {
    if (channel) return channel
    lost = undefined
    if (!client) {
      const { connector, resource } = await ctx.resources.resolve(config.resource, ctx.trigger.environment_id)
      if (connector.type !== 'rabbitmq')
        throw new ConnectorError('invalid_config', `"${config.resource}" isn't a RabbitMQ resource`)
      const parsed = parseResource(connector, resource)
      client = rabbitClient(
        parsed.config as Parameters<typeof rabbitClient>[0],
        parsed.secrets as Parameters<typeof rabbitClient>[1],
      )
    }
    try {
      const conn = await client.connection()
      const ch = await conn.createChannel()
      const gen = ++generation
      ch.on('error', (err: Error) => {
        if (gen === generation) forget(err)
      })
      ch.on('close', () => {
        if (gen === generation) forget()
      })
      await ch.prefetch(prefetch)
      // A missing queue closes the channel with NOT_FOUND: the pull's error, retried later by the consumer.
      await ch.checkQueue(config.queue)
      await ch.consume(
        config.queue,
        (msg) => {
          if (gen !== generation) return
          // Null: the broker cancelled the consumer (the queue was deleted).
          if (!msg) return forget(new Error(`The broker cancelled the consumer of "${config.queue}"`))
          buffer.push(msg)
          wake?.()
        },
        { noAck: false },
      )
      channel = ch
      return ch
    } catch (err) {
      forget()
      throw rabbitError(err, `consume "${config.queue}"`)
    }
  }

  function toMessage(msg: ConsumeMessage, ch: Channel): QueueMessage {
    const handle = `${generation}:${msg.fields.deliveryTag}`
    deliveries.set(handle, { msg, channel: ch })
    const p = msg.properties
    const message: RabbitRunMessage = {
      queue: config.queue,
      exchange: msg.fields.exchange,
      routingKey: msg.fields.routingKey,
      redelivered: msg.fields.redelivered,
      headers: (p.headers ?? {}) as Record<string, unknown>,
      ...(p.messageId && { messageId: String(p.messageId) }),
      ...(p.contentType && { contentType: String(p.contentType) }),
      ...(p.correlationId && { correlationId: String(p.correlationId) }),
      ...(p.timestamp && { timestamp: new Date(Number(p.timestamp) * 1000).toISOString() }),
    }
    const text = msg.content.toString('utf8')
    return {
      // The publisher's message id recognises a redelivery; without one, each delivery is its own.
      id: p.messageId ? `id:${String(p.messageId)}` : `delivery:${handle}:${Date.now()}`,
      handle,
      input: { data: textOrJson(text), message },
    }
  }

  /** The delivery a handle answers, on the channel it came from; null when that channel is gone (it's requeued). */
  const delivery = (handle: string) => {
    const d = deliveries.get(handle)
    if (!d || d.channel !== channel) return null
    deliveries.delete(handle)
    return d
  }

  return {
    async pull(max, signal) {
      const ch = await open()
      if (!buffer.length) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 20_000)
          function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            wake = undefined
            resolve()
          }
          wake = done
          signal.addEventListener('abort', done, { once: true })
        })
      }
      if (lost && !channel) {
        const err = lost
        lost = undefined
        throw rabbitError(err, `consume "${config.queue}"`)
      }
      if (!channel) return []
      return buffer.splice(0, max).map((msg) => toMessage(msg, ch))
    },
    async extend() {
      // Unacked deliveries stay with the channel as long as it lives: nothing to renew.
    },
    async ack(held) {
      const d = delivery(held.handle)
      d?.channel.ack(d.msg)
    },
    async fail(held) {
      const d = delivery(held.handle)
      // Not requeued: the queue's dead-letter exchange takes it (or the broker drops it without one).
      d?.channel.nack(d.msg, false, false)
      return 'nacked'
    },
    async close() {
      // Closing the channel hands unacked deliveries back to the queue for the trigger's next worker.
      const ch = channel
      forget()
      generation++
      await ch?.close().catch(() => {})
      await client?.close().catch(() => {})
      client = undefined
    },
    reset() {
      const ch = channel
      forget()
      generation++
      void ch?.close().catch(() => {})
      const old = client
      client = undefined
      if (old) setTimeout(() => void old.close().catch(() => {}), 30_000).unref()
    },
  }
}
