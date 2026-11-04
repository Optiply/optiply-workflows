import { createHmac } from 'node:crypto'
import { generateKey, parseKeyring } from '@ow/crypto'
import { configVars, configVarValues, createDb, type Db, environments } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import type { WebhookSignatureAuth } from '@ow/definition'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptForRow } from '../src/services/secrets'
import {
  readSigningSecrets,
  type SignedRequest,
  verifyWebhookSignature,
} from '../src/services/webhook-signatures'

const request = (
  body: string,
  headers: Record<string, string>,
  extra: Partial<SignedRequest> = {},
): SignedRequest => ({
  method: 'POST',
  url: 'https://workflows.optiply.nl/api/v1/hooks/test',
  headers,
  body: Buffer.from(body),
  ...extra,
})

const preset = (
  name: WebhookSignatureAuth['preset'],
  more: Partial<WebhookSignatureAuth> = {},
): WebhookSignatureAuth => ({
  type: 'signature',
  preset: name,
  secret: 'SECRET',
  ...more,
})

describe('verifyWebhookSignature: provider examples', () => {
  // GitHub's documented example ("Validating webhook deliveries").
  it('verifies GitHub', () => {
    const req = request('Hello, World!', {
      'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    })
    expect(verifyWebhookSignature(preset('github'), ["It's a Secret to Everybody"], req)).toEqual({
      ok: true,
    })
    expect(verifyWebhookSignature(preset('github'), ['another secret'], req)).toMatchObject({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  // Slack's documented example ("Verifying requests from Slack"), at its own clock.
  it('verifies Slack', () => {
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'
    const req = request(body, {
      'x-slack-request-timestamp': '1531420618',
      'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    })
    const secrets = ['8f742231b10e8888abcd99yyyzzz85a5']
    expect(verifyWebhookSignature(preset('slack'), secrets, req, 1531420618_000 + 60_000)).toEqual({
      ok: true,
    })
    expect(verifyWebhookSignature(preset('slack'), secrets, req, 1531420618_000 + 301_000)).toMatchObject({
      ok: false,
      reason: 'expired_timestamp',
    })
  })
})

// Stripe, Shopify and HubSpot document the scheme but no fixed example: these signatures were computed with
// `openssl dgst -hmac` (session 18), an implementation independent of ours.
describe('verifyWebhookSignature: schemes checked against openssl', () => {
  const t = 1729500000

  it('verifies Stripe, with any of several v1 signatures and its tolerance', () => {
    const body = '{"id":"evt_1","type":"invoice.paid"}'
    const good = '4eb2f59cff40f6b43a3cb81268a9bde076607d7d8401fd5c48f256c15f971b3d'
    const check = (header: string, now = t * 1000, more = {}) =>
      verifyWebhookSignature(
        preset('stripe', more),
        ['whsec_test_secret'],
        request(body, { 'stripe-signature': header }),
        now,
      )
    expect(check(`t=${t},v1=${good}`)).toEqual({ ok: true })
    expect(check(`t=${t}, v1=${'0'.repeat(64)}, v1=${good}, v0=abc`)).toEqual({ ok: true })
    expect(check(`t=${t},v0=${good}`)).toMatchObject({ reason: 'malformed_signature' })
    expect(check(`v1=${good}`)).toMatchObject({ reason: 'missing_timestamp' })
    expect(check(`t=${t + 1},v1=${good}`)).toMatchObject({ reason: 'signature_mismatch' })
    expect(check(`t=${t},v1=${good}`, (t + 301) * 1000)).toMatchObject({ reason: 'expired_timestamp' })
    expect(check(`t=${t},v1=${good}`, (t - 301) * 1000)).toMatchObject({ reason: 'expired_timestamp' })
    expect(check(`t=${t},v1=${good}`, (t + 500) * 1000, { toleranceSeconds: 600 })).toEqual({ ok: true })
  })

  it('verifies Shopify', () => {
    const req = request('{"id":820982911946154508,"email":"jon@example.com"}', {
      'x-shopify-hmac-sha256': 'vo+n5h/cLxNKGlgJ0Fd1aDzU0aOaajK8Hs9m0hPqWiQ=',
    })
    expect(verifyWebhookSignature(preset('shopify'), ['shpss_secret'], req)).toEqual({ ok: true })
  })

  it('verifies HubSpot v3, decoding the escapes HubSpot decodes in the URI', () => {
    const req = request(
      '[{"objectId":1}]',
      {
        'x-hubspot-signature-v3': '31t68bgSAvhH+C+x19vOHhYcaDV+nQ/t/AcmCw2e08A=',
        'x-hubspot-request-timestamp': '1729500000123',
      },
      { url: 'https://workflows.optiply.nl/api/v1/hooks/hubspot/contacts?portal=1&q=a%3Ab' },
    )
    expect(verifyWebhookSignature(preset('hubspot'), ['hs-client-secret'], req, 1729500000_123)).toEqual({
      ok: true,
    })
    expect(
      verifyWebhookSignature(preset('hubspot'), ['hs-client-secret'], req, 1729500400_000),
    ).toMatchObject({
      reason: 'expired_timestamp',
    })
  })

  it('verifies a custom scheme (sha512, base64, a prefix, the method and a timestamp)', () => {
    const auth = preset('custom', {
      header: 'X-Signature',
      algorithm: 'sha512',
      encoding: 'base64',
      prefix: 'sig=',
      timestampHeader: 'X-Timestamp',
      signedPayload: '{timestamp}|{method}|{body}',
    })
    const signature =
      'EfI/jaGs49fIDZbIKpyYT5yQ6lL6p/m9sr04Pfc+m1TbHoESeY8TkVivgikEDlR6ISK7VM7fwFcjvWpw7tMbRQ=='
    const req = (sig: string, method = 'PUT') =>
      request('{"a":1}', { 'x-signature': `sig=${sig}`, 'x-timestamp': String(t) }, { method })
    expect(verifyWebhookSignature(auth, ['custom-secret'], req(signature), t * 1000)).toEqual({ ok: true })
    expect(verifyWebhookSignature(auth, ['custom-secret'], req(signature, 'POST'), t * 1000)).toMatchObject({
      reason: 'signature_mismatch',
    })
    expect(verifyWebhookSignature(auth, ['custom-secret'], req('not base64!'), t * 1000)).toMatchObject({
      reason: 'malformed_signature',
    })
  })
})

describe('verifyWebhookSignature: edge cases', () => {
  const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')

  it('refuses a missing header, a missing prefix and a truncated signature', () => {
    const body = '{}'
    const good = sign('s', body)
    const check = (headers: Record<string, string>) =>
      verifyWebhookSignature(preset('github'), ['s'], request(body, headers))
    expect(check({})).toMatchObject({
      reason: 'missing_signature',
      message: 'The x-hub-signature-256 header is missing',
    })
    expect(check({ 'x-hub-signature-256': good })).toMatchObject({ reason: 'malformed_signature' })
    expect(check({ 'x-hub-signature-256': `sha256=${good.slice(0, 32)}` })).toMatchObject({
      reason: 'signature_mismatch',
    })
  })

  it('accepts any of several secrets (a rotation)', () => {
    const req = request('{"x":1}', { 'x-hub-signature-256': `sha256=${sign('new', '{"x":1}')}` })
    expect(verifyWebhookSignature(preset('github'), ['old', 'new'], req)).toEqual({ ok: true })
    expect(verifyWebhookSignature(preset('github'), ['old'], req)).toMatchObject({
      reason: 'signature_mismatch',
    })
  })

  it('signs the body as bytes, not as decoded text', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    const sig = createHmac('sha256', 's').update(bytes).digest('hex')
    const req: SignedRequest = { ...request('', { 'x-hub-signature-256': `sha256=${sig}` }), body: bytes }
    expect(verifyWebhookSignature(preset('github'), ['s'], req)).toEqual({ ok: true })
  })

  it('signs the timestamp as sent, and refuses one that is not a number', () => {
    const auth = preset('custom', {
      header: 'x-sig',
      timestampHeader: 'x-ts',
      signedPayload: '{timestamp}.{body}',
    })
    const now = 1729500000_000
    const req = (ts: string) =>
      request('b', { 'x-sig': createHmac('sha256', 's').update(`${ts}.b`).digest('hex'), 'x-ts': ts })
    expect(verifyWebhookSignature(auth, ['s'], req('01729500000'), now)).toEqual({ ok: true })
    expect(verifyWebhookSignature(auth, ['s'], req('1729500000.5'), now)).toMatchObject({
      reason: 'missing_timestamp',
    })
  })
})

describe('readSigningSecrets', () => {
  const keyring = parseKeyring(`v1:${generateKey()}`)
  let db: Db
  let stop: () => Promise<void>
  let prodId: string
  let stagingId: string

  beforeAll(async () => {
    const pg = await startTestDatabase()
    const conn = createDb(pg.url, { max: 2 })
    db = conn.db
    stop = async () => {
      await conn.close()
      await pg.stop()
    }
    const envs = await db.select().from(environments)
    prodId = envs.find((e) => e.slug === 'production')!.id
    stagingId = envs.find((e) => e.slug === 'staging')!.id
  })
  afterAll(() => stop?.())

  async function setVar(name: string, isSecret: boolean, values: Record<string, string>) {
    const [v] = await db.insert(configVars).values({ name, isSecret }).returning()
    for (const [environmentId, value] of Object.entries(values)) {
      const row = { id: uuidv7(), environmentId }
      await db.insert(configVarValues).values({
        ...row,
        configVarId: v!.id,
        ...(isSecret
          ? { valueEncrypted: encryptForRow(keyring, 'config_var_values', row, value) }
          : { value }),
      })
    }
  }

  it("reads one environment's secrets, one per line", async () => {
    await setVar('STRIPE_SECRET', true, { [prodId]: 'whsec_new\n  whsec_old  \n\n' })
    expect(await readSigningSecrets(db, keyring, 'STRIPE_SECRET', prodId)).toEqual(['whsec_new', 'whsec_old'])
    expect(await readSigningSecrets(db, keyring, 'STRIPE_SECRET', stagingId)).toBeNull()
  })

  it("gives null for a var that doesn't exist, isn't secret or is blank", async () => {
    await setVar('PLAIN', false, { [prodId]: 'visible' })
    await setVar('BLANK', true, { [prodId]: '  \n' })
    expect(await readSigningSecrets(db, keyring, 'MISSING', prodId)).toBeNull()
    expect(await readSigningSecrets(db, keyring, 'PLAIN', prodId)).toBeNull()
    expect(await readSigningSecrets(db, keyring, 'BLANK', prodId)).toBeNull()
  })
})
