import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  PoolManager,
  runQuery,
  slackConnector,
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

const bot = (token = fake.slack.token) => resource({ auth: { type: 'token' } }, { token }, token)

const run = (query: unknown, scope: Record<string, unknown> = {}, r = bot()) =>
  runQuery(pool, slackConnector, r, query, { evaluate: scopeEvaluator(scope) })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

describe('Slack resources', () => {
  it('test the connection with auth.test, and say when the token is refused', async () => {
    expect(await testResource(slackConnector, bot())).toMatchObject({
      ok: true,
      message: 'Slack: Fake Team, as ow-bot',
    })
    const wrong = await testResource(slackConnector, bot('xoxb-wrong'))
    expect(wrong).toMatchObject({ ok: false, error: { code: 'query', message: 'Slack: invalid_auth' } })
  })

  it('post a message with blocks to a channel by name, reply in its thread, edit and delete it', async () => {
    const posted = await run(
      {
        action: 'postMessage',
        channel: '#general',
        text: 'Order {{ id }} shipped',
        blocks: '[{"type": "section", "text": {"type": "mrkdwn", "text": {{ note }}}}]',
      },
      { id: 42, note: '*Done*' },
    )
    const { ts } = posted.data as { ts: string }
    expect(posted.data).toMatchObject({ channel: 'C001' })
    expect(fake.slack.messages.at(-1)).toMatchObject({
      channel: 'C001',
      text: 'Order 42 shipped',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Done*' } }],
    })
    await run({ action: 'postMessage', channel: 'C001', text: 'Reply', threadTs: ts })
    expect(fake.slack.messages.at(-1)).toMatchObject({ thread_ts: ts })

    await run({ action: 'updateMessage', channel: 'C001', ts, text: 'Edited' })
    expect(fake.slack.messages.find((m) => m.ts === ts)?.text).toBe('Edited')
    await run({ action: 'deleteMessage', channel: 'C001', ts })
    expect(fake.slack.messages.find((m) => m.ts === ts)).toBeUndefined()

    const missing = await failure(run({ action: 'postMessage', channel: '#nope', text: 'x' }))
    expect(missing.message).toBe('Slack: channel_not_found')
    const empty = await failure(run({ action: 'postMessage', channel: '#general' }))
    expect(empty.code).toBe('invalid_query')
  })

  it('list channels across pages, up to a limit', async () => {
    const all = await run({ action: 'listChannels', excludeArchived: 'false', max: '3' })
    expect((all.data as { id: string }[]).map((c) => c.id)).toEqual(['C001', 'C002', 'C003'])
    expect(all.metadata.truncated).toBe(true)

    const pages = fake.calls.length
    const unarchived = await run({ action: 'listChannels', excludeArchived: 'true' })
    expect((unarchived.data as unknown[]).length).toBe(4)
    expect(fake.calls.length - pages).toBe(1)

    const users = await run({ action: 'listUsers' })
    expect((users.data as { name: string }[]).map((u) => u.name)).toEqual(['ada', 'grace'])
    const one = await run({ action: 'lookupUserByEmail', email: 'grace@example.com' })
    expect(one.data).toMatchObject({ id: 'U002' })
  })

  it('upload a file in two steps and share it to a channel', async () => {
    const out = await run(
      {
        action: 'uploadFile',
        channel: 'C002',
        file: '{{ upload }}',
        filename: 'report.csv',
        comment: 'Here',
      },
      { upload: { base64: Buffer.from('a,b\n1,2\n').toString('base64'), contentType: 'text/csv' } },
    )
    expect(out.data).toMatchObject({ name: 'report.csv', size: 8 })
    expect(fake.slack.files.at(-1)).toMatchObject({ channel: 'C002', comment: 'Here' })
    expect(fake.slack.files.at(-1)?.bytes.toString()).toBe('a,b\n1,2\n')
  })

  it('wait out a rate limit once, and call any method', async () => {
    fake.slack.rateLimit.set('chat.postMessage', 1)
    const started = Date.now()
    await run({ action: 'postMessage', channel: 'C001', text: 'After a wait' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)

    const any = await run({ action: 'api', method: 'auth.test', args: '{}' })
    expect(any.data).toMatchObject({ ok: true, team: 'Fake Team' })
    const bad = await failure(run({ action: 'api', method: 'x/../y', args: '{}' }))
    expect(bad.code).toBe('invalid_query')
  })

  it('never return the token, and need one', async () => {
    const out = await run({ action: 'api', method: 'auth.test', args: '{}' })
    expect(JSON.stringify(out)).not.toContain(fake.slack.token)
    const none = await testResource(slackConnector, resource({ auth: { type: 'token' } }, {}, 'none'))
    expect(none).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
  })

  it('give OAuth sign-in REST’s authorization-code settings, from the Slack preset', () => {
    const config = slackConnector.configSchema.parse({ auth: { type: 'oauth', clientId: 'c1' } })
    const http = slackConnector.httpConfig!(config)
    expect(http.auth).toMatchObject({
      type: 'oauth2AuthorizationCode',
      provider: 'slack',
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      clientId: 'c1',
      scope: 'channels:read,chat:write',
    })
    expect(http.allowedHosts).toEqual(['files.slack.com'])
  })
})
