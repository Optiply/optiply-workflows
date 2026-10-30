import { parseTemplate, renderJson, renderText, TemplateError } from '@ow/expressions'
import { z } from 'zod'
import { awsCredentials, describeAws } from '../aws/credentials'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from '../types'
import { type KafkaResourceClient, kafkaClient, kafkaError, withSignal } from './client'
import {
  type KafkaConfig,
  type KafkaSecrets,
  kafkaConfigSchema,
  kafkaSecretsSchema,
  kafkaSettingsProblem,
} from './config'
import { mskIamToken } from './msk-iam'

/**
 * Produces to a topic: `messages` is JSON with `{{ }}` (as a REST body is) giving one message or an array of them,
 * each `{key?, value, headers?, partition?}`; a `value` that isn't a string is sent as JSON, `null` as a tombstone.
 */
const querySchema = z.object({
  topic: z.string().trim().min(1),
  messages: z.string().min(1),
})

type Query = z.output<typeof querySchema>

/** At most this many messages per produce query. */
const MAX_MESSAGES = 1000

/**
 * The client of a Kafka resource's settings (M26); also what the trigger's consumer starts from. MSK IAM signs in
 * with a token librdkafka asks for before the last one expires, presigned with the AWS identity's credentials.
 */
export function kafkaResourceClient(config: KafkaConfig, secrets: KafkaSecrets): KafkaResourceClient {
  if (config.auth !== 'aws-msk-iam') return kafkaClient(config, secrets)
  const problem = kafkaSettingsProblem(config, secrets)
  if (problem) throw new ConnectorError('invalid_config', problem)
  const region = config.region ?? ''
  const credentials = awsCredentials({
    region,
    identity: config.identity,
    accessKeyId: config.accessKeyId,
    roleArn: config.roleArn,
    externalId: config.externalId,
    secretAccessKey: secrets.secretAccessKey,
  })
  return kafkaClient(config, secrets, {
    settings: { oauthbearer_token_refresh_cb: () => mskIamToken(region, credentials) },
    who: async (signal) => `${await describeAws(region, credentials, signal)} (MSK IAM)`,
  })
}

export const kafkaConnector: Connector<KafkaConfig, KafkaSecrets, Query, KafkaResourceClient> = {
  type: 'kafka',
  label: 'Apache Kafka',
  configSchema: kafkaConfigSchema,
  secretsSchema: kafkaSecretsSchema,
  querySchema,

  createClient({ config, secrets }) {
    return kafkaResourceClient(config, secrets)
  },

  async destroyClient(client) {
    await client.close()
  },

  async testConnection(client, { signal }) {
    const since = Date.now()
    try {
      const who = await client.who(signal)
      const admin = await withSignal(client.admin(), signal)
      const topics = (await withSignal(admin.listTopics({ timeout: 10_000 } as never), signal)).filter(
        (t) => !t.startsWith('__'),
      )
      const brokers = String(client.settings['bootstrap.servers']).split(',')
      return {
        message: `Kafka at ${brokers[0]}${brokers.length > 1 ? ` (+${brokers.length - 1})` : ''} as ${who}: ${topics.length} topic${topics.length === 1 ? '' : 's'}`,
      }
    } catch (err) {
      throw kafkaError(err, client, since, 'connect to Kafka')
    }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    for (const template of [query.topic, query.messages]) {
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
    return produce(client, query, ctx)
  },
}

export interface OutgoingKafkaMessage {
  key?: string
  value: string | null
  headers?: Record<string, string>
  partition?: number
}

async function produce(client: KafkaResourceClient, query: Query, ctx: QueryContext): Promise<QueryResult> {
  const topic = await renderText(query.topic, ctx.evaluate)
  const rendered = await renderJson(query.messages, ctx.evaluate)
  const items = Array.isArray(rendered) ? rendered : [rendered]
  if (!items.length) throw new ConnectorError('invalid_query', 'No messages to produce')
  if (items.length > MAX_MESSAGES)
    throw new ConnectorError(
      'invalid_query',
      `At most ${MAX_MESSAGES} messages per produce (got ${items.length})`,
    )
  const messages = items.map((item, i) => toMessage(item, i))
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)])
  const partitions = await produceTo(client, topic, messages, signal)
  return { data: partitions, metadata: { topic, produced: messages.length } }
}

/** Sends messages to a topic and waits for the brokers' acknowledgement: each partition's first offset. */
export async function produceTo(
  client: KafkaResourceClient,
  topic: string,
  messages: OutgoingKafkaMessage[],
  signal: AbortSignal,
): Promise<{ partition: number; baseOffset: string }[]> {
  const since = Date.now()
  try {
    const producer = await withSignal(client.producer(), signal)
    const sent = await withSignal(producer.send({ topic, messages } as never), signal)
    return (sent as { partition: number; baseOffset?: string; offset?: string }[]).map((r) => ({
      partition: r.partition,
      baseOffset: String(r.baseOffset ?? r.offset ?? ''),
    }))
  } catch (err) {
    throw kafkaError(err, client, since, `produce to "${topic}"`)
  }
}

function toMessage(item: unknown, index: number): OutgoingKafkaMessage {
  const where = `Message ${index + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('value' in item))
    throw new ConnectorError('invalid_query', `${where}: write it as {"key": …, "value": …, "headers": {…}}`)
  const { key, value, headers, partition } = item as Record<string, unknown>
  if (key !== undefined && key !== null && typeof key !== 'string' && typeof key !== 'number')
    throw new ConnectorError('invalid_query', `${where}: the key is a string`)
  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers)))
    throw new ConnectorError('invalid_query', `${where}: headers are an object of strings`)
  if (
    partition !== undefined &&
    (typeof partition !== 'number' || !Number.isInteger(partition) || partition < 0)
  )
    throw new ConnectorError('invalid_query', `${where}: the partition is a number from 0`)
  const h = Object.fromEntries(
    Object.entries((headers ?? {}) as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? v : JSON.stringify(v),
    ]),
  )
  return {
    ...(key !== undefined && key !== null ? { key: String(key) } : {}),
    value: value === null ? null : typeof value === 'string' ? value : JSON.stringify(value),
    ...(Object.keys(h).length ? { headers: h } : {}),
    ...(partition !== undefined ? { partition: partition as number } : {}),
  }
}
