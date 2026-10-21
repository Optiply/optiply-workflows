import { describe, expect, it } from 'vitest'
import {
  parseSignedPayload,
  resolveWebhookSettings,
  validateDefinition,
  workflowDefinitionSchema,
} from '../src'
import { checkBodySchema, compileBodySchema } from '../src/body-schema'
import { start, wf } from './helpers'

const withWebhook = (webhook: object) =>
  wf([start], [], { triggers: { webhook: { enabled: true, ...webhook } } })

const diagnostics = (webhook: object) =>
  validateDefinition(withWebhook(webhook), { checkBodySchema }).diagnostics.map(
    ({ code, message, path }) => ({
      code,
      message,
      path: path.slice(1).join('.'),
    }),
  )

describe('the webhook schema', () => {
  it('accepts the three kinds of auth and the new settings', () => {
    for (const auth of [
      { type: 'apiKey' },
      { type: 'public' },
      { type: 'signature', preset: 'stripe', secret: 'STRIPE_SECRET' },
      {
        type: 'signature',
        preset: 'custom',
        secret: 'S',
        header: 'X-Sig',
        algorithm: 'sha512',
        encoding: 'base64',
        prefix: 'v1=',
        timestampHeader: 'X-Ts',
        signedPayload: '{timestamp}:{body}',
        toleranceSeconds: 60,
      },
    ]) {
      const def = withWebhook({
        auth,
        bodySchema: { type: 'object' },
        rateLimit: { requests: 10, windowSeconds: 1 },
        environments: ['production'],
        idempotencyHeader: 'X-Delivery',
      })
      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true)
    }
  })

  it('refuses unknown auth types, presets, keys and limits out of range', () => {
    const bad = [
      { auth: { type: 'basic' } },
      { auth: { type: 'signature', preset: 'paypal', secret: 'S' } },
      { auth: { type: 'public', secret: 'S' } },
      { rateLimit: { requests: 0, windowSeconds: 60 } },
      { rateLimit: { requests: 1, windowSeconds: 86_401 } },
      { environments: [] },
      { bodySchema: [] },
    ]
    for (const webhook of bad) {
      expect(workflowDefinitionSchema.safeParse(withWebhook(webhook)).success, JSON.stringify(webhook)).toBe(
        false,
      )
    }
  })
})

describe('resolveWebhookSettings', () => {
  it("keeps today's behaviour for webhooks without the new settings", () => {
    expect(resolveWebhookSettings({ enabled: true })).toEqual({
      enabled: true,
      methods: ['POST'],
      syncTimeoutMs: 30_000,
      auth: { type: 'apiKey' },
      bodySchema: null,
      rateLimit: null,
      environments: 'all',
      idempotencyHeader: null,
    })
  })

  it('limits signed and public webhooks by default', () => {
    for (const auth of [
      { type: 'public' as const },
      { type: 'signature' as const, preset: 'slack' as const, secret: 'S' },
    ]) {
      expect(resolveWebhookSettings({ enabled: true, auth })).toMatchObject({
        rateLimit: { requests: 60, windowSeconds: 60 },
        environments: 'default',
      })
    }
    expect(
      resolveWebhookSettings({
        enabled: true,
        auth: { type: 'public' },
        rateLimit: { requests: 5, windowSeconds: 10 },
        environments: ['staging'],
      }),
    ).toMatchObject({ rateLimit: { requests: 5, windowSeconds: 10 }, environments: ['staging'] })
  })

  it("takes a preset's delivery id as the idempotency header, unless the webhook names one", () => {
    const github = { type: 'signature' as const, preset: 'github' as const, secret: 'S' }
    expect(resolveWebhookSettings({ enabled: true, auth: github }).idempotencyHeader).toBe(
      'x-github-delivery',
    )
    expect(
      resolveWebhookSettings({ enabled: true, auth: github, idempotencyHeader: 'X-Other' }).idempotencyHeader,
    ).toBe('x-other')
    expect(
      resolveWebhookSettings({ enabled: true, auth: { type: 'signature', preset: 'stripe', secret: 'S' } })
        .idempotencyHeader,
    ).toBeNull()
  })
})

describe('parseSignedPayload', () => {
  it('splits text and parts', () => {
    expect(parseSignedPayload('v0:{timestamp}:{body}')).toEqual({
      ok: true,
      pieces: [{ text: 'v0:' }, { part: 'timestamp' }, { text: ':' }, { part: 'body' }],
    })
    expect(parseSignedPayload('{method}{url}{body}{timestamp}')).toMatchObject({ ok: true })
  })

  it('refuses unknown parts and a payload without the body', () => {
    expect(parseSignedPayload('{ts}.{body}')).toMatchObject({ ok: false, error: 'Unknown part {ts}' })
    expect(parseSignedPayload('{timestamp}')).toEqual({
      ok: false,
      error: 'The signed payload must include {body}',
    })
  })
})

describe('validateDefinition: webhook settings', () => {
  it('accepts complete settings', () => {
    expect(
      diagnostics({
        auth: { type: 'signature', preset: 'stripe', secret: 'STRIPE_WEBHOOK_SECRET', toleranceSeconds: 600 },
        bodySchema: {
          type: 'object',
          properties: { id: { type: 'string' }, created: { type: 'string', format: 'date-time' } },
          required: ['id'],
        },
        environments: ['production', 'staging'],
        idempotencyHeader: 'X-Request-Id',
      }),
    ).toEqual([])
  })

  it('checks the secret, the custom fields and the signed payload', () => {
    expect(diagnostics({ auth: { type: 'signature', preset: 'github', secret: '' } })).toEqual([
      {
        code: 'invalid_webhook_auth',
        message: 'Choose the secret config var that holds the signing secret',
        path: 'webhook.auth.secret',
      },
    ])
    expect(
      diagnostics({
        auth: { type: 'signature', preset: 'github', secret: '1X', prefix: 'sha256=', toleranceSeconds: 60 },
      }),
    ).toEqual([
      { code: 'invalid_webhook_auth', message: '"1X" isn\'t a config var name', path: 'webhook.auth.secret' },
      {
        code: 'invalid_webhook_auth',
        message: 'The GitHub preset sets "prefix" itself; it\'s for custom signatures only',
        path: 'webhook.auth.prefix',
      },
      {
        code: 'invalid_webhook_auth',
        message: 'A tolerance only applies to signatures with a timestamp',
        path: 'webhook.auth.toleranceSeconds',
      },
    ])
    expect(
      diagnostics({
        auth: {
          type: 'signature',
          preset: 'custom',
          secret: 'S',
          timestampHeader: 'X Ts',
          signedPayload: '{timestamp}',
        },
      }),
    ).toEqual([
      {
        code: 'invalid_webhook_auth',
        message: 'Name the header that carries the signature',
        path: 'webhook.auth.header',
      },
      {
        code: 'invalid_webhook_auth',
        message: '"X Ts" isn\'t a header name',
        path: 'webhook.auth.timestampHeader',
      },
      {
        code: 'invalid_webhook_auth',
        message: 'The signed payload must include {body}',
        path: 'webhook.auth.signedPayload',
      },
    ])
    expect(
      diagnostics({
        auth: {
          type: 'signature',
          preset: 'custom',
          secret: 'S',
          header: 'X-Sig',
          signedPayload: '{timestamp}.{body}',
        },
      }),
    ).toEqual([
      {
        code: 'invalid_webhook_auth',
        message: 'The signed payload uses {timestamp}: name the header that carries it',
        path: 'webhook.auth.timestampHeader',
      },
    ])
  })

  it('checks the body schema when given the checker, and its size always', () => {
    expect(diagnostics({ bodySchema: { type: 'objekt' } })).toMatchObject([
      { code: 'invalid_body_schema', path: 'webhook.bodySchema' },
    ])
    expect(diagnostics({ bodySchema: { type: 'string', fromat: 'email' } })).toMatchObject([
      { code: 'invalid_body_schema', message: expect.stringContaining('fromat') },
    ])
    const huge = { type: 'object', description: 'x'.repeat(70_000) }
    expect(validateDefinition(withWebhook({ bodySchema: huge })).diagnostics).toMatchObject([
      { code: 'invalid_body_schema', message: 'The body schema is larger than 64 KB' },
    ])
    // Without the checker, a schema that doesn't compile isn't noticed.
    expect(validateDefinition(withWebhook({ bodySchema: { type: 'objekt' } })).diagnostics).toEqual([])
  })

  it('checks the environments and the idempotency header', () => {
    expect(
      diagnostics({ environments: ['production', '', 'production'], idempotencyHeader: 'Bad Header' }),
    ).toEqual([
      { code: 'invalid_webhook', message: 'Choose an environment', path: 'webhook.environments.1' },
      { code: 'invalid_webhook', message: '"production" is listed twice', path: 'webhook.environments.2' },
      {
        code: 'invalid_webhook',
        message: '"Bad Header" isn\'t a header name',
        path: 'webhook.idempotencyHeader',
      },
    ])
  })
})

describe('compileBodySchema', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      items: {
        type: 'array',
        items: { type: 'object', properties: { qty: { type: 'integer', minimum: 1 } } },
      },
    },
    required: ['id'],
  }

  it('validates bodies and reports the errors with JSON Pointers', () => {
    const compiled = compileBodySchema(schema)
    if (!compiled.ok) throw new Error(compiled.error)
    expect(compiled.validate({ id: 'a', email: 'x@optiply.nl', items: [{ qty: 2 }] })).toBeNull()
    expect(compiled.validate({ email: 'nope', items: [{ qty: 0 }] })).toEqual([
      { path: '', message: "must have required property 'id'" },
      { path: '/email', message: 'must match format "email"' },
      { path: '/items/0/qty', message: 'must be >= 1' },
    ])
    expect(compiled.validate('text')).toEqual([{ path: '', message: 'must be object' }])
  })

  it('caps the errors reported', () => {
    const compiled = compileBodySchema({ type: 'array', items: { type: 'string' } })
    if (!compiled.ok) throw new Error(compiled.error)
    expect(compiled.validate(Array.from({ length: 50 }, (_, i) => i))).toHaveLength(10)
  })

  it("doesn't fetch remote references, and compiles a schema with an $id twice", () => {
    expect(compileBodySchema({ $ref: 'https://example.com/schema.json' })).toMatchObject({ ok: false })
    const withId = { $id: 'https://optiply.nl/order', type: 'object' }
    expect(compileBodySchema(withId).ok).toBe(true)
    expect(compileBodySchema(withId).ok).toBe(true)
    expect(checkBodySchema(withId)).toBeNull()
  })
})
