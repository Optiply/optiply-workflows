import { createHmac } from 'node:crypto'
import { workflowRuns } from '@ow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M15 step 2b: public and signed webhooks, allowed environments, the idempotency header, Slack's challenge, and
// the publish checks for the signing secret.

const PUBLIC_URL = 'https://workflows.example.com'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let prodId: string
let stagingId: string
let apiKey: string

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

const start = { name: 'startTrigger', type: 'startTrigger' }
/** Replies with what the run received. */
const echo = {
  name: 'reply',
  type: 'response',
  config: {
    status: '200',
    body: '{{ { data: startTrigger.data, headers: startTrigger.headers, env: workflowContext.environment } }}',
  },
}

async function draft(slug: string, webhook: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [start, echo],
        edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
        triggers: { webhook: { enabled: true, ...webhook } },
      },
    }),
  )
  return { id: created.id as string, revision: saved.revision as number }
}

async function publish(slug: string, webhook: object) {
  const { id, revision } = await draft(slug, webhook)
  return admin.mutate('releases.publish', { workflowId: id, draftRevision: revision })
}

async function published(slug: string, webhook: object) {
  return data(await publish(slug, webhook))
}

async function call(
  url: string,
  opts: { headers?: Record<string, string>; body?: string; method?: string } = {},
) {
  const res = await env.app.inject({
    method: (opts.method ?? 'POST') as 'POST',
    url,
    headers: { 'content-type': 'application/json', ...opts.headers },
    ...(opts.body !== undefined && { payload: opts.body }),
  })
  let json: unknown
  try {
    json = res.json()
  } catch {
    json = undefined
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return { status: res.statusCode, headers: res.headers, json: json as any }
}

async function secretVar(name: string, values: Record<string, string>, isSecret = true) {
  const created = data(await admin.mutate('configVars.create', { name, isSecret }))
  for (const [environmentId, value] of Object.entries(values)) {
    data(await admin.mutate('configVars.setValue', { configVarId: created.id, environmentId, value }))
  }
  return created.id as string
}

const runCount = async () => (await env.db.select({ id: workflowRuns.id }).from(workflowRuns)).length

const githubSign = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

beforeAll(async () => {
  env = await startTestApp({ PUBLIC_URL })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
  apiKey = data(await admin.mutate('apiKeys.create', { name: 'test' })).key
})
afterAll(() => env?.stop())

describe('public webhooks', () => {
  it('run without a key, in the default environment only unless they list others', async () => {
    await published('public-hook', { auth: { type: 'public' } })
    const ok = await call('/api/v1/workflows/public-hook/webhook', { body: '{"a":1}' })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ data: { a: 1 }, env: 'production' })

    const staging = await call('/api/v1/workflows/public-hook/webhook?environment=staging', { body: '{}' })
    expect(staging).toMatchObject({
      status: 403,
      json: { error: { message: "This webhook doesn't run in Staging" } },
    })

    await published('public-staging', { auth: { type: 'public' }, environments: ['staging'] })
    const listed = await call('/api/v1/workflows/public-staging/webhook', { body: '{}' })
    expect(listed.json).toMatchObject({ env: 'staging' })
    expect(
      (await call('/api/v1/workflows/public-staging/webhook?environment=production', { body: '{}' })).status,
    ).toBe(403)
  })

  it("keep any API key the caller sends out of the run's headers", async () => {
    const res = await call('/api/v1/workflows/public-hook/webhook', {
      body: '{}',
      headers: { 'x-api-key': 'ow_whatever', 'x-other': 'kept' },
    })
    expect(res.json.headers['x-api-key']).toBeUndefined()
    expect(res.json.headers['x-other']).toBe('kept')
  })
})

describe('signed webhooks', () => {
  beforeAll(async () => {
    await secretVar('GITHUB_SECRET', { [prodId]: 'old-secret\nnew-secret', [stagingId]: 'staging-secret' })
  })

  it('run when the signature matches, and refuse otherwise without starting a run', async () => {
    await published('signed-hook', {
      auth: { type: 'signature', preset: 'github', secret: 'GITHUB_SECRET' },
      environments: ['production', 'staging'],
    })
    const body = '{"action":"opened"}'
    const url = '/api/v1/workflows/signed-hook/webhook'
    const ok = await call(url, { body, headers: { 'x-hub-signature-256': githubSign('new-secret', body) } })
    expect(ok.status).toBe(200)
    expect(ok.json.data).toEqual({ action: 'opened' })
    // The signature header reaches the run like any header.
    expect(ok.json.headers['x-hub-signature-256']).toBe(githubSign('new-secret', body))

    const staging = await call(`${url}?environment=staging`, {
      body,
      headers: { 'x-hub-signature-256': githubSign('staging-secret', body) },
    })
    expect(staging.json).toMatchObject({ env: 'staging' })

    const before = await runCount()
    for (const headers of [
      {},
      { 'x-hub-signature-256': githubSign('wrong', body) },
      { 'x-hub-signature-256': githubSign('staging-secret', body) },
      { 'x-api-key': apiKey },
    ] as Record<string, string>[]) {
      const refused = await call(url, { body, headers })
      expect(refused).toMatchObject({
        status: 401,
        json: { error: { code: 'unauthorized', message: "The request's signature couldn't be verified" } },
      })
    }
    // A body changed after signing.
    const tampered = await call(url, {
      body: '{"action":"closed"}',
      headers: { 'x-hub-signature-256': githubSign('new-secret', body) },
    })
    expect(tampered.status).toBe(401)
    expect(await runCount()).toBe(before)
  })

  it("replay the earlier run on a provider's redelivery", async () => {
    const body = '{"n":1}'
    const headers = {
      'x-hub-signature-256': githubSign('new-secret', body),
      'x-github-delivery': 'delivery-1',
    }
    const first = await call('/api/v1/workflows/signed-hook/webhook', { body, headers })
    const again = await call('/api/v1/workflows/signed-hook/webhook', { body, headers })
    expect(again.headers['x-run-id']).toBe(first.headers['x-run-id'])
    expect(again.headers['idempotent-replayed']).toBe('true')
  })

  it('verify HubSpot against the public URL, query string included', async () => {
    await secretVar('HUBSPOT_SECRET', { [prodId]: 'hs-secret' })
    await published('hubspot-hook', {
      auth: { type: 'signature', preset: 'hubspot', secret: 'HUBSPOT_SECRET' },
    })
    const body = '[{"objectId":1}]'
    const path = '/api/v1/workflows/hubspot-hook/webhook?portal=42'
    const timestamp = String(Date.now())
    const signature = createHmac('sha256', 'hs-secret')
      .update(`POST${PUBLIC_URL}${path}${body}${timestamp}`)
      .digest('base64')
    const res = await call(path, {
      body,
      headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
    })
    expect(res.status).toBe(200)
  })

  it("answer Slack's URL check without a run", async () => {
    await secretVar('SLACK_SECRET', { [prodId]: 'slack-secret' })
    await published('slack-hook', { auth: { type: 'signature', preset: 'slack', secret: 'SLACK_SECRET' } })
    const body =
      '{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"}'
    const ts = String(Math.floor(Date.now() / 1000))
    const signature = `v0=${createHmac('sha256', 'slack-secret').update(`v0:${ts}:${body}`).digest('hex')}`
    const before = await runCount()
    const res = await call('/api/v1/workflows/slack-hook/webhook', {
      body,
      headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': ts },
    })
    expect(res).toMatchObject({
      status: 200,
      json: { challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' },
    })
    expect(await runCount()).toBe(before)
  })
})

describe('publishing a signed webhook', () => {
  const github = (secret: string) => ({ auth: { type: 'signature', preset: 'github', secret } })

  it('needs the secret config var to exist, be secret and have a value where the webhook runs', async () => {
    const message = async (slug: string, webhook: object) =>
      (await publish(slug, webhook)).body.error?.message
    expect(await message('pub-missing', github('NOPE'))).toBe(
      'The webhook\'s signing secret is config var "NOPE", which doesn\'t exist',
    )
    await secretVar('PLAIN_VAR', { [prodId]: 'x' }, false)
    expect(await message('pub-plain', github('PLAIN_VAR'))).toBe(
      'Config var "PLAIN_VAR" isn\'t secret: make it a secret to sign webhooks with it',
    )
    await secretVar('PROD_ONLY', { [prodId]: 'x' })
    expect(
      await message('pub-prod-only', { ...github('PROD_ONLY'), environments: ['production', 'staging'] }),
    ).toBe('Config var "PROD_ONLY" has no value in Staging, where the webhook runs')
    // The default environment only (the default for signed webhooks): enough.
    expect((await publish('pub-default', github('PROD_ONLY'))).status).toBe(200)
  })

  it('needs the listed environments to exist', async () => {
    const res = await publish('pub-env', { auth: { type: 'public' }, environments: ['production', 'qa'] })
    expect(res.body.error?.message).toBe('The webhook runs in environment "qa", which doesn\'t exist')
  })
})

describe('API-key webhooks', () => {
  it('still need a key, and honour their listed environments', async () => {
    await published('keyed-hook', { environments: ['staging'] })
    expect((await call('/api/v1/workflows/keyed-hook/webhook', { body: '{}' })).status).toBe(401)
    const ok = await call('/api/v1/workflows/keyed-hook/webhook', {
      body: '{}',
      headers: { 'x-api-key': apiKey },
    })
    expect(ok.json).toMatchObject({ env: 'staging' })
    expect(ok.json.headers['x-api-key']).toBeUndefined()
  })
})

describe('review fixes (session 18)', () => {
  it("doesn't tell a caller without a key which URLs, methods or environments exist", async () => {
    await published('keyed-quiet', {})
    const without = async (url: string, method = 'POST') => (await call(url, { body: '{}', method })).json
    const unauthorized = {
      error: { code: 'unauthorized', message: 'Send an API key in the X-Api-Key header' },
    }
    expect(await without('/api/v1/workflows/no-such-workflow/webhook')).toEqual(unauthorized)
    expect(await without('/api/v1/hooks/no/such/alias')).toEqual(unauthorized)
    expect(await without('/api/v1/workflows/keyed-quiet/webhook', 'GET')).toEqual(unauthorized)
    expect(await without('/api/v1/workflows/keyed-quiet/webhook?environment=nowhere')).toEqual(unauthorized)
    // With a valid key, the real answers.
    const withKey = (url: string, method = 'POST') =>
      call(url, { body: '{}', method, headers: { 'x-api-key': apiKey } })
    expect((await withKey('/api/v1/workflows/no-such-workflow/webhook')).status).toBe(404)
    expect((await withKey('/api/v1/workflows/keyed-quiet/webhook', 'GET')).status).toBe(405)
    expect((await withKey('/api/v1/workflows/keyed-quiet/webhook?environment=nowhere')).status).toBe(404)
  })

  it("counts only authenticated calls toward a signed webhook's limit", async () => {
    await published('signed-limited', {
      auth: { type: 'signature', preset: 'github', secret: 'GITHUB_SECRET' },
      rateLimit: { requests: 2, windowSeconds: 3600 },
    })
    const url = '/api/v1/workflows/signed-limited/webhook'
    for (let i = 0; i < 10; i++) expect((await call(url, { body: '{}' })).status).toBe(401)
    const signed = []
    for (let i = 0; i < 3; i++) {
      signed.push(
        (await call(url, { body: '{}', headers: { 'x-hub-signature-256': githubSign('new-secret', '{}') } }))
          .status,
      )
    }
    expect(signed).toEqual([200, 200, 429])
  })

  it("ignores idempotency keys on public webhooks: a caller can't read another's run", async () => {
    const send = () =>
      call('/api/v1/workflows/public-hook/webhook', {
        body: '{}',
        headers: { 'idempotency-key': 'order-42' },
      })
    const first = await send()
    const second = await send()
    expect(second.headers['x-run-id']).not.toBe(first.headers['x-run-id'])
    expect(second.headers['idempotent-replayed']).toBeUndefined()
  })

  it('keeps every API key the caller sent out of the run, and other Authorization headers in', async () => {
    const both = await call('/api/v1/workflows/public-hook/webhook', {
      body: '{}',
      headers: { 'x-api-key': 'ow_first', authorization: 'Bearer ow_second' },
    })
    expect(both.json.headers['x-api-key']).toBeUndefined()
    expect(both.json.headers.authorization).toBeUndefined()
    const basic = await call('/api/v1/workflows/public-hook/webhook', {
      body: '{}',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(basic.json.headers.authorization).toBe('Basic dXNlcjpwYXNz')
  })
})

describe('SNS webhooks (M30)', () => {
  let aws: Awaited<ReturnType<typeof import('@ow/connectors/testing').startFakeAws>>
  let topic: string
  let other: string
  beforeAll(async () => {
    const { startFakeAws } = await import('@ow/connectors/testing')
    const { configureSnsWebhooks } = await import('../src/services/sns-webhook')
    aws = await startFakeAws()
    topic = aws.sns.createTopic('orders')
    other = aws.sns.createTopic('someone-elses')
    // The fake's certificate host is trusted as AWS's would be (SNS_CERT_HOSTS, tests only).
    configureSnsWebhooks(new URL(aws.url).host)
  })
  afterAll(async () => {
    const { configureSnsWebhooks } = await import('../src/services/sns-webhook')
    configureSnsWebhooks('')
    await aws?.close()
  })

  const post = (envelope: Record<string, string>) =>
    call('/api/v1/workflows/sns-hook/webhook', {
      body: JSON.stringify(envelope),
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'x-amz-sns-message-type': envelope.Type!,
        'x-amz-sns-message-id': envelope.MessageId!,
      },
    })

  it('needs the topics listed, and no secret', async () => {
    const refused = await publish('sns-hook-none', { auth: { type: 'signature', preset: 'sns', secret: '' } })
    expect(refused.body.error?.message).toMatch(/List the SNS topics/)
  })

  it('confirms a subscription, runs a notification with its message, and refuses forgeries and other topics', async () => {
    await published('sns-hook', {
      auth: { type: 'signature', preset: 'sns', secret: '', topicArns: [topic] },
    })
    const before = await runCount()
    const confirm = aws.sns.envelope('SubscriptionConfirmation', topic, 'You have chosen to subscribe…')
    expect(await post(confirm)).toMatchObject({ status: 200, json: { confirmed: true, topicArn: topic } })
    // The SubscribeURL was fetched: the fake marks the subscription confirmed.
    expect(aws.sns.confirmed(topic, '')).toBe(true)
    expect(await runCount()).toBe(before)

    const note = aws.sns.envelope('Notification', topic, '{"order": 42}', { subject: 'New order' })
    const ok = await post(note)
    expect(ok.status).toBe(200)
    expect(ok.json.data).toMatchObject({
      message: { order: 42 },
      subject: 'New order',
      messageId: note.MessageId,
      topicArn: topic,
    })
    // SignatureVersion 1 (SHA1) too.
    expect(
      (await post(aws.sns.envelope('Notification', topic, 'plain text', { signatureVersion: '1' }))).json
        .data,
    ).toMatchObject({ message: 'plain text' })

    for (const bad of [
      { ...note, Message: '{"order": 43}' },
      { ...note, SigningCertURL: 'https://evil.example.com/cert.pem' },
      aws.sns.envelope('Notification', other, '{"order": 1}'),
    ]) {
      expect(await post(bad)).toMatchObject({ status: 401, json: { error: { code: 'unauthorized' } } })
    }
    expect(await runCount()).toBe(before + 2)
  })
})
