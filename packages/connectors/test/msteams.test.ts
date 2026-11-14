import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  msteamsConnector,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// Microsoft Teams (M37, docs/architecture.md §2.41): Graph with Microsoft sign-in, and a Workflows webhook, against
// the fake.

let fake: FakeServices
let pool: PoolManager
const TOKEN = 'eyJ.fake-teams-token'

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

const graph = () =>
  resource(
    { auth: { type: 'oauth', clientId: 'app-1', tenant: 'optiply.nl' } },
    { clientSecret: 's' },
    'graph',
  )
const hook = (url = `${fake.urls.teamsWebhook}flow-1`) =>
  resource({ auth: { type: 'webhook' } }, { webhookUrl: url }, `hook-${url}`)

const parsed = (r: ReturnType<typeof resource>) => ({
  ...r,
  config: msteamsConnector.configSchema.parse(r.config),
  secrets: msteamsConnector.secretsSchema.parse(r.secrets),
})

const run = (query: Record<string, string>, r = graph(), scope: Record<string, unknown> = {}) =>
  runQuery(pool, msteamsConnector, parsed(r), query, {
    evaluate: scopeEvaluator(scope),
    credentials: { accessToken: async () => TOKEN },
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

const general = () => fake.teams.teams[0]!.channels[0]!

describe('Graph (Microsoft sign-in)', () => {
  it('signs in at the tenant’s endpoints with Teams’ delegated scopes', () => {
    const config = msteamsConnector.httpConfig!(parsed(graph()).config)
    expect(config.auth).toMatchObject({
      type: 'oauth2AuthorizationCode',
      provider: 'microsoft',
      authorizeUrl: 'https://login.microsoftonline.com/optiply.nl/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/optiply.nl/oauth2/v2.0/token',
      scope: expect.stringContaining('ChannelMessage.Send'),
    })
    expect(() =>
      msteamsConnector.configSchema.parse({ auth: { type: 'oauth', tenant: 'evil/../x' } }),
    ).toThrow()
  })

  it('lists teams and channels, and tests the connection', async () => {
    expect((await run({ action: 'listTeams' })).data).toEqual([{ id: 'team-ops', displayName: 'Operations' }])
    const channels = await run({ action: 'listChannels', teamId: 'team-ops' })
    expect((channels.data as { displayName: string }[]).map((c) => c.displayName)).toEqual([
      'General',
      'Alerts',
    ])
    expect(
      await testResource(msteamsConnector, parsed(graph()), {
        credentials: { accessToken: async () => TOKEN },
      }),
    ).toMatchObject({
      ok: true,
      message: 'Teams: Ada Lovelace, in 1 team',
    })
  })

  it('posts to a channel with a mention and a card, then replies in the thread', async () => {
    const posted = await run(
      {
        action: 'postChannelMessage',
        teamId: 'team-ops',
        channelId: '19:general@thread.tacv2',
        text: 'Stock is low for {{ sku }} <check>',
        mentions: 'bob@optiply.nl',
        card: '{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"{{ sku }}"}]}',
        importance: 'high',
      },
      graph(),
      { sku: 'LAMP-3' },
    )
    const message = general().messages.at(-1)!
    expect(posted.data).toMatchObject({ id: message.id })
    expect(message.body).toEqual({
      contentType: 'html',
      content:
        '<at id="0">Bob Builder</at> Stock is low for LAMP-3 &lt;check&gt;<attachment id="card"></attachment>',
    })
    expect(message.mentions).toEqual([
      {
        id: 0,
        mentionText: 'Bob Builder',
        mentioned: { user: { id: 'u-bob', displayName: 'Bob Builder', userIdentityType: 'aadUser' } },
      },
    ])
    expect(message.attachments).toEqual([
      {
        id: 'card',
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: '{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"LAMP-3"}]}',
      },
    ])
    expect(message.importance).toBe('high')
    await run({
      action: 'replyToMessage',
      teamId: 'team-ops',
      channelId: '19:general@thread.tacv2',
      messageId: message.id,
      text: 'Ordered.',
    })
    expect(message.replies.map((r) => r.body)).toEqual([{ contentType: 'text', content: 'Ordered.' }])
  })

  it('pages channel messages through @odata.nextLink up to the limit', async () => {
    for (let i = 0; i < 120; i++)
      general().messages.push({
        id: `bulk${i}`,
        body: { contentType: 'text', content: `n${i}` },
        from: 'u-bob',
        replies: [],
      })
    const some = await run({
      action: 'listChannelMessages',
      teamId: 'team-ops',
      channelId: '19:general@thread.tacv2',
      max: '70',
    })
    expect(some.data).toHaveLength(70)
    expect(some.metadata).toMatchObject({ truncated: true })
    expect(
      fake.calls.filter((c) => c.path.includes('/messages') && c.method === 'GET').at(-1)!.path,
    ).toContain('%24skip=50')
  })

  it('messages a person in their one-on-one chat (made once), and lists chats and members', async () => {
    const first = await run({ action: 'postChatMessage', user: 'bob@optiply.nl', text: 'Hi Bob' })
    const again = await run({ action: 'postChatMessage', user: 'bob@optiply.nl', text: 'Again' })
    expect(first.metadata.chatId).toBe(again.metadata.chatId)
    expect(fake.teams.chats).toHaveLength(1)
    expect(fake.teams.chats[0]!.messages.map((m) => m.body.content)).toEqual(['Hi Bob', 'Again'])
    expect((await run({ action: 'listChats' })).data).toHaveLength(1)
    const members = await run({ action: 'listMembers', chatId: String(first.metadata.chatId) })
    expect(members.data).toEqual([{ userId: 'u-ada' }, { userId: 'u-bob' }])
    expect((await failure(run({ action: 'postChatMessage', text: 'x' }))).message).toContain(
      'chat id or a person',
    )
  })

  it('says what Graph refused, with its request id; any call through api', async () => {
    const missing = await failure(run({ action: 'listChannels', teamId: 'team-nope' }))
    expect(missing.message).toBe('Teams: No team found with Group Id')
    expect(missing.details).toMatchObject({
      status: 404,
      reason: 'NotFound',
      requestId: expect.stringMatching(/^req-/),
    })
    expect((await run({ action: 'api', method: 'GET', path: '/me' })).data).toMatchObject({
      displayName: 'Ada Lovelace',
    })
    expect((await failure(run({ action: 'postWebhook', text: 'x' }))).message).toContain(
      'use "Post to a channel"',
    )
  })
})

describe('a Workflows webhook', () => {
  it('posts text as an Adaptive Card, or a card as given; nothing else', async () => {
    expect((await run({ action: 'postWebhook', text: 'Deploy **done**' }, hook())).data).toEqual({
      status: 202,
    })
    expect(fake.teams.webhooks.at(-1)!.body).toEqual({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            body: [{ type: 'TextBlock', text: 'Deploy **done**', wrap: true }],
          },
        },
      ],
    })
    await run({ action: 'postWebhook', card: '{"type":"AdaptiveCard","body":[]}' }, hook())
    expect(
      (fake.teams.webhooks.at(-1)!.body as { attachments: { content: unknown }[] }).attachments[0]!.content,
    ).toEqual({
      type: 'AdaptiveCard',
      body: [],
    })
    expect((await failure(run({ action: 'listTeams' }, hook()))).message).toContain('posts through a webhook')
    expect(await testResource(msteamsConnector, parsed(hook()))).toMatchObject({
      ok: true,
      message: expect.stringContaining('nothing is sent'),
    })
  })

  it('takes only Teams’ webhook hosts', async () => {
    const wrong = await failure(run({ action: 'postWebhook', text: 'x' }, hook('https://example.com/hook')))
    expect(wrong.message).toContain("isn't a Teams Workflows webhook URL")
    expect(msteamsConnector.secretsSchema.safeParse({ webhookUrl: 'not a url' }).success).toBe(false)
    const unknown = await failure(
      run({ action: 'postWebhook', text: 'x' }, hook(`${fake.urls.teamsWebhook}flow-2`)),
    )
    expect(unknown.message).toContain('answered 404')
  })
})
