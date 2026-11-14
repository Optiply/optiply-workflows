import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'

// A fake of SNS's side of a webhook subscription for tests (M30, the webhook's SNS option): topics; HTTP subscriptions
// that are sent a signed SubscriptionConfirmation and, once confirmed through their SubscribeURL, each published
// message as a signed Notification, as SNS does. Its signing key's public half is served as the "certificate".

export interface FakeSns {
  /** Where the signing key is served (`SigningCertURL`). */
  certUrl: string
  createTopic(name: string): string
  /** Subscribes an HTTP endpoint: it's sent a SubscriptionConfirmation at once. */
  subscribe(topicArn: string, endpoint: string): Promise<void>
  /** Whether an endpoint confirmed (fetched its SubscribeURL). */
  confirmed(topicArn: string, endpoint: string): boolean
  /** Publishes a message to a topic: each confirmed subscription is posted it as a signed Notification. */
  publish(topicArn: string, message: string, subject?: string): Promise<string>
  /** A signed envelope as SNS would send it, for tests that post it themselves (to tamper with it). */
  envelope(
    type: 'Notification' | 'SubscriptionConfirmation',
    topicArn: string,
    message: string,
    extra?: { subject?: string; signatureVersion?: '1' | '2'; endpoint?: string },
  ): Record<string, string>
  /** The fake's own routes (certificate, confirmation): handled before signature checks. */
  route(path: string, res: ServerResponse): boolean
}

export function fakeSns(account: string, baseUrl: () => string): FakeSns {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const topics = new Map<
    string,
    { subscriptions: { endpoint: string; token: string; confirmed: boolean }[] }
  >()

  const signed = (fields: Record<string, string>, version: '1' | '2') => {
    const keys =
      fields.Type === 'Notification'
        ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
    const text = keys
      .filter((k) => fields[k] !== undefined)
      .map((k) => `${k}\n${fields[k]}\n`)
      .join('')
    const signer = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256')
    signer.update(text)
    return {
      ...fields,
      SignatureVersion: version,
      Signature: signer.sign(privateKey, 'base64'),
      SigningCertURL: `${baseUrl()}/sns-cert.pem`,
    }
  }

  const envelope: FakeSns['envelope'] = (type, topicArn, message, extra = {}) => {
    const base: Record<string, string> = {
      Type: type,
      MessageId: randomUUID(),
      TopicArn: topicArn,
      Message: message,
      Timestamp: new Date().toISOString(),
      ...(extra.subject && { Subject: extra.subject }),
    }
    if (type === 'SubscriptionConfirmation') {
      const token = randomUUID().replaceAll('-', '')
      base.Token = token
      // A pending subscription its SubscribeURL confirms (for `endpoint`, or '' when a test posts it itself).
      topics.get(topicArn)?.subscriptions.push({ endpoint: extra.endpoint ?? '', token, confirmed: false })
      base.SubscribeURL = `${baseUrl()}/sns-confirm?TopicArn=${encodeURIComponent(topicArn)}&Token=${token}`
    }
    return signed(base, extra.signatureVersion ?? '2')
  }

  const post = (endpoint: string, body: Record<string, string>) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'x-amz-sns-message-type': body.Type!,
        'x-amz-sns-message-id': body.MessageId!,
        'x-amz-sns-topic-arn': body.TopicArn!,
      },
      body: JSON.stringify(body),
    }).catch(() => undefined)

  return {
    get certUrl() {
      return `${baseUrl()}/sns-cert.pem`
    },
    createTopic(name) {
      const arn = `arn:aws:sns:eu-west-1:${account}:${name}`
      topics.set(arn, { subscriptions: [] })
      return arn
    },
    async subscribe(topicArn, endpoint) {
      const topic = topics.get(topicArn)
      if (!topic) throw new Error(`no topic ${topicArn}`)
      const env = envelope(
        'SubscriptionConfirmation',
        topicArn,
        `You have chosen to subscribe to the topic ${topicArn}.`,
        { endpoint },
      )
      await post(endpoint, env)
    },
    confirmed(topicArn, endpoint) {
      return !!topics.get(topicArn)?.subscriptions.find((s) => s.endpoint === endpoint)?.confirmed
    },
    async publish(topicArn, message, subject) {
      const topic = topics.get(topicArn)
      if (!topic) throw new Error(`no topic ${topicArn}`)
      const messageId = randomUUID()
      const env = signed(
        {
          Type: 'Notification',
          MessageId: messageId,
          TopicArn: topicArn,
          Message: message,
          Timestamp: new Date().toISOString(),
          ...(subject && { Subject: subject }),
        },
        '2',
      )
      await Promise.all(topic.subscriptions.filter((x) => x.confirmed).map((x) => post(x.endpoint, env)))
      return messageId
    },
    envelope,
    route(path, res) {
      const url = new URL(path, 'http://x')
      if (url.pathname === '/sns-cert.pem') {
        res.writeHead(200, { 'content-type': 'application/x-pem-file' })
        res.end(pem)
        return true
      }
      if (url.pathname === '/sns-confirm') {
        const topic = topics.get(url.searchParams.get('TopicArn') ?? '')
        const sub = topic?.subscriptions.find((s) => s.token === url.searchParams.get('Token'))
        if (sub) sub.confirmed = true
        res.writeHead(sub ? 200 : 404, { 'content-type': 'text/xml' })
        res.end(
          sub
            ? `<ConfirmSubscriptionResponse><ConfirmSubscriptionResult><SubscriptionArn>${url.searchParams.get('TopicArn')}:${randomUUID()}</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>`
            : '<Error/>',
        )
        return true
      }
      return false
    },
  }
}
