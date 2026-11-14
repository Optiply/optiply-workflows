import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureGmail,
  configureServiceUrls,
  gmailConnector,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import { buildMime, decodeWords, formatAddress, readPayload } from '../src/services/mime'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// Gmail (M37, docs/architecture.md §2.41): Google sign-in and domain-wide delegation, against the fake.

let fake: FakeServices
let pool: PoolManager
const OAUTH_TOKEN = 'ya29.oauth-ada'

beforeAll(async () => {
  fake = await startFakeServices({ gmailTrust: (t) => (t === OAUTH_TOKEN ? 'ada@example.com' : null) })
  configureServiceUrls(fake.urls)
  configureGmail({ tokenUrl: fake.urls.googleToken })
  pool = new PoolManager()
})
afterAll(async () => {
  await pool.closeAll()
  await fake.stop()
  configureServiceUrls({})
  configureGmail({})
})

let orderId: string
beforeEach(() => {
  fake.gmail.mailboxes.clear()
  fake.gmail.sent.length = 0
  orderId = fake.gmail.seed('support@optiply.nl', {
    from: 'Ada <ada@example.com>',
    to: 'support@optiply.nl',
    subject: 'Order 1042: 3 lamps',
    text: 'Hi, please send 3 lamps.',
    html: '<p>Hi, please send <b>3</b> lamps.</p>',
    messageId: '<order-1042@example.com>',
    attachments: [{ filename: 'order.csv', mimeType: 'text/csv', content: 'sku,qty\nLAMP,3\n' }],
  })
  fake.gmail.seed('support@optiply.nl', {
    from: 'news@example.com',
    to: 'support@optiply.nl',
    subject: 'Newsletter',
    text: 'News',
    labels: ['INBOX'],
  })
  fake.gmail.seed('sales@optiply.nl', {
    from: 'bob@example.com',
    to: 'sales@optiply.nl',
    subject: 'Quote',
    text: 'Q',
  })
})

const delegated = (mailbox?: string) =>
  resource(
    { auth: { type: 'delegation', ...(mailbox && { mailbox }) } },
    { serviceAccountKey: fake.sheets.serviceAccountKey },
    `delegated-${mailbox}`,
  )
const signedIn = () =>
  resource({ auth: { type: 'oauth', clientId: 'client-1' } }, { clientSecret: 's' }, 'oauth')

const parsed = (r: ReturnType<typeof resource>) => ({
  ...r,
  config: gmailConnector.configSchema.parse(r.config),
  secrets: gmailConnector.secretsSchema.parse(r.secrets),
})

const run = (
  query: Record<string, string>,
  r = delegated('support@optiply.nl'),
  scope: Record<string, unknown> = {},
) =>
  runQuery(pool, gmailConnector, parsed(r), query, {
    evaluate: scopeEvaluator(scope),
    credentials: { accessToken: async () => OAUTH_TOKEN },
  })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('Expected a failure')
}

describe('domain-wide delegation', () => {
  it('searches the default mailbox with headers, and another mailbox a query names', async () => {
    const found = await run({ action: 'search', q: 'from:ada is:unread' })
    expect(found.data).toEqual([
      expect.objectContaining({
        id: orderId,
        from: 'Ada <ada@example.com>',
        subject: 'Order 1042: 3 lamps',
        labelIds: ['INBOX', 'UNREAD'],
        date: expect.stringMatching(/^2026-11-13T/),
      }),
    ])
    expect(found.metadata).toMatchObject({
      mailbox: 'support@optiply.nl',
      truncated: false,
      resultSizeEstimate: 1,
    })
    const other = await run({ action: 'search', q: 'quote', mailbox: 'sales@optiply.nl' })
    expect((other.data as { subject: string }[]).map((m) => m.subject)).toEqual(['Quote'])
    // One token per mailbox, each with its `sub`.
    expect(fake.gmail.acceptTokens.size).toBe(2)
    expect([...fake.gmail.acceptTokens.values()].sort()).toEqual(['sales@optiply.nl', 'support@optiply.nl'])
  })

  it('pages ids only when asked, up to the limit', async () => {
    for (let i = 0; i < 4; i++)
      fake.gmail.seed('support@optiply.nl', {
        from: 'x@example.com',
        to: 's',
        subject: `Bulk ${i}`,
        text: 'b',
      })
    const ids = await run({ action: 'search', q: 'bulk', details: 'false', max: '3' })
    expect(ids.data).toHaveLength(3)
    expect((ids.data as object[])[0]).toEqual({ id: expect.any(String), threadId: expect.any(String) })
    expect(ids.metadata).toMatchObject({ truncated: true })
  })

  it('reads a message: headers, text and HTML decoded, attachments listed; an attachment as a file object', async () => {
    const message = await run({ action: 'getMessage', id: orderId })
    expect(message.data).toMatchObject({
      id: orderId,
      subject: 'Order 1042: 3 lamps',
      messageId: '<order-1042@example.com>',
      text: 'Hi, please send 3 lamps.',
      html: '<p>Hi, please send <b>3</b> lamps.</p>',
      attachments: [
        { filename: 'order.csv', mimeType: 'text/csv', attachmentId: `att-${orderId}-0`, size: 15 },
      ],
    })
    const file = await run({
      action: 'getAttachment',
      messageId: orderId,
      attachmentId: `att-${orderId}-0`,
      filename: 'order.csv',
      contentType: 'text/csv',
    })
    expect(file.data).toEqual({
      base64: Buffer.from('sku,qty\nLAMP,3\n').toString('base64'),
      size: 15,
      filename: 'order.csv',
      contentType: 'text/csv',
    })
    const thread = await run({ action: 'getThread', id: orderId })
    expect(thread.data).toMatchObject({ id: orderId, messages: [{ id: orderId }] })
  })

  it('sends with a UTF-8 subject, HTML and an attachment from a file object', async () => {
    const sent = await run(
      {
        action: 'send',
        to: 'Zoë Ünal <zoe@example.com>, bob@example.com',
        bcc: 'audit@optiply.nl',
        subject: 'Bestelling ontvangen ✓',
        text: 'Dank je!',
        html: '<p>Dank je!</p>',
        attachments: '{{ file }}',
      },
      delegated('support@optiply.nl'),
      {
        file: {
          base64: Buffer.from('PDF!').toString('base64'),
          filename: 'factuur €.pdf',
          contentType: 'application/pdf',
        },
      },
    )
    expect(sent.data).toMatchObject({ id: expect.any(String), labelIds: ['SENT'] })
    const raw = fake.gmail.sent[0]!.raw
    expect(raw).toContain('To: =?UTF-8?B?')
    expect(raw).toContain(', bob@example.com')
    expect(raw).toContain('Bcc: audit@optiply.nl')
    expect(decodeWords(/^Subject: (.*(?:\r\n .*)*)/m.exec(raw)![1]!.replace(/\r\n /g, ' '))).toBe(
      'Bestelling ontvangen ✓',
    )
    expect(raw).toMatch(/multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*text\/plain[\s\S]*text\/html/)
    expect(raw).toContain("filename*=UTF-8''factuur%20%E2%82%AC.pdf")
    expect(raw).toContain(Buffer.from('PDF!').toString('base64'))
  })

  it('replies in the thread with In-Reply-To, References, Re: and the sender', async () => {
    await run({ action: 'send', replyToMessage: orderId, text: 'On its way.' })
    const sent = fake.gmail.sent[0]!
    expect(sent.threadId).toBe(orderId)
    expect(sent.raw).toContain('To: Ada <ada@example.com>')
    expect(sent.raw).toContain('Subject: Re: Order 1042: 3 lamps')
    expect(sent.raw).toContain('In-Reply-To: <order-1042@example.com>')
    expect(sent.raw).toContain('References: <order-1042@example.com>')
  })

  it('takes a user label named in capitals as a name (review fix)', async () => {
    fake.gmail.mailboxes.get('support@optiply.nl')!.labels.push({ id: 'Label_9', name: 'VIP', type: 'user' })
    const labelled = await run({ action: 'modifyLabels', id: orderId, add: 'VIP' })
    expect(labelled.data).toMatchObject({ labelIds: expect.arrayContaining(['Label_9']) })
  })

  it('labels by name or id, trashes, drafts and lists labels', async () => {
    const labelled = await run({ action: 'modifyLabels', id: orderId, add: 'Orders', remove: 'UNREAD' })
    expect(labelled.data).toMatchObject({ labelIds: ['INBOX', 'Label_1'] })
    expect((await failure(run({ action: 'modifyLabels', id: orderId, add: 'Nope' }))).message).toContain(
      'No label "Nope" in support@optiply.nl',
    )
    expect((await run({ action: 'trash', id: orderId })).data).toMatchObject({
      labelIds: ['Label_1', 'TRASH'],
    })
    const draft = await run({ action: 'createDraft', to: 'ada@example.com', subject: 'Draft', text: 'later' })
    expect(draft.data).toMatchObject({ message: { labelIds: ['DRAFT'] } })
    expect(fake.gmail.sent.at(-1)).toMatchObject({ kind: 'draft' })
    const labels = await run({ action: 'listLabels' })
    expect(labels.data).toContainEqual({ id: 'Label_1', name: 'Orders', type: 'user' })
    const api = await run({ action: 'api', method: 'GET', path: '/profile' })
    expect(api.data).toMatchObject({ emailAddress: 'support@optiply.nl' })
    expect((await failure(run({ action: 'api', method: 'GET', path: '/../../other' }))).message).toContain(
      'stays under',
    )
  })

  it('needs a mailbox, says when a key is refused, and tests the default mailbox', async () => {
    expect((await failure(run({ action: 'listLabels' }, delegated()))).message).toContain('Name the mailbox')
    expect(await testResource(gmailConnector, parsed(delegated('support@optiply.nl')))).toMatchObject({
      ok: true,
      message: expect.stringContaining('support@optiply.nl, 2 messages'),
    })
    const badKey = resource(
      { auth: { type: 'delegation', mailbox: 'a@b.nl' } },
      { serviceAccountKey: '{}' },
      'bad',
    )
    expect(() => gmailConnector.secretsSchema.parse(badKey.secrets)).toThrow()
  })
})

describe('Google sign-in', () => {
  it('acts as the signed-in account (me) with the OAuth token; another mailbox is refused by Gmail', async () => {
    fake.gmail.seed('ada@example.com', {
      from: 'x@example.com',
      to: 'ada@example.com',
      subject: 'Hello Ada',
      text: 'hi',
    })
    const found = await run({ action: 'search', q: 'hello' }, signedIn())
    expect((found.data as { subject: string }[]).map((m) => m.subject)).toEqual(['Hello Ada'])
    expect(fake.calls.at(-1)!.path).toContain('/users/me/messages/')
    const refused = await failure(run({ action: 'listLabels', mailbox: 'support@optiply.nl' }, signedIn()))
    expect(refused.message).toContain('Delegation denied')
    expect(
      gmailConnector.httpConfig!(
        gmailConnector.configSchema.parse({ auth: { type: 'oauth', clientId: 'c' } }),
      ),
    ).toMatchObject({
      auth: {
        type: 'oauth2AuthorizationCode',
        provider: 'google',
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
      },
    })
  })
})

describe('MIME', () => {
  it('refuses header injection and bad addresses, quotes names that need it', () => {
    expect(() => buildMime({ to: ['a@b.nl'], subject: 'x\r\nBcc: evil@x.com' })).toThrow(/line break/)
    expect(() => formatAddress('not an address', 'To')).toThrow(/isn't an email address/)
    expect(formatAddress('Smith, John <j@x.nl>', 'To')).toBe('"Smith, John" <j@x.nl>')
    expect(() => buildMime({ to: [] })).toThrow(/To is empty/)
  })

  it('reads latin-1 bodies and encoded headers', () => {
    const read = readPayload({
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: '=?ISO-8859-1?Q?Caf=E9?=' },
        { name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' },
      ],
      body: { data: Buffer.from('caf\xe9', 'latin1').toString('base64url') },
    })
    expect(read).toMatchObject({ headers: { subject: 'Café' }, text: 'café' })
  })
})
