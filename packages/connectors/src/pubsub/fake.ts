import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** A subscription of the fake, as Pub/Sub's settings name it. */
export interface FakeSubscriptionSettings {
  topic: string
  /** 10 by default; in the fake's seconds (`secondMs`). */
  ackDeadlineSeconds?: number
  enableMessageOrdering?: boolean
  deadLetterPolicy?: { deadLetterTopic: string; maxDeliveryAttempts: number }
}

/** One message on a subscription: delivered how often, acked or not, and the delivery out now. */
export interface FakeDelivery {
  messageId: string
  data: string
  attributes: Record<string, string>
  orderingKey?: string
  deliveries: number
  acked: boolean
  /** Moved to the dead-letter topic after `maxDeliveryAttempts`. */
  deadLettered: boolean
}

export interface FakePubSub {
  /** For `PubSubClient`'s `url`. */
  url: string
  /** In project `project`: `topics/x` and `subscriptions/y` are under `projects/<project>/`. */
  readonly project: string
  createTopic(name: string): void
  createSubscription(name: string, settings: FakeSubscriptionSettings): void
  /** Publishes as a publisher outside the platform would; returns the message id. */
  publish(topic: string, data: string, attributes?: Record<string, string>, orderingKey?: string): string
  /** Every message the subscription got, oldest first. */
  messages(subscription: string): FakeDelivery[]
  /** What was published to a topic (the dead-letter topic too), oldest first. */
  published(topic: string): { messageId: string; data: string; attributes: Record<string, string> }[]
  /** Sends a message out again as if its ack had been lost (Pub/Sub is at-least-once): acked or not. */
  redeliver(subscription: string, messageId: string): void
  /** Deliveries out now (pulled, neither acked nor past their deadline). */
  outstanding(subscription: string): number
  /** The next call to `method` (`pull`, `acknowledge`, `modifyAckDeadline`, `publish`, `get`) answers so. */
  failNext(method: string, status: number, message: string): void
  /** Every call, as `method subscription-or-topic` (for tests that count pulls or acks). */
  readonly calls: string[]
  close(): Promise<void>
}

interface Topic {
  messages: { messageId: string; data: string; attributes: Record<string, string>; orderingKey?: string }[]
  subscriptions: Set<string>
}

interface Out {
  ackId: string
  /** When the delivery's deadline passes (ms since epoch). */
  until: number
}

interface Entry extends FakeDelivery {
  publishTime: string
  out?: Out
}

interface Subscription {
  settings: FakeSubscriptionSettings
  entries: Entry[]
}

/**
 * A Pub/Sub REST endpoint, just enough for `PubSubClient` and the trigger's consumer: topics and subscriptions in one
 * project, at-least-once delivery with ack deadlines (a delivery past its deadline, or nacked, goes out again with a
 * new ack id; a stale ack id is ignored, as Pub/Sub does), `deliveryAttempt` and a dead-letter topic where the
 * subscription has a policy, ordering keys (a key's next message only after the one before is acked), and a pull that
 * waits up to `pullWaitMs` for a message. Time runs `secondMs` to a second, so a 10 s deadline is quick in tests.
 * Only `tokens` are let in (401 otherwise); `deny` names subscriptions or topics that answer 403.
 */
export async function startFakePubSub(
  options: {
    project?: string
    tokens?: string[]
    /** How many real ms a Pub/Sub second lasts here: 1000 by default. */
    secondMs?: number
    pullWaitMs?: number
    deny?: string[]
  } = {},
): Promise<FakePubSub> {
  const project = options.project ?? 'fake-project'
  const secondMs = options.secondMs ?? 1000
  const pullWaitMs = options.pullWaitMs ?? 200
  const tokens = options.tokens ? new Set(options.tokens) : undefined
  const deny = new Set(options.deny ?? [])
  const topics = new Map<string, Topic>()
  const subscriptions = new Map<string, Subscription>()
  const failures = new Map<string, { status: number; message: string }>()
  const calls: string[] = []
  let nextId = 1000
  let nextAck = 1
  const waiting = new Set<() => void>()
  const wakeAll = () => {
    for (const wake of waiting) wake()
  }

  const full = (kind: 'topics' | 'subscriptions', name: string) =>
    name.startsWith('projects/') ? name : `projects/${project}/${kind}/${name}`
  const sub = (name: string) => {
    const found = subscriptions.get(full('subscriptions', name))
    if (!found) throw new Error(`no subscription ${name}`)
    return found
  }

  const addToTopic = (topicName: string, m: Topic['messages'][number]) => {
    const topic = topics.get(topicName)
    if (!topic) throw new Error(`no topic ${topicName}`)
    topic.messages.push(m)
    for (const name of topic.subscriptions) {
      subscriptions.get(name)!.entries.push({
        ...m,
        publishTime: new Date().toISOString(),
        deliveries: 0,
        acked: false,
        deadLettered: false,
      })
    }
    wakeAll()
  }

  const publish = (
    topic: string,
    data: string,
    attributes: Record<string, string> = {},
    orderingKey?: string,
  ) => {
    const messageId = String(nextId++)
    addToTopic(full('topics', topic), {
      messageId,
      data,
      attributes,
      ...(orderingKey ? { orderingKey } : {}),
    })
    return messageId
  }

  /** Deliveries that may go out now: not acked, not out, and (with ordering) the first unacked of their key. */
  const deliverable = (s: Subscription, now: number): Entry[] => {
    const blockedKeys = new Set<string>()
    const out: Entry[] = []
    for (const e of s.entries) {
      if (e.acked || e.deadLettered) continue
      if (e.out && e.out.until <= now) e.out = undefined
      const key = s.settings.enableMessageOrdering ? e.orderingKey : undefined
      if (key && blockedKeys.has(key)) continue
      if (key) blockedKeys.add(key)
      if (!e.out) out.push(e)
    }
    return out
  }

  const take = (s: Subscription, max: number) => {
    const now = Date.now()
    const deadline = (s.settings.ackDeadlineSeconds ?? 10) * secondMs
    const taken: Entry[] = []
    for (const e of deliverable(s, now)) {
      if (taken.length >= max) break
      const policy = s.settings.deadLetterPolicy
      if (policy && e.deliveries >= policy.maxDeliveryAttempts) {
        e.deadLettered = true
        addToTopic(full('topics', policy.deadLetterTopic), {
          messageId: String(nextId++),
          data: e.data,
          attributes: e.attributes,
        })
        continue
      }
      e.deliveries++
      e.out = { ackId: `ack-${nextAck++}-${e.messageId}`, until: now + deadline }
      taken.push(e)
    }
    return taken
  }

  const findOut = (s: Subscription, ackId: string) => {
    const now = Date.now()
    return s.entries.find((e) => e.out?.ackId === ackId && e.out.until > now)
  }

  const handle = async (method: string, path: string, body: Record<string, unknown>) => {
    const list = /^\/v1\/projects\/([^/]+)\/topics$/.exec(path)
    if (list && method === 'GET') {
      calls.push(`list projects/${list[1]}/topics`)
      const failure = failures.get('list')
      if (failure) {
        failures.delete('list')
        return { status: failure.status, json: { error: { code: failure.status, message: failure.message } } }
      }
      return {
        status: 200,
        json: {
          topics: [...topics.keys()]
            .filter((t) => t.startsWith(`projects/${list[1]}/`))
            .map((name) => ({ name })),
        },
      }
    }
    const m = /^\/v1\/(projects\/[^/]+\/(topics|subscriptions)\/[^/:]+)(?::(\w+))?$/.exec(path)
    if (!m) return { status: 404, json: { error: { code: 404, message: `no route ${path}` } } }
    const [, name, kind, verb] = m as unknown as [
      string,
      string,
      'topics' | 'subscriptions',
      string | undefined,
    ]
    const op = verb ?? (method === 'GET' ? 'get' : method.toLowerCase())
    calls.push(`${op} ${name}`)
    const failure = failures.get(op)
    if (failure) {
      failures.delete(op)
      return { status: failure.status, json: { error: { code: failure.status, message: failure.message } } }
    }
    if (deny.has(name))
      return {
        status: 403,
        json: {
          error: {
            code: 403,
            message: `User not authorized to perform this action.`,
            status: 'PERMISSION_DENIED',
          },
        },
      }
    if (kind === 'topics') {
      const topic = topics.get(name)
      if (!topic)
        return {
          status: 404,
          json: {
            error: { code: 404, message: `Resource not found (resource=${name}).`, status: 'NOT_FOUND' },
          },
        }
      if (op === 'get') return { status: 200, json: { name } }
      if (op === 'publish') {
        const messageIds = ((body.messages as Record<string, unknown>[]) ?? []).map((raw) => {
          const messageId = String(nextId++)
          addToTopic(name, {
            messageId,
            data: Buffer.from(String(raw.data ?? ''), 'base64').toString('utf8'),
            attributes: (raw.attributes as Record<string, string>) ?? {},
            ...(raw.orderingKey ? { orderingKey: String(raw.orderingKey) } : {}),
          })
          return messageId
        })
        return { status: 200, json: { messageIds } }
      }
    } else {
      const s = subscriptions.get(name)
      if (!s)
        return {
          status: 404,
          json: {
            error: { code: 404, message: `Resource not found (resource=${name}).`, status: 'NOT_FOUND' },
          },
        }
      if (op === 'get')
        return {
          status: 200,
          json: {
            name,
            topic: full('topics', s.settings.topic),
            ackDeadlineSeconds: s.settings.ackDeadlineSeconds ?? 10,
            enableMessageOrdering: s.settings.enableMessageOrdering ?? false,
            ...(s.settings.deadLetterPolicy
              ? {
                  deadLetterPolicy: {
                    ...s.settings.deadLetterPolicy,
                    deadLetterTopic: full('topics', s.settings.deadLetterPolicy.deadLetterTopic),
                  },
                }
              : {}),
          },
        }
      if (op === 'pull') {
        const max = Number(body.maxMessages ?? 1)
        let taken = take(s, max)
        if (!taken.length) {
          // Held until something arrives or a deadline passes, as Pub/Sub holds a pull a while.
          await new Promise<void>((resolve) => {
            const wake = () => {
              clearTimeout(timer)
              waiting.delete(wake)
              resolve()
            }
            const timer = setTimeout(wake, pullWaitMs)
            waiting.add(wake)
          })
          taken = take(s, max)
        }
        return {
          status: 200,
          json: {
            receivedMessages: taken.map((e) => ({
              ackId: e.out!.ackId,
              message: {
                data: Buffer.from(e.data).toString('base64'),
                ...(Object.keys(e.attributes).length ? { attributes: e.attributes } : {}),
                messageId: e.messageId,
                publishTime: e.publishTime,
                ...(e.orderingKey ? { orderingKey: e.orderingKey } : {}),
              },
              ...(s.settings.deadLetterPolicy ? { deliveryAttempt: e.deliveries } : {}),
            })),
          },
        }
      }
      if (op === 'acknowledge') {
        for (const ackId of (body.ackIds as string[]) ?? []) {
          const e = findOut(s, ackId)
          if (e) {
            e.acked = true
            e.out = undefined
          }
        }
        wakeAll()
        return { status: 200, json: {} }
      }
      if (op === 'modifyAckDeadline') {
        const seconds = Number(body.ackDeadlineSeconds)
        if (!(seconds >= 0 && seconds <= 600))
          return {
            status: 400,
            json: { error: { code: 400, message: 'Invalid ack deadline', status: 'INVALID_ARGUMENT' } },
          }
        for (const ackId of (body.ackIds as string[]) ?? []) {
          const e = findOut(s, ackId)
          if (!e) continue
          if (seconds === 0) e.out = undefined
          else e.out!.until = Date.now() + seconds * secondMs
        }
        wakeAll()
        return { status: 200, json: {} }
      }
    }
    return { status: 404, json: { error: { code: 404, message: `no ${op} on ${kind}` } } }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const auth = req.headers.authorization?.replace(/^Bearer /, '')
      const answer =
        tokens && !(auth && tokens.has(auth))
          ? {
              status: 401,
              json: {
                error: {
                  code: 401,
                  message: 'Request had invalid authentication credentials.',
                  status: 'UNAUTHENTICATED',
                },
              },
            }
          : await handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0]!, raw ? JSON.parse(raw) : {})
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  return {
    url,
    project,
    calls,
    createTopic(name) {
      topics.set(full('topics', name), { messages: [], subscriptions: new Set() })
    },
    createSubscription(name, settings) {
      const topic = topics.get(full('topics', settings.topic))
      if (!topic) throw new Error(`no topic ${settings.topic}`)
      const fullName = full('subscriptions', name)
      subscriptions.set(fullName, { settings, entries: [] })
      topic.subscriptions.add(fullName)
    },
    publish,
    messages: (subscription) =>
      sub(subscription).entries.map(({ out: _out, publishTime: _p, ...e }) => ({ ...e })),
    published: (topic) => (topics.get(full('topics', topic))?.messages ?? []).map((m) => ({ ...m })),
    redeliver(subscription, messageId) {
      const e = sub(subscription).entries.find((m) => m.messageId === messageId)
      if (!e) throw new Error(`no message ${messageId} on ${subscription}`)
      e.acked = false
      e.out = undefined
      wakeAll()
    },
    outstanding: (subscription) => {
      const now = Date.now()
      return sub(subscription).entries.filter((e) => !e.acked && e.out && e.out.until > now).length
    },
    failNext(method, status, message) {
      failures.set(method, { status, message })
    },
    async close() {
      wakeAll()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
