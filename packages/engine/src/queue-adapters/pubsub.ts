import {
  ConnectorError,
  type PubSubClient,
  type PubSubResourceClient,
  parseResource,
  pubsubClient,
  type ReceivedMessage,
} from '@ow/connectors'
import type { PubSubTrigger } from '@ow/definition'
import type { AdapterContext, QueueAdapter, QueueMessage } from '../queue-consumer'
import type { PubSubRunMessage } from '../types'

/**
 * Pub/Sub (M19): pulls the subscription; a held message's ack deadline is extended while its run lasts; acked when it
 * succeeds, nacked (a deadline of 0) when it fails, for Pub/Sub's own backoff and dead-letter policy.
 */
export function pubsubAdapter(ctx: AdapterContext): QueueAdapter {
  const config = ctx.trigger.config as unknown as PubSubTrigger
  let client: PubSubResourceClient | undefined

  /** The resource's client in the trigger's environment, made on first use and after a failure. */
  async function pubsub(): Promise<PubSubClient> {
    if (client) return client.pubsub
    const { connector, resource } = await ctx.resources.resolve(config.resource, ctx.trigger.environment_id)
    if (connector.type !== 'pubsub')
      throw new ConnectorError('invalid_config', `"${config.resource}" isn't a Pub/Sub resource`)
    const parsed = parseResource(connector, resource)
    client = pubsubClient(
      parsed.config as Parameters<typeof pubsubClient>[0],
      parsed.secrets as Parameters<typeof pubsubClient>[1],
    )
    return client.pubsub
  }

  return {
    async pull(max, signal) {
      const received = await (await pubsub()).pull(config.subscription, max, signal)
      return received.map((r) => toMessage(r, config.subscription))
    },
    async extend(held, signal) {
      await (await pubsub()).modifyAckDeadline(
        config.subscription,
        held.map((h) => h.handle),
        ctx.opts.holdDeadlineSeconds ?? 60,
        signal,
      )
    },
    async ack(held, signal) {
      await (await pubsub()).acknowledge(config.subscription, [held.handle], signal)
    },
    async fail(held, _error, signal) {
      await (await pubsub()).nack(config.subscription, [held.handle], signal)
      return 'nacked'
    },
    async close(held) {
      // Nacked, so the trigger's next worker gets them at once; one nack it can't send just waits out its deadline.
      if (held.length && client)
        await client.pubsub
          .nack(
            config.subscription,
            held.map((h) => h.handle),
            AbortSignal.timeout(5_000),
          )
          .catch(() => {})
      await client?.agent.close().catch(() => {})
      client = undefined
    },
    reset() {
      // The old client is closed a little later: an ack or extension may be using it, and those get the new one.
      const old = client
      client = undefined
      if (old) setTimeout(() => void old.agent.close().catch(() => {}), 30_000).unref()
    },
  }
}

function toMessage(received: ReceivedMessage, subscription: string): QueueMessage {
  const { message } = received
  const runMessage: PubSubRunMessage = {
    messageId: message.messageId,
    publishTime: message.publishTime,
    attributes: message.attributes,
    ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
    ...(received.deliveryAttempt ? { deliveryAttempt: received.deliveryAttempt } : {}),
    subscription,
    dataBase64: message.data.toString('base64'),
  }
  const body = bodyData(message.data)
  if (body.binary) runMessage.encoding = 'base64'
  return {
    id: message.messageId,
    handle: received.ackId,
    input: { data: body.data, message: runMessage },
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * A broker message's bytes as `startTrigger.data` (M30): parsed when they're JSON, else their text. Bytes that aren't
 * text (not UTF-8, or holding a NUL, which Postgres's jsonb can't store, so the run could never start) are base64,
 * with `binary` saying so; the run's message then has `encoding: 'base64'`.
 */
export function bodyData(body: Buffer): { data: unknown; binary: boolean } {
  let text: string | undefined
  if (!body.includes(0))
    try {
      text = utf8.decode(body)
    } catch {}
  if (text === undefined) return { data: body.toString('base64'), binary: true }
  const data = textOrJson(text)
  // JSON's own `\u0000` escapes parse to a NUL as well: such JSON is kept as its text.
  if (typeof data !== 'string' && JSON.stringify(data).includes('\\u0000'))
    return { data: text, binary: false }
  return { data, binary: false }
}

/** A message's body as `startTrigger.data`: parsed when it's JSON, else its text. */
export function textOrJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
