import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kafkaClient } from '../src/kafka/client'
import { kafkaConnector } from '../src/kafka/connector'
import { kafkaAvailable, startTestKafka, type TestKafka } from '../src/kafka/test-kafka'
import { PoolManager } from '../src/pool'
import { runQuery, testResource } from '../src/run'
import { codeEvaluator, resource } from './helpers'

// The `kafka` resource (M26 step 3a) against a throwaway Kafka 4.1 (a listener per way of signing in). Skipped
// locally without Docker; CI runs it.
const available = kafkaAvailable()
let kafka: TestKafka
const pool = new PoolManager()

beforeAll(async () => {
  if (!available) return
  kafka = await startTestKafka()
  await kafka.createTopic('orders', 2)
}, 120_000)
afterAll(async () => {
  await pool.closeAll()
  await kafka?.stop()
})

const plaintext = () => resource({ brokers: [kafka.plaintext], auth: 'none' })
const sasl = (auth: string, user: { username: string; password: string }, extra: object = {}) =>
  resource(
    { brokers: [kafka.saslSsl], auth, tls: true, username: user.username, caCertificate: kafka.ca, ...extra },
    { password: user.password },
  )
const produce = (res: ReturnType<typeof resource>, topic: string, messages: string, values = {}) =>
  runQuery(pool, kafkaConnector, res, { topic, messages }, { evaluate: codeEvaluator(values) })

describe.skipIf(!available)('kafka resource', () => {
  it('connects plaintext, with SASL PLAIN and SCRAM over TLS, and with a client certificate', async () => {
    expect(await testResource(kafkaConnector, plaintext())).toMatchObject({
      ok: true,
      message: `Kafka at ${kafka.plaintext} as no sign-in: 1 topic`,
    })
    expect(await testResource(kafkaConnector, sasl('plain', kafka.users.plain))).toMatchObject({
      ok: true,
      message: expect.stringContaining('as alice (SASL PLAIN over TLS)'),
    })
    expect(await testResource(kafkaConnector, sasl('scram-sha-256', kafka.users.scram256))).toMatchObject({
      ok: true,
      message: expect.stringContaining('as bob (SCRAM-SHA-256 over TLS)'),
    })
    expect(await testResource(kafkaConnector, sasl('scram-sha-512', kafka.users.scram512))).toMatchObject({
      ok: true,
      message: expect.stringContaining('as carol (SCRAM-SHA-512 over TLS)'),
    })
    const mtls = resource(
      {
        brokers: [kafka.mtls],
        auth: 'mtls',
        caCertificate: kafka.ca,
        clientCertificate: kafka.clientCertificate,
      },
      { clientKey: kafka.clientKey },
    )
    expect(await testResource(kafkaConnector, mtls)).toMatchObject({
      ok: true,
      message: expect.stringContaining('as client certificate CN=ow-workflows-client'),
    })
  }, 60_000)

  it('explains a wrong password and an untrusted certificate from what librdkafka logged', async () => {
    const wrong = await testResource(
      kafkaConnector,
      sasl('scram-sha-256', { username: 'bob', password: 'nope' }),
    )
    expect(wrong).toMatchObject({ ok: false, error: { code: 'connection' } })
    expect(wrong.ok ? '' : wrong.error.message).toMatch(/SASL|[Aa]uthentication/)
    expect(wrong.ok ? '' : wrong.error.message).not.toContain('nope')
    const untrusted = await testResource(
      kafkaConnector,
      sasl('plain', kafka.users.plain, { caCertificate: undefined }),
    )
    expect(untrusted).toMatchObject({ ok: false, error: { code: 'connection' } })
    expect(untrusted.ok ? '' : untrusted.error.message).toMatch(/SSL|certificate/i)
  }, 60_000)

  it('names what a sign-in lacks before connecting', async () => {
    const noKey = resource({
      brokers: [kafka.mtls],
      auth: 'mtls',
      clientCertificate: kafka.clientCertificate,
    })
    expect(await testResource(kafkaConnector, noKey)).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', message: "Add the client certificate's private key (PEM)" },
    })
    expect(
      await testResource(kafkaConnector, resource({ brokers: [kafka.saslSsl], auth: 'plain' })),
    ).toMatchObject({
      ok: false,
      error: { message: 'Add the username' },
    })
  })

  it('produces one message or many, values as JSON unless text, with keys, headers and a tombstone', async () => {
    const res = sasl('scram-sha-512', kafka.users.scram512)
    const one = await produce(
      res,
      'orders',
      '{"key": "o-{{ id }}", "value": {{ order }}, "headers": {"kind": "created"}}',
      {
        id: 7,
        order: { id: 7 },
      },
    )
    expect(one.data).toEqual([{ partition: expect.any(Number), baseOffset: expect.any(String) }])
    expect(one.metadata).toEqual({ topic: 'orders', produced: 1 })
    const many = await produce(res, 'orders', '{{ batch }}', {
      batch: [
        { key: 'a', value: 'text' },
        { key: 'a', value: 2, partition: 1 },
        { key: 'gone', value: null },
      ],
    })
    expect(many.metadata).toEqual({ topic: 'orders', produced: 3 })
  }, 60_000)

  it("refuses messages that aren't {key, value, …}", async () => {
    await expect(produce(plaintext(), 'orders', '{{ x }}', { x: [{ nope: 1 }] })).rejects.toThrow(
      'Message 1: write it as {"key": …, "value": …, "headers": {…}}',
    )
    await expect(produce(plaintext(), 'orders', '{{ x }}', { x: [] })).rejects.toThrow(
      'No messages to produce',
    )
    await expect(produce(plaintext(), 'orders', '{"value": 1, "partition": -1}')).rejects.toThrow(
      'the partition is a number from 0',
    )
  })

  it("signs in with OAUTHBEARER tokens from the client's callback, as MSK IAM does", async () => {
    const unsigned = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    let calls = 0
    const client = kafkaClient(
      {
        brokers: [kafka.saslSsl],
        auth: 'aws-msk-iam',
        tls: true,
        identity: 'key',
        region: 'eu-west-1',
        caCertificate: kafka.ca,
      },
      {},
      {
        settings: {
          oauthbearer_token_refresh_cb: async () => {
            calls++
            const now = Math.floor(Date.now() / 1000)
            return {
              tokenValue: `${unsigned({ alg: 'none' })}.${unsigned({ sub: 'dave', iat: now, exp: now + 900 })}.`,
              lifetime: (now + 900) * 1000,
              principal: 'dave',
            }
          },
        },
        who: async () => 'dave',
      },
    )
    try {
      const admin = await client.admin()
      expect(await admin.listTopics()).toContain('orders')
      expect(calls).toBeGreaterThanOrEqual(1)
    } finally {
      await client.close()
    }
  }, 60_000)
})
