import { type ActionQuery, actionQuerySchema, fieldReader, validateActionQuery } from '../services/common'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from '../types'
import {
  type RabbitClient,
  type RabbitConfig,
  type RabbitSecrets,
  rabbitClient,
  rabbitConfigSchema,
  rabbitError,
  rabbitSecretsSchema,
} from './client'

const MAX_MESSAGES = 1000

export interface OutgoingRabbitMessage {
  body: Buffer
  contentType?: string
  headers?: Record<string, unknown>
  messageId?: string
  persistent: boolean
  priority?: number
  expiration?: string
}

/** One message of a publish query, or the query's error naming it. */
export function rabbitMessage(item: unknown, i: number): OutgoingRabbitMessage {
  const where = `Message ${i + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('body' in item))
    throw new ConnectorError('invalid_query', `${where} needs a body ({"body": …})`)
  const m = item as Record<string, unknown>
  const text = typeof m.body === 'string'
  const out: OutgoingRabbitMessage = {
    body: Buffer.from(text ? (m.body as string) : JSON.stringify(m.body)),
    persistent: m.persistent !== false,
  }
  const contentType =
    typeof m.contentType === 'string' ? m.contentType : text ? undefined : 'application/json'
  if (contentType) out.contentType = contentType
  if (m.headers !== undefined) {
    if (!m.headers || typeof m.headers !== 'object' || Array.isArray(m.headers))
      throw new ConnectorError('invalid_query', `${where}: headers must be an object`)
    out.headers = m.headers as Record<string, unknown>
  }
  if (m.messageId !== undefined) out.messageId = String(m.messageId)
  if (m.priority !== undefined) {
    const p = Number(m.priority)
    if (!Number.isInteger(p) || p < 0 || p > 255)
      throw new ConnectorError('invalid_query', `${where}: priority is 0 to 255`)
    out.priority = p
  }
  if (m.expiration !== undefined) out.expiration = String(m.expiration)
  return out
}

/** Publishes and waits for the broker's confirms: resolved only when it has every message. */
export async function publishTo(
  client: RabbitClient,
  exchange: string,
  routingKey: string,
  messages: OutgoingRabbitMessage[],
  signal: AbortSignal,
): Promise<void> {
  const ch = await client.publisher()
  for (const m of messages) {
    ch.publish(exchange, routingKey, m.body, {
      persistent: m.persistent,
      ...(m.contentType && { contentType: m.contentType }),
      ...(m.headers && { headers: m.headers }),
      ...(m.messageId && { messageId: m.messageId }),
      ...(m.priority !== undefined && { priority: m.priority }),
      ...(m.expiration && { expiration: m.expiration }),
      // Unroutable messages come back (`return`) instead of vanishing.
      mandatory: true,
    })
  }
  const returned: string[] = []
  const onReturn = (msg: { fields: { routingKey: string; replyText?: string } }) =>
    returned.push(msg.fields.routingKey)
  // When the broker closes the channel (an exchange that doesn't exist), the reason comes here, not with the confirms.
  let closedBy: unknown
  const onError = (err: unknown) => {
    closedBy = err
  }
  ch.on('return', onReturn)
  ch.on('error', onError)
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      ch.waitForConfirms().then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort)
          // The channel's error event may come just after the confirms fail.
          setImmediate(() => reject(closedBy ?? err))
        },
      )
    })
  } finally {
    ch.off('return', onReturn)
    ch.off('error', onError)
  }
  if (returned.length)
    throw new ConnectorError(
      'query',
      `No queue is bound to ${exchange ? `exchange "${exchange}"` : 'the default exchange'} with routing key "${returned[0]}": ${returned.length} message(s) not delivered`,
    )
}

/**
 * Publishes to an exchange (empty: the default exchange, where the routing key is a queue's name): `messages` is JSON
 * with `{{ }}` giving one message or an array, each `{body, headers?, contentType?, messageId?, persistent?,
 * priority?, expiration?}`; a body that isn't a string is sent as JSON.
 */
async function publish(client: RabbitClient, query: ActionQuery, ctx: QueryContext): Promise<QueryResult> {
  const f = fieldReader('rabbitmq', query, ctx)
  const exchange = (await f.text('exchange')) ?? ''
  const routingKey = (await f.text('routingKey')) ?? ''
  if (!exchange && !routingKey)
    throw new ConnectorError(
      'invalid_query',
      'Give an exchange, or a queue as the routing key (the default exchange)',
    )
  const rendered = await f.json('messages')
  if (rendered === undefined) throw new ConnectorError('invalid_query', 'Messages is empty')
  const items = Array.isArray(rendered) ? rendered : [rendered]
  if (!items.length) throw new ConnectorError('invalid_query', 'No messages to publish')
  if (items.length > MAX_MESSAGES)
    throw new ConnectorError(
      'invalid_query',
      `At most ${MAX_MESSAGES} messages per publish (got ${items.length})`,
    )
  const messages = items.map(rabbitMessage)
  try {
    await publishTo(
      client,
      exchange,
      routingKey,
      messages,
      AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]),
    )
  } catch (err) {
    throw rabbitError(err, `publish to ${exchange || 'the default exchange'}`)
  }
  return { data: { published: messages.length }, metadata: { exchange, routingKey } }
}

export const rabbitmqConnector: Connector<RabbitConfig, RabbitSecrets, ActionQuery, RabbitClient> = {
  type: 'rabbitmq',
  label: 'RabbitMQ',
  configSchema: rabbitConfigSchema,
  secretsSchema: rabbitSecretsSchema,
  querySchema: actionQuerySchema('rabbitmq'),

  createClient({ config, secrets }) {
    return rabbitClient(config, secrets)
  },

  async destroyClient(client) {
    await client.close()
  },

  async testConnection(client) {
    const server = await client.server()
    return {
      message: `${server} at ${client.config.host}${client.config.vhost === '/' ? '' : ` (vhost ${client.config.vhost})`}`,
    }
  },

  validateQuery: validateActionQuery,

  execute(client, query, ctx) {
    return publish(client, query, ctx)
  },
}
