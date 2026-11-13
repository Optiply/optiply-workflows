import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  PoolManager,
  runQuery,
  sendgridConnector,
  testResource,
} from '../src'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

let fake: FakeServices
let pool: PoolManager

beforeAll(async () => {
  fake = await startFakeServices()
  configureServiceUrls(fake.urls)
  pool = new PoolManager()
})

afterAll(async () => {
  await pool.closeAll()
  await fake.stop()
  configureServiceUrls({})
})

const key = (region: 'global' | 'eu' = 'global', token = fake.sendgrid.key) =>
  resource({ region }, { token }, `${region}:${token}`)

const run = (query: unknown, scope: Record<string, unknown> = {}, r = key()) =>
  runQuery(pool, sendgridConnector, r, query, { evaluate: scopeEvaluator(scope) })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

describe('SendGrid resources', () => {
  it('test the key’s scopes, and warn when it can’t send', async () => {
    expect(await testResource(sendgridConnector, key())).toMatchObject({
      ok: true,
      message: 'SendGrid key with 3 scopes',
    })
    fake.sendgrid.scopes = ['scopes.read']
    try {
      expect(await testResource(sendgridConnector, key())).toMatchObject({
        message: 'SendGrid key with 1 scopes (no mail.send: it can’t send email)',
      })
    } finally {
      fake.sendgrid.scopes = ['mail.send', 'scopes.read', 'suppression.read']
    }
    const wrong = await testResource(sendgridConnector, key('global', 'SG.wrong'))
    expect(wrong).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('SendGrid: The provided authorization') },
    })
  })

  it('send a text and HTML email to several people, with cc, reply-to and categories', async () => {
    const out = await run(
      {
        action: 'send',
        from: 'Optiply <noreply@optiply.example>',
        to: 'ada@example.com, Grace Hopper <grace@example.com>',
        cc: '{{ ccs }}',
        replyTo: 'support@optiply.example',
        subject: 'Order {{ id }}',
        text: 'Your order {{ id }} shipped.',
        html: '<p>Your order <b>{{ id }}</b> shipped.</p>',
        categories: 'orders, shipping',
      },
      { id: 42, ccs: ['ops@optiply.example'] },
    )
    expect(out.data).toEqual({ messageId: 'msg-1', status: 202, recipients: 2 })
    expect(fake.sendgrid.mails.at(-1)).toEqual({
      region: 'global',
      mail: {
        personalizations: [
          {
            to: [{ email: 'ada@example.com' }, { email: 'grace@example.com', name: 'Grace Hopper' }],
            cc: [{ email: 'ops@optiply.example' }],
          },
        ],
        from: { email: 'noreply@optiply.example', name: 'Optiply' },
        reply_to: { email: 'support@optiply.example' },
        subject: 'Order 42',
        content: [
          { type: 'text/plain', value: 'Your order 42 shipped.' },
          { type: 'text/html', value: '<p>Your order <b>42</b> shipped.</p>' },
        ],
        categories: ['orders', 'shipping'],
      },
    })
  })

  it('send a dynamic template with data and an attachment, one email per recipient, on the EU host', async () => {
    await run(
      {
        action: 'send',
        from: 'noreply@optiply.example',
        to: '{{ to }}',
        separate: 'true',
        templateId: 'd-123',
        templateData: '{"name": {{ name }}, "lines": {{ lines }}}',
        attachments: '{{ files }}',
        sendAt: '2026-11-02T09:00:00Z',
      },
      {
        to: ['a@example.com', 'b@example.com'],
        name: 'Ada',
        lines: [{ sku: 'A-1' }],
        files: [
          {
            base64: Buffer.from('%PDF').toString('base64'),
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
      key('eu'),
    )
    const sent = fake.sendgrid.mails.at(-1)!
    expect(sent.region).toBe('eu')
    expect(sent.mail).toMatchObject({
      template_id: 'd-123',
      personalizations: [
        { to: [{ email: 'a@example.com' }], dynamic_template_data: { name: 'Ada', lines: [{ sku: 'A-1' }] } },
        { to: [{ email: 'b@example.com' }], dynamic_template_data: { name: 'Ada', lines: [{ sku: 'A-1' }] } },
      ],
      attachments: [
        { content: 'JVBERg==', filename: 'invoice.pdf', type: 'application/pdf', disposition: 'attachment' },
      ],
      send_at: Date.parse('2026-11-02T09:00:00Z') / 1000,
    })
  })

  it('check addresses and content before sending, and pass SendGrid’s refusals on', async () => {
    const bad = await failure(
      run({ action: 'send', from: 'nobody', to: 'a@example.com', subject: 's', text: 't' }),
    )
    expect(bad.message).toBe('From: "nobody" isn\'t an email address')
    const empty = await failure(
      run({ action: 'send', from: 'a@example.com', to: 'b@example.com', subject: 's' }),
    )
    expect(empty.message).toContain('text or HTML')
    const noName = await failure(
      run(
        {
          action: 'send',
          from: 'a@example.com',
          to: 'b@example.com',
          subject: 's',
          text: 't',
          attachments: '{{ f }}',
        },
        { f: 'AAAA' },
      ),
    )
    expect(noName.message).toBe('Attachment 1 has no filename')

    fake.sendgrid.scopes = ['scopes.read']
    try {
      const refused = await failure(
        run({ action: 'send', from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' }),
      )
      expect(refused).toMatchObject({
        code: 'http',
        message: 'SendGrid: access forbidden',
        details: { status: 403 },
      })
    } finally {
      fake.sendgrid.scopes = ['mail.send', 'scopes.read', 'suppression.read']
    }
  })

  it('keep a quoted name with a comma in one address', async () => {
    await run({
      action: 'send',
      from: 'a@example.com',
      to: '"Doe, John" <john@example.com>, b@example.com',
      subject: 's',
      text: 't',
    })
    expect(fake.sendgrid.mails.at(-1)?.mail).toMatchObject({
      personalizations: [
        { to: [{ email: 'john@example.com', name: 'Doe, John' }, { email: 'b@example.com' }] },
      ],
    })
  })

  it('call any /v3 endpoint, and only those', async () => {
    const bounces = await run({ action: 'api', method: 'GET', path: '/v3/suppression/bounces' })
    expect(bounces.data).toEqual([{ email: 'gone@example.com', reason: '550', created: 1700000000 }])
    const away = await failure(run({ action: 'api', method: 'GET', path: '/v2/../v3/x' }))
    expect(away.code).toBe('invalid_query')
    const encoded = await failure(run({ action: 'api', method: 'GET', path: '/v3/%2e%2e/admin' }))
    expect(encoded.code).toBe('invalid_query')
    const getBody = await failure(run({ action: 'api', method: 'GET', path: '/v3/scopes', body: '{}' }))
    expect(getBody.message).toBe("GET requests can't have a body")
    expect(JSON.stringify(bounces)).not.toContain(fake.sendgrid.key)
  })
})
