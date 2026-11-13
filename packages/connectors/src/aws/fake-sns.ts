import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { ServiceHandler } from './fake'
import { jsonError } from './fake'

// A fake of SNS for tests (M30): topics; PublishBatch (the query protocol's XML, or JSON, whichever the SDK sends);
// HTTP subscriptions that are sent a signed SubscriptionConfirmation and, once confirmed through their SubscribeURL,
// each message as a signed Notification, as SNS does. Its signing key's public half is served as the "certificate".

export interface FakeSnsMessage {
  topicArn: string
  messageId: string
  message: string
  subject?: string
  attributes: Record<string, string>
  groupId?: string
}

export interface FakeSns {
  /** Where the signing key is served (`SigningCertURL`). */
  certUrl: string
  createTopic(name: string): string
  /** Subscribes an HTTP endpoint: it's sent a SubscriptionConfirmation at once. */
  subscribe(topicArn: string, endpoint: string): Promise<void>
  /** Whether an endpoint confirmed (fetched its SubscribeURL). */
  confirmed(topicArn: string, endpoint: string): boolean
  messages: FakeSnsMessage[]
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

export function fakeSns(
  handlers: Map<string, ServiceHandler>,
  account: string,
  baseUrl: () => string,
): FakeSns {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const topics = new Map<
    string,
    { subscriptions: { endpoint: string; token: string; confirmed: boolean }[] }
  >()
  const messages: FakeSnsMessage[] = []

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

  const xml = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'content-type': 'text/xml' })
    res.end(text)
  }

  handlers.set('sns', async (req, res) => {
    const json = typeof req.headers['x-amz-target'] === 'string'
    const form = json ? null : new URLSearchParams(req.body.toString('utf8'))
    const body = json ? (JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>) : {}
    const action = json ? String(req.headers['x-amz-target']).split('.').pop() : form!.get('Action')
    if (action !== 'PublishBatch')
      return json
        ? jsonError(res, 400, 'InvalidAction', `The fake doesn't do ${action}`)
        : xml(
            res,
            400,
            `<ErrorResponse><Error><Type>Sender</Type><Code>InvalidAction</Code><Message>${action}</Message></Error></ErrorResponse>`,
          )
    const topicArn = json ? String(body.TopicArn) : form!.get('TopicArn')!
    if (!topics.has(topicArn))
      return json
        ? jsonError(res, 404, 'NotFound', 'Topic does not exist')
        : xml(
            res,
            404,
            '<ErrorResponse><Error><Type>Sender</Type><Code>NotFound</Code><Message>Topic does not exist</Message></Error><RequestId>r</RequestId></ErrorResponse>',
          )
    type Entry = {
      Id: string
      Message: string
      Subject?: string
      MessageGroupId?: string
      MessageAttributes?: Record<string, { StringValue?: string }>
    }
    let entries: Entry[]
    if (json) entries = (body.PublishBatchRequestEntries as Entry[]) ?? []
    else {
      entries = []
      for (let n = 1; form!.has(`PublishBatchRequestEntries.member.${n}.Id`); n++) {
        const p = `PublishBatchRequestEntries.member.${n}.`
        const attributes: Record<string, { StringValue?: string }> = {}
        for (let a = 1; form!.has(`${p}MessageAttributes.entry.${a}.Name`); a++)
          attributes[form!.get(`${p}MessageAttributes.entry.${a}.Name`)!] = {
            StringValue: form!.get(`${p}MessageAttributes.entry.${a}.Value.StringValue`) ?? '',
          }
        entries.push({
          Id: form!.get(`${p}Id`)!,
          Message: form!.get(`${p}Message`) ?? '',
          ...(form!.get(`${p}Subject`) && { Subject: form!.get(`${p}Subject`)! }),
          ...(form!.get(`${p}MessageGroupId`) && { MessageGroupId: form!.get(`${p}MessageGroupId`)! }),
          MessageAttributes: attributes,
        })
      }
    }
    if (entries.length > 10) {
      jsonError(res, 400, 'TooManyEntriesInBatchRequest', 'At most 10 entries')
      return
    }
    const successful: { Id: string; MessageId: string }[] = []
    for (const e of entries) {
      const messageId = randomUUID()
      messages.push({
        topicArn,
        messageId,
        message: e.Message,
        ...(e.Subject && { subject: e.Subject }),
        ...(e.MessageGroupId && { groupId: e.MessageGroupId }),
        attributes: Object.fromEntries(
          Object.entries(e.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        ),
      })
      successful.push({ Id: e.Id, MessageId: messageId })
      for (const s of topics.get(topicArn)!.subscriptions.filter((x) => x.confirmed)) {
        const env = signed(
          {
            Type: 'Notification',
            MessageId: messageId,
            TopicArn: topicArn,
            Message: e.Message,
            Timestamp: new Date().toISOString(),
            ...(e.Subject && { Subject: e.Subject }),
          },
          '2',
        )
        void post(s.endpoint, env)
      }
    }
    if (json) {
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' })
      res.end(JSON.stringify({ Successful: successful, Failed: [] }))
      return
    }
    xml(
      res,
      200,
      `<PublishBatchResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishBatchResult><Successful>${successful
        .map((s) => `<member><Id>${s.Id}</Id><MessageId>${s.MessageId}</MessageId></member>`)
        .join(
          '',
        )}</Successful><Failed/></PublishBatchResult><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></PublishBatchResponse>`,
    )
  })

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
    messages,
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
