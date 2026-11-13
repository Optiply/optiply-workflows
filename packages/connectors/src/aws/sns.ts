import { type MessageAttributeValue, PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns'
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

// SNS (M30): publishing to topics with M26's AWS identity. Receiving SNS is a webhook with the `sns` signature preset
// (apps/server/src/services/sns-webhook.ts).

const configSchema = z.object({ ...awsIdentityConfig })
const secretsSchema = z.object(awsIdentitySecrets)
type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>

interface SnsHandle {
  sns: SNSClient
  config: Config
  credentials: ReturnType<typeof awsCredentials>
}

const MAX_MESSAGES = 1000
const TOPIC_ARN = /^arn:aws[\w-]*:sns:[a-z0-9-]+:\d{12}:[\w-]{1,256}(\.fifo)?$/

export interface OutgoingSnsMessage {
  message: string
  subject?: string
  attributes?: Record<string, MessageAttributeValue>
  groupId?: string
  deduplicationId?: string
}

/** One message of a publish query: a non-string message as JSON; attributes as strings (numbers as Number). */
export function snsMessage(item: unknown, i: number): OutgoingSnsMessage {
  const where = `Message ${i + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('message' in item))
    throw new ConnectorError('invalid_query', `${where} needs a message ({"message": …})`)
  const m = item as Record<string, unknown>
  const out: OutgoingSnsMessage = {
    message: typeof m.message === 'string' ? m.message : JSON.stringify(m.message),
  }
  if (m.subject !== undefined) out.subject = String(m.subject)
  if (m.attributes !== undefined) {
    if (!m.attributes || typeof m.attributes !== 'object' || Array.isArray(m.attributes))
      throw new ConnectorError('invalid_query', `${where}: attributes must be an object`)
    out.attributes = Object.fromEntries(
      Object.entries(m.attributes as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'number'
          ? { DataType: 'Number', StringValue: String(v) }
          : { DataType: 'String', StringValue: String(v) },
      ]),
    )
  }
  if (m.groupId !== undefined) out.groupId = String(m.groupId)
  if (m.deduplicationId !== undefined) out.deduplicationId = String(m.deduplicationId)
  return out
}

export const snsConnector: Connector<Config, Secrets, ActionQuery, SnsHandle> = {
  type: 'sns',
  label: 'Amazon SNS',
  configSchema,
  secretsSchema,
  querySchema: actionQuerySchema('sns'),

  createClient({ config, secrets }) {
    const credentials = awsCredentials({ ...config, ...secrets })
    const endpoint = awsDefaults().snsEndpoint
    const sns = new SNSClient({
      region: config.region,
      credentials,
      maxAttempts: 3,
      ...(endpoint ? { endpoint } : {}),
    })
    return { sns, config, credentials }
  },

  async destroyClient({ sns }) {
    sns.destroy()
  },

  async testConnection({ config, credentials }, { signal }) {
    return { message: `SNS in ${config.region} as ${await describeAws(config.region, credentials, signal)}` }
  },

  validateQuery: validateActionQuery,

  async execute({ sns }, query, ctx): Promise<QueryResult> {
    const f = fieldReader('sns', query, ctx)
    if (query.action !== 'publish')
      throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    const topicArn = await f.required('topicArn')
    if (!TOPIC_ARN.test(topicArn))
      throw new ConnectorError('invalid_query', `"${topicArn}" isn't a topic ARN`)
    const rendered = await f.json('messages')
    const items = Array.isArray(rendered) ? rendered : rendered === undefined ? [] : [rendered]
    if (!items.length) throw new ConnectorError('invalid_query', 'No messages to publish')
    if (items.length > MAX_MESSAGES)
      throw new ConnectorError(
        'invalid_query',
        `At most ${MAX_MESSAGES} messages per publish (got ${items.length})`,
      )
    const messages = items.map(snsMessage)
    const fifo = topicArn.endsWith('.fifo')
    if (fifo && messages.some((m) => !m.groupId))
      throw new ConnectorError('invalid_query', 'A FIFO topic needs a groupId on every message')
    const published: { id: string; messageId: string }[] = []
    const failed: { id: string; code: string; message: string }[] = []
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10)
      const res = await sns
        .send(
          new PublishBatchCommand({
            TopicArn: topicArn,
            PublishBatchRequestEntries: batch.map((m, j) => ({
              Id: String(i + j),
              Message: m.message,
              ...(m.subject && { Subject: m.subject }),
              ...(m.attributes && { MessageAttributes: m.attributes }),
              ...(m.groupId && { MessageGroupId: m.groupId }),
              ...(m.deduplicationId && { MessageDeduplicationId: m.deduplicationId }),
            })),
          }),
          { abortSignal: ctx.signal },
        )
        .catch((err: unknown) => {
          throw awsError(err, `publish to ${topicArn}`)
        })
      for (const s of res.Successful ?? []) published.push({ id: s.Id ?? '', messageId: s.MessageId ?? '' })
      for (const e of res.Failed ?? [])
        failed.push({ id: e.Id ?? '', code: e.Code ?? '', message: e.Message ?? '' })
    }
    if (failed.length && !published.length)
      throw new ConnectorError(
        'query',
        `SNS refused every message: ${failed[0]!.code} ${failed[0]!.message}`,
        { failed },
      )
    return {
      data: published,
      metadata: { topicArn, published: published.length, ...(failed.length && { failed }) },
    }
  },
}
