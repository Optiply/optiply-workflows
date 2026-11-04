import {
  ConnectorError,
  parseResource,
  type SqsReceived,
  type SqsResourceClient,
  sqsClient,
} from '@ow/connectors'
import type { SqsTrigger } from '@ow/definition'
import type { AdapterContext, QueueAdapter, QueueMessage } from '../queue-consumer'
import type { SqsRunMessage } from '../types'
import { textOrJson } from './pubsub'

/**
 * SQS (M26): long-polls the queue; a held message's visibility is extended while its run lasts; deleted when it
 * succeeds, made visible again (a visibility of 0) when it fails, for the queue's redrive policy. A FIFO queue is
 * received one message at a time: SQS then hands out a group's next message only after this one is deleted, where a
 * batch may carry several of one group (which would run at once).
 */
export function sqsAdapter(ctx: AdapterContext): QueueAdapter {
  const config = ctx.trigger.config as unknown as SqsTrigger
  const fifo = config.queue.endsWith('.fifo')
  let client: SqsResourceClient | undefined
  let queueUrl: string | undefined

  /** The resource's client in the trigger's environment and the queue's URL, made on first use and after a failure. */
  async function sqs(signal: AbortSignal): Promise<{ client: SqsResourceClient; url: string }> {
    if (!client) {
      const { connector, resource } = await ctx.resources.resolve(config.resource, ctx.trigger.environment_id)
      if (connector.type !== 'sqs')
        throw new ConnectorError('invalid_config', `"${config.resource}" isn't an SQS resource`)
      const parsed = parseResource(connector, resource)
      client = sqsClient(
        parsed.config as Parameters<typeof sqsClient>[0],
        parsed.secrets as Parameters<typeof sqsClient>[1],
      )
      queueUrl = undefined
    }
    queueUrl ??= await client.queueUrl(config.queue, signal)
    return { client, url: queueUrl }
  }

  return {
    async pull(max, signal) {
      const { client, url } = await sqs(signal)
      const received = await client.receive(url, fifo ? 1 : max, 20, signal)
      return received.map((m) => toMessage(m, url))
    },
    async extend(held, signal) {
      const { client, url } = await sqs(signal)
      await client.changeVisibility(
        url,
        held.map((h) => h.handle),
        ctx.opts.holdDeadlineSeconds ?? 60,
        signal,
      )
    },
    async ack(held, signal) {
      const { client, url } = await sqs(signal)
      await client.delete(url, held.handle, signal)
    },
    async fail(held, _error, signal) {
      const { client, url } = await sqs(signal)
      await client.changeVisibility(url, [held.handle], 0, signal)
      return 'nacked'
    },
    async close(held) {
      // Visible again at once, so the trigger's next worker gets them; one it can't hand back waits out its visibility.
      if (held.length && client && queueUrl)
        await client
          .changeVisibility(
            queueUrl,
            held.map((h) => h.handle),
            0,
            AbortSignal.timeout(5_000),
          )
          .catch(() => {})
      client?.close()
      client = undefined
    },
    reset() {
      // Closed a little later: a delete or extension may be using it, and those get the new one.
      const old = client
      client = undefined
      if (old) setTimeout(() => old.close(), 30_000).unref()
    },
  }
}

function toMessage(m: SqsReceived, queue: string): QueueMessage {
  const a = m.attributes
  const runMessage: SqsRunMessage = {
    messageId: m.messageId,
    queue,
    attributes: a,
    messageAttributes: m.messageAttributes,
    receiveCount: Number(a.ApproximateReceiveCount ?? 1),
    sentAt: new Date(Number(a.SentTimestamp ?? Date.now())).toISOString(),
    ...(a.MessageGroupId ? { groupId: a.MessageGroupId } : {}),
    ...(a.MessageDeduplicationId ? { deduplicationId: a.MessageDeduplicationId } : {}),
    ...(a.SequenceNumber ? { sequenceNumber: a.SequenceNumber } : {}),
  }
  return {
    id: m.messageId,
    handle: m.receiptHandle,
    input: { data: textOrJson(m.body), message: runMessage },
  }
}
