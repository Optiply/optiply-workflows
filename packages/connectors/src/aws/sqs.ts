import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  type SendMessageBatchCommandOutput,
  type SendMessageBatchRequestEntry,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { parseTemplate, renderJson, renderText, TemplateError } from '@ow/expressions'
import { z } from 'zod'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from '../types'
import {
  awsCredentials,
  awsDefaults,
  awsError,
  awsIdentityConfig,
  awsIdentitySecrets,
  describeAws,
} from './credentials'

const configSchema = z.object({
  ...awsIdentityConfig,
  /** Another SQS endpoint (LocalStack, ElasticMQ); only admins may set it. STS is asked there too. */
  endpoint: z.string().trim().url().optional(),
})

const secretsSchema = z.object(awsIdentitySecrets)

/**
 * Sends to a queue: `messages` is JSON with `{{ }}` (as a REST body is) giving one message or an array of them, each
 * `{body, attributes?, groupId?, deduplicationId?, delaySeconds?}`; a `body` that isn't a string is sent as JSON.
 */
const querySchema = z.object({
  queue: z.string().trim().min(1),
  messages: z.string().min(1),
})

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

/** A received message, as the SQS trigger's consumer needs it. */
export interface SqsReceived {
  messageId: string
  receiptHandle: string
  body: string
  attributes: Record<string, string>
  messageAttributes: Record<string, string>
}

export interface SqsResourceClient {
  region: string
  /** Who it signs in as (STS's ARN). */
  describe(signal: AbortSignal): Promise<string>
  /** A queue's URL: given as one, or looked up by name in the identity's account (remembered). */
  queueUrl(queue: string, signal: AbortSignal): Promise<string>
  receive(queueUrl: string, max: number, waitSeconds: number, signal: AbortSignal): Promise<SqsReceived[]>
  delete(queueUrl: string, receiptHandle: string, signal: AbortSignal): Promise<void>
  /** Sets messages' visibility (0 hands them back at once); in tens, as SQS takes them. */
  changeVisibility(
    queueUrl: string,
    receiptHandles: string[],
    seconds: number,
    signal: AbortSignal,
  ): Promise<void>
  sqs: SQSClient
  close(): void
}

/** At most this many messages per send query (100 calls of 10). */
const MAX_MESSAGES = 1000

/**
 * The client of an SQS resource's settings (M26): the identity's credentials, one SDK client. Also what the trigger's
 * consumer receives with (`packages/engine`).
 */
export function sqsClient(config: Config, secrets: Secrets): SqsResourceClient {
  const credentials = awsCredentials({ ...config, ...secrets })
  const endpoint = config.endpoint ?? awsDefaults().sqsEndpoint
  // Requests go to the resource's endpoint, never a queue URL's own host (the SDK would follow it by default).
  const sqs = new SQSClient({
    region: config.region,
    credentials,
    maxAttempts: 3,
    useQueueUrlAsEndpoint: false,
    ...(endpoint ? { endpoint } : {}),
  })
  const urls = new Map<string, string>()
  return {
    region: config.region,
    sqs,
    describe: (signal) => describeAws(config.region, credentials, signal, config.endpoint),
    async queueUrl(queue, signal) {
      if (/^https?:\/\//.test(queue)) {
        // A URL must be one this resource reaches: AWS's SQS in its region, or its own endpoint (admins set it).
        const host = new URL(queue).host
        const allowed = endpoint
          ? [new URL(endpoint).host]
          : [`sqs.${config.region}.amazonaws.com`, `${config.region}.queue.amazonaws.com`]
        if (!allowed.includes(host) || (!endpoint && !queue.startsWith('https://')))
          throw new ConnectorError(
            'invalid_query',
            `The queue URL's host (${host}) isn't this resource's SQS (${allowed.join(' or ')}): use the queue's name, or its URL there`,
          )
        return queue
      }
      const known = urls.get(queue)
      if (known) return known
      try {
        const res = await sqs.send(new GetQueueUrlCommand({ QueueName: queue }), { abortSignal: signal })
        urls.set(queue, res.QueueUrl!)
        return res.QueueUrl!
      } catch (err) {
        const e = awsError(err, `find queue "${queue}"`)
        if (
          e.details?.awsError === 'QueueDoesNotExist' ||
          e.details?.awsError === 'AWS.SimpleQueueService.NonExistentQueue'
        )
          throw new ConnectorError(
            'query',
            `No queue "${queue}" in ${config.region} for this identity`,
            e.details,
          )
        throw e
      }
    },
    async receive(queueUrl, max, waitSeconds, signal) {
      try {
        const res = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
            WaitTimeSeconds: waitSeconds,
            MessageSystemAttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: signal },
        )
        return (res.Messages ?? []).map((m) => ({
          messageId: m.MessageId!,
          receiptHandle: m.ReceiptHandle!,
          body: m.Body ?? '',
          attributes: (m.Attributes ?? {}) as Record<string, string>,
          messageAttributes: Object.fromEntries(
            Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [
              k,
              v.StringValue ?? (v.BinaryValue ? Buffer.from(v.BinaryValue).toString('base64') : ''),
            ]),
          ),
        }))
      } catch (err) {
        throw awsError(err, 'receive messages')
      }
    },
    async delete(queueUrl, receiptHandle, signal) {
      try {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }), {
          abortSignal: signal,
        })
      } catch (err) {
        throw awsError(err, 'delete a message')
      }
    },
    async changeVisibility(queueUrl, receiptHandles, seconds, signal) {
      // Every batch is sent, whatever an earlier one's failures (one stale handle mustn't leave the rest unextended).
      const failed: { Code?: string | undefined; Message?: string | undefined }[] = []
      for (let i = 0; i < receiptHandles.length; i += 10) {
        const batch = receiptHandles.slice(i, i + 10)
        try {
          const res = await sqs.send(
            new ChangeMessageVisibilityBatchCommand({
              QueueUrl: queueUrl,
              Entries: batch.map((ReceiptHandle, n) => ({
                Id: String(n),
                ReceiptHandle,
                VisibilityTimeout: seconds,
              })),
            }),
            { abortSignal: signal },
          )
          failed.push(...(res.Failed ?? []))
        } catch (err) {
          throw awsError(err, "change messages' visibility")
        }
      }
      if (failed.length)
        throw new ConnectorError(
          'query',
          `SQS didn't change ${failed.length} message(s)' visibility: ${failed.map((f) => f.Code).join(', ')}`,
          { failed: failed.map((f) => ({ code: f.Code, message: f.Message })) },
        )
    },
    close() {
      sqs.destroy()
    },
  }
}

export const sqsConnector: Connector<Config, Secrets, Query, SqsResourceClient> = {
  type: 'sqs',
  label: 'Amazon SQS',
  configSchema,
  secretsSchema,
  querySchema,

  createClient({ config, secrets }) {
    return sqsClient(config, secrets)
  },

  async destroyClient(client) {
    client.close()
  },

  async testConnection(client, { signal }) {
    const who = await client.describe(signal)
    try {
      const res = await client.sqs.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: signal })
      const some = res.QueueUrls?.length
      return { message: `SQS in ${client.region} as ${who}${some ? '' : ' (no queues it can list)'}` }
    } catch (err) {
      const e = awsError(err, 'list queues')
      // Signed in, but not allowed to list queues: receiving and sending don't need it.
      if (e.code === 'connection' && e.details?.status === 403)
        return {
          message: `SQS in ${client.region} as ${who} (it can't list queues, which receiving and sending don't need)`,
        }
      throw e
    }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    for (const template of [query.queue, query.messages]) {
      try {
        parseTemplate(template)
      } catch (err) {
        if (err instanceof TemplateError) errors.push(err)
        else throw err
      }
    }
    return errors
  },

  execute(client, query, ctx) {
    return send(client, query, ctx)
  },
}

async function send(client: SqsResourceClient, query: Query, ctx: QueryContext): Promise<QueryResult> {
  const queue = await renderText(query.queue, ctx.evaluate)
  const rendered = await renderJson(query.messages, ctx.evaluate)
  const items = Array.isArray(rendered) ? rendered : [rendered]
  if (!items.length) throw new ConnectorError('invalid_query', 'No messages to send')
  if (items.length > MAX_MESSAGES)
    throw new ConnectorError(
      'invalid_query',
      `At most ${MAX_MESSAGES} messages per send (got ${items.length})`,
    )
  const entries = items.map((item, i) => toEntry(item, i))
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)])
  const queueUrl = await client.queueUrl(queue, signal)
  const sent: { messageId: string; sequenceNumber?: string }[] = []
  for (let i = 0; i < entries.length; i += 10) {
    const batch = entries.slice(i, i + 10)
    let res: SendMessageBatchCommandOutput
    try {
      res = await client.sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: batch }), {
        abortSignal: signal,
      })
    } catch (err) {
      throw withSent(awsError(err, `send to "${queue}"`), sent)
    }
    const byId = new Map((res.Successful ?? []).map((s) => [s.Id, s]))
    for (const e of batch) {
      const ok = byId.get(e.Id)
      if (ok)
        sent.push({
          messageId: ok.MessageId!,
          ...(ok.SequenceNumber ? { sequenceNumber: ok.SequenceNumber } : {}),
        })
    }
    const failed = res.Failed ?? []
    if (failed.length) {
      const first = failed[0]!
      throw withSent(
        new ConnectorError(
          'query',
          `Message ${Number(first.Id) + 1} wasn't sent: ${first.Message ?? first.Code}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`,
        ),
        sent,
      )
    }
  }
  return { data: sent, metadata: { queue: queueUrl, sent: sent.length } }
}

/** A failure after some messages went out: which did, so a retry can tell. */
function withSent(err: ConnectorError, sent: unknown[]): ConnectorError {
  return sent.length
    ? new ConnectorError(err.code, `${err.message} (${sent.length} sent before)`, { ...err.details, sent })
    : err
}

function toEntry(item: unknown, index: number): SendMessageBatchRequestEntry {
  const where = `Message ${index + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('body' in item))
    throw new ConnectorError('invalid_query', `${where}: write it as {"body": …, "attributes": {…}}`)
  const { body, attributes, groupId, deduplicationId, delaySeconds } = item as Record<string, unknown>
  if (
    attributes !== undefined &&
    (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))
  )
    throw new ConnectorError('invalid_query', `${where}: attributes are an object of strings and numbers`)
  const attrs: Record<string, MessageAttributeValue> = {}
  for (const [k, v] of Object.entries((attributes ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'number') attrs[k] = { DataType: 'Number', StringValue: String(v) }
    else attrs[k] = { DataType: 'String', StringValue: typeof v === 'string' ? v : JSON.stringify(v) }
  }
  for (const [name, value] of [
    ['groupId', groupId],
    ['deduplicationId', deduplicationId],
  ] as const)
    if (value !== undefined && typeof value !== 'string')
      throw new ConnectorError('invalid_query', `${where}: the ${name} is a string`)
  if (
    delaySeconds !== undefined &&
    (typeof delaySeconds !== 'number' || delaySeconds < 0 || delaySeconds > 900)
  )
    throw new ConnectorError('invalid_query', `${where}: delaySeconds is 0–900`)
  return {
    Id: String(index),
    MessageBody: typeof body === 'string' ? body : JSON.stringify(body ?? null),
    ...(Object.keys(attrs).length ? { MessageAttributes: attrs } : {}),
    ...(groupId ? { MessageGroupId: groupId as string } : {}),
    ...(deduplicationId ? { MessageDeduplicationId: deduplicationId as string } : {}),
    ...(delaySeconds ? { DelaySeconds: delaySeconds as number } : {}),
  }
}
