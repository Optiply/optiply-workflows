import { type Dispatcher, fetch } from 'undici'
import type { GoogleTokens } from '../google-auth'
import { networkError, readBody } from '../http'
import { ConnectorError } from '../types'

/** Pub/Sub's REST API (M19, architecture §2.22). */
export const PUBSUB_URL = 'https://pubsub.googleapis.com'
export const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub'
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** A message as Pub/Sub delivered it, `data` decoded from base64. */
export interface PubSubMessage {
  data: Buffer
  attributes: Record<string, string>
  messageId: string
  publishTime: string
  orderingKey?: string
}

export interface ReceivedMessage {
  /** Acknowledges (or extends) this delivery only: a redelivery has its own. */
  ackId: string
  message: PubSubMessage
  /** How many times Pub/Sub has delivered it, counting this one; only on subscriptions with a dead-letter policy. */
  deliveryAttempt?: number
}

export interface OutgoingMessage {
  data: Buffer | string
  attributes?: Record<string, string>
  orderingKey?: string
}

export interface SubscriptionInfo {
  name: string
  topic: string
  ackDeadlineSeconds: number
  enableMessageOrdering: boolean
  deadLetterPolicy?: { deadLetterTopic: string; maxDeliveryAttempts: number }
}

export interface PubSubClientOptions {
  /** The project names without one are in. */
  project: string
  tokens: GoogleTokens
  /** `https://pubsub.googleapis.com` by default; a fake's or the emulator's in tests. */
  url?: string
  dispatcher?: Dispatcher
}

/** The longest ack deadline Pub/Sub takes, in seconds. */
export const MAX_ACK_DEADLINE_SECONDS = 600

/**
 * A subscription's or topic's full name: `orders` in project `p` is `projects/p/subscriptions/orders`; a name that is
 * already full (another project's) is kept.
 */
export function resourcePath(project: string, kind: 'subscriptions' | 'topics', name: string): string {
  if (name.startsWith('projects/')) {
    if (!new RegExp(`^projects/[^/]+/${kind}/[^/]+$`).test(name))
      throw new ConnectorError(
        'invalid_query',
        `Write the ${kind.slice(0, -1)} as a name or projects/…/${kind}/…`,
      )
    return name
  }
  if (!/^[A-Za-z][\w.~+%-]{2,254}$/.test(name))
    throw new ConnectorError('invalid_query', `"${name}" isn't a ${kind.slice(0, -1)} name`)
  return `projects/${project}/${kind}/${name}`
}

/** Pub/Sub over its REST API, one identity: pull, acknowledge, extend or nack, publish, look up a subscription. */
export class PubSubClient {
  constructor(private readonly options: PubSubClientOptions) {}

  get project(): string {
    return this.options.project
  }

  /** Up to `maxMessages` messages; Pub/Sub may hold the call a while and answer with none. */
  async pull(subscription: string, maxMessages: number, signal: AbortSignal): Promise<ReceivedMessage[]> {
    const res = await this.call<{ receivedMessages?: RawReceived[] }>(
      'POST',
      `${this.path('subscriptions', subscription)}:pull`,
      signal,
      { maxMessages },
    )
    return (res.receivedMessages ?? []).map((r) => ({
      ackId: r.ackId,
      message: {
        data: Buffer.from(r.message.data ?? '', 'base64'),
        attributes: r.message.attributes ?? {},
        messageId: r.message.messageId,
        publishTime: r.message.publishTime,
        ...(r.message.orderingKey ? { orderingKey: r.message.orderingKey } : {}),
      },
      ...(r.deliveryAttempt ? { deliveryAttempt: r.deliveryAttempt } : {}),
    }))
  }

  async acknowledge(subscription: string, ackIds: string[], signal: AbortSignal): Promise<void> {
    if (!ackIds.length) return
    await this.call('POST', `${this.path('subscriptions', subscription)}:acknowledge`, signal, { ackIds })
  }

  /** Sets the deliveries' deadlines `seconds` from now (at most 600); 0 hands them back for redelivery (a nack). */
  async modifyAckDeadline(
    subscription: string,
    ackIds: string[],
    seconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!ackIds.length) return
    await this.call('POST', `${this.path('subscriptions', subscription)}:modifyAckDeadline`, signal, {
      ackIds,
      ackDeadlineSeconds: Math.max(0, Math.min(MAX_ACK_DEADLINE_SECONDS, Math.round(seconds))),
    })
  }

  nack(subscription: string, ackIds: string[], signal: AbortSignal): Promise<void> {
    return this.modifyAckDeadline(subscription, ackIds, 0, signal)
  }

  /** The message ids, in the order given. */
  async publish(topic: string, messages: OutgoingMessage[], signal: AbortSignal): Promise<string[]> {
    const res = await this.call<{ messageIds?: string[] }>(
      'POST',
      `${this.path('topics', topic)}:publish`,
      signal,
      {
        messages: messages.map((m) => ({
          data: Buffer.from(m.data).toString('base64'),
          ...(m.attributes && Object.keys(m.attributes).length ? { attributes: m.attributes } : {}),
          ...(m.orderingKey ? { orderingKey: m.orderingKey } : {}),
        })),
      },
    )
    return res.messageIds ?? []
  }

  async getSubscription(subscription: string, signal: AbortSignal): Promise<SubscriptionInfo> {
    const res = await this.call<Partial<SubscriptionInfo>>(
      'GET',
      this.path('subscriptions', subscription),
      signal,
    )
    return {
      name: res.name ?? this.path('subscriptions', subscription),
      topic: res.topic ?? '',
      ackDeadlineSeconds: res.ackDeadlineSeconds ?? 10,
      enableMessageOrdering: res.enableMessageOrdering ?? false,
      ...(res.deadLetterPolicy ? { deadLetterPolicy: res.deadLetterPolicy } : {}),
    }
  }

  /** Whether the identity can see the topic (Test connection). */
  async getTopic(topic: string, signal: AbortSignal): Promise<{ name: string }> {
    return this.call<{ name: string }>('GET', this.path('topics', topic), signal)
  }

  private path(kind: 'subscriptions' | 'topics', name: string): string {
    return `/v1/${resourcePath(this.options.project, kind, name)}`
  }

  private async call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const url = new URL((this.options.url ?? PUBSUB_URL) + path)
    const token = await this.options.tokens.token(signal, retried)
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        ...(this.options.dispatcher ? { dispatcher: this.options.dispatcher } : {}),
      })
    } catch (err) {
      throw networkError(err, url)
    }
    // A token Google stopped taking: once more with a fresh one.
    if (res.status === 401 && !retried) {
      await res.body?.cancel()
      return this.call<T>(method, path, signal, body, true)
    }
    const text = (await readBody(res, MAX_RESPONSE_BYTES)).toString('utf8')
    if (!res.ok) throw pubsubError(res.status, text)
    return (text ? JSON.parse(text) : {}) as T
  }
}

interface RawReceived {
  ackId: string
  message: {
    data?: string
    attributes?: Record<string, string>
    messageId: string
    publishTime: string
    orderingKey?: string
  }
  deliveryAttempt?: number
}

/** Errors Pub/Sub may answer again later: a pull or ack worth retrying. */
const RETRYABLE = new Set([429, 500, 502, 503, 504])

/**
 * Google's error body, `{error: {code, message, status}}`, as a connector error: `connection` for the identity
 * (401, 403), `query` for the rest; `details.retryable` for errors worth trying again.
 */
function pubsubError(status: number, text: string): ConnectorError {
  let error: { message?: string; status?: string } = {}
  try {
    error = (JSON.parse(text) as { error?: typeof error }).error ?? {}
  } catch {
    // Not JSON (a proxy's error page): report the status.
  }
  const message = error.message ?? `Pub/Sub answered HTTP ${status}`
  const details = { status, reason: error.status, retryable: RETRYABLE.has(status) }
  if (status === 403)
    return new ConnectorError(
      'connection',
      `Pub/Sub refused the identity: ${message} (it needs roles/pubsub.subscriber on the subscription, ` +
        'roles/pubsub.publisher on a topic)',
      details,
    )
  return new ConnectorError(status === 401 ? 'connection' : 'query', message, details)
}
