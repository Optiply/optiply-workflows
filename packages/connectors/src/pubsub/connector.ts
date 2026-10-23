import { parseTemplate, renderJson, renderText, TemplateError } from '@ow/expressions'
import { Agent } from 'undici'
import { z } from 'zod'
import {
  GOOGLE_TOKEN_URL,
  isServiceAccountKey,
  parseServiceAccountKey,
  type ServerIdentity,
  serviceAccountTokens,
} from '../google-auth'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from '../types'
import { type OutgoingMessage, PUBSUB_SCOPE, PUBSUB_URL, PubSubClient } from './client'

/** This process's Pub/Sub settings (M19), set once by the server, like `configureIap`. */
export interface PubSubDefaults {
  /** The server's own Google identity, only where the instance allows resources to use it. */
  serverIdentity?: ServerIdentity
  /** Pub/Sub's and Google's token endpoints, for tests. */
  url?: string
  tokenUrl?: string
}

let defaults: PubSubDefaults = {}

export function configurePubSub(next: PubSubDefaults): void {
  defaults = next
}

const configSchema = z.object({
  /** The project subscriptions and topics are in, unless named in full. Defaults to the key's project. */
  project: z.string().trim().min(1).optional(),
  /** A service account key kept with the settings, or the server's own identity (if the instance allows). */
  identity: z.enum(['key', 'server']).default('key'),
})

const secretsSchema = z.object({
  /** The service account's JSON key file, for `identity: 'key'`. */
  serviceAccountKey: z
    .string()
    .min(1)
    .refine(isServiceAccountKey, 'Paste the JSON key file of a service account')
    .optional(),
})

/**
 * Publishes to a topic: `messages` is JSON with `{{ }}` (as a REST body is) giving one message or an array of them,
 * each `{data, attributes?, orderingKey?}`; `data` that isn't a string is sent as JSON.
 */
const querySchema = z.object({
  topic: z.string().trim().min(1),
  messages: z.string().min(1),
})

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

export interface PubSubResourceClient {
  pubsub: PubSubClient
  /** Who it signs in as: the key's `client_email`, or the server's identity described. */
  describe(signal: AbortSignal): Promise<string>
  agent: Agent
}

/** At most this many messages per publish (Pub/Sub's own limit is 1,000 and 10 MB). */
const MAX_MESSAGES = 1000

/**
 * The client of a Pub/Sub resource's settings (M19): its identity's tokens over one connection pool. Also what the
 * trigger's consumer pulls with (`packages/engine`).
 */
export function pubsubClient(config: Config, secrets: Secrets): PubSubResourceClient {
  const agent = new Agent({ connections: 8 })
  const url = defaults.url ?? PUBSUB_URL
  if (config.identity === 'server') {
    const identity = defaults.serverIdentity
    if (!identity)
      throw new ConnectorError(
        'invalid_config',
        "This instance doesn't let resources use its own Google identity; use a service account key",
      )
    if (!config.project)
      throw new ConnectorError(
        'invalid_config',
        "Name the project: the server's identity has none of its own",
      )
    return {
      pubsub: new PubSubClient({ project: config.project, tokens: identity, url, dispatcher: agent }),
      describe: (signal) => identity.describe(signal),
      agent,
    }
  }
  if (!secrets.serviceAccountKey)
    throw new ConnectorError('invalid_config', 'Add the service account key (serviceAccountKey)')
  const key = parseServiceAccountKey(secrets.serviceAccountKey, 'serviceAccountKey')
  const tokens = serviceAccountTokens(key, {
    scope: PUBSUB_SCOPE,
    field: 'serviceAccountKey',
    tokenUrl: defaults.tokenUrl ?? GOOGLE_TOKEN_URL,
    dispatcher: agent,
  })
  return {
    pubsub: new PubSubClient({ project: config.project ?? key.project_id, tokens, url, dispatcher: agent }),
    describe: async () => key.client_email,
    agent,
  }
}

export const pubsubConnector: Connector<Config, Secrets, Query, PubSubResourceClient> = {
  type: 'pubsub',
  label: 'Google Cloud Pub/Sub',
  configSchema,
  secretsSchema,
  querySchema,

  createClient({ config, secrets }) {
    return pubsubClient(config, secrets)
  },

  async destroyClient({ agent }) {
    await agent.close()
  },

  async testConnection(client, { signal }) {
    const who = await client.describe(signal)
    const project = client.pubsub.project
    try {
      const topics = await client.pubsub.listTopics(1, signal)
      return { message: `Pub/Sub project ${project} as ${who}${topics.length ? '' : ' (no topics yet)'}` }
    } catch (err) {
      // Signed in, but not allowed to list topics: subscribing and publishing don't need it.
      if (err instanceof ConnectorError && err.details?.status === 403)
        return {
          message: `Pub/Sub project ${project} as ${who} (it can't list topics, which subscribing and publishing don't need)`,
        }
      throw err
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
    return publish(client, query, ctx)
  },
}

async function publish(client: PubSubResourceClient, query: Query, ctx: QueryContext): Promise<QueryResult> {
  const topic = await renderText(query.topic, ctx.evaluate)
  const rendered = await renderJson(query.messages, ctx.evaluate)
  const items = Array.isArray(rendered) ? rendered : [rendered]
  if (!items.length) throw new ConnectorError('invalid_query', 'No messages to publish')
  if (items.length > MAX_MESSAGES)
    throw new ConnectorError(
      'invalid_query',
      `At most ${MAX_MESSAGES} messages per publish (got ${items.length})`,
    )
  const messages = items.map((item, i) => toMessage(item, i))
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)])
  const messageIds = await client.pubsub.publish(topic, messages, signal)
  return {
    data: messageIds.map((messageId) => ({ messageId })),
    metadata: { topic, published: messageIds.length },
  }
}

function toMessage(item: unknown, index: number): OutgoingMessage {
  const where = `Message ${index + 1}`
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('data' in item))
    throw new ConnectorError('invalid_query', `${where}: write it as {"data": …, "attributes": {…}}`)
  const { data, attributes, orderingKey } = item as {
    data: unknown
    attributes?: unknown
    orderingKey?: unknown
  }
  if (
    attributes !== undefined &&
    (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))
  )
    throw new ConnectorError('invalid_query', `${where}: attributes are an object of strings`)
  const attrs = Object.fromEntries(
    Object.entries((attributes ?? {}) as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? v : JSON.stringify(v),
    ]),
  )
  if (orderingKey !== undefined && typeof orderingKey !== 'string')
    throw new ConnectorError('invalid_query', `${where}: the orderingKey is a string`)
  return {
    data: typeof data === 'string' ? data : JSON.stringify(data ?? null),
    ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
    ...(orderingKey ? { orderingKey } : {}),
  }
}
