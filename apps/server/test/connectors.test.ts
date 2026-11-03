import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type FakeServices,
  startFakeServices,
  startTestGraphql,
  type TestGraphql,
} from '@ow/connectors/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureGoogle } from '../src/services/google'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M27's resource types through the API: settings checked on save, queries from the playground, what the editors read.

let env: TestEnv
let gql: TestGraphql
let fake: FakeServices
let memberId: string
let adminCookie: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let prodId: string
const seen: string[] = []

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

async function resourceOf(type: string, slug: string, config: unknown, secrets: unknown) {
  const created = data(await admin.mutate('resources.create', { type, name: slug, slug }))
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: created.id,
      environmentId: prodId,
      config,
      secrets,
    }),
  )
  return created.id as string
}

beforeAll(async () => {
  gql = await startTestGraphql({ token: 'Gql-Secret-7731' })
  fake = await startFakeServices({
    slackToken: 'xoxb-Slack-Secret-1',
    hubspotToken: 'pat-Hub-Secret-2',
    sendgridKey: 'SG.Grid-Secret-3',
  })
  env = await startTestApp({
    SLACK_API_URL: fake.urls.slack,
    HUBSPOT_API_URL: fake.urls.hubspot,
    SENDGRID_API_URL: fake.urls.sendgrid,
    SENDGRID_EU_API_URL: fake.urls.sendgridEu,
    GOOGLE_SHEETS_API_URL: fake.urls.sheets,
    GOOGLE_DRIVE_API_URL: fake.urls.drive,
    GOOGLE_TOKEN_URL: fake.urls.googleToken,
    STRIPE_API_URL: fake.urls.stripe,
    AIRTABLE_API_URL: fake.urls.airtable,
    NOTION_API_URL: fake.urls.notion,
  })
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  memberId = (await createLocalUser(env.db, 'member@example.com')).id
  adminCookie = await login(env.app, 'admin@example.com')
  admin = trpc(env.app, adminCookie, { record: seen })
  member = trpc(env.app, await login(env.app, 'member@example.com'))
  prodId = data(await admin.query('environments.list')).find(
    (e: { slug: string }) => e.slug === 'production',
  ).id
})

afterAll(async () => {
  await env?.stop()
  await gql?.stop()
  await fake?.stop()
})

const run = async (resourceId: string, query: unknown, scope: Record<string, unknown> = {}) =>
  data(await admin.mutate('resources.run', { resourceId, environmentId: prodId, query, scope }))

describe('GraphQL resources', () => {
  let id: string

  it('run queries from the playground and hand the editor the schema, to those with Use', async () => {
    id = await resourceOf(
      'graphql',
      'shop_gql',
      { baseUrl: gql.url, allowPrivateNetwork: true, auth: { type: 'bearer' } },
      { bearerToken: gql.token },
    )
    const ran = data(
      await admin.mutate('resources.run', {
        resourceId: id,
        environmentId: prodId,
        query: {
          query: 'query($c: String) { orders(customer: $c) { id amount } }',
          variables: '{"c": {{ who }}}',
        },
        scope: { who: 'acme' },
      }),
    )
    expect(ran).toMatchObject({ ok: true, data: { orders: [{ id: '1', amount: 1200 }] } })

    const failed = data(
      await admin.mutate('resources.run', {
        resourceId: id,
        environmentId: prodId,
        query: { query: '{ order(id: "13") { id risk } }' },
      }),
    )
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'query', message: 'Risk service unavailable (at order.risk)' },
    })

    const schema = data(
      await admin.query('resources.graphqlSchema', { resourceId: id, environmentId: prodId }),
    )
    expect(schema.ok).toBe(true)
    expect(schema.schema.__schema.queryType).toMatchObject({ name: 'Query' })
    // Cached: a second read doesn't ask the endpoint again.
    const before = gql.requests.length
    data(await admin.query('resources.graphqlSchema', { resourceId: id, environmentId: prodId }))
    expect(gql.requests.length).toBe(before)

    const refused = await member.query('resources.graphqlSchema', { resourceId: id, environmentId: prodId })
    expect(refused.status).toBeGreaterThanOrEqual(400)
  })

  it('answer a schema the endpoint won’t give as an error, and test the connection', async () => {
    const tested = data(await admin.mutate('resources.test', { resourceId: id, environmentId: prodId }))
    expect(tested).toMatchObject({ ok: true, message: 'GraphQL, 10 types' })
    gql.setIntrospection(false)
    try {
      const off = data(
        await admin.query('resources.graphqlSchema', {
          resourceId: id,
          environmentId: prodId,
          refresh: true,
        }),
      )
      expect(off).toMatchObject({ ok: false, error: { code: 'query' } })
    } finally {
      gql.setIntrospection(true)
    }
  })
})

describe('the types offered', () => {
  it('are grouped for the picker, without the built-in REST API, which nobody creates', async () => {
    const types = data(await admin.query('resources.types'))
    expect(types.find((t: { type: string }) => t.type === 'restapi')).toBeUndefined()
    expect(types).toEqual(
      expect.arrayContaining([
        { type: 'graphql', label: 'GraphQL', group: 'APIs' },
        { type: 'slack', label: 'Slack', group: 'Services' },
        { type: 'googlesheets', label: 'Google Sheets', group: 'Services' },
        { type: 'kafka', label: expect.any(String), group: 'Messaging' },
      ]),
    )
    const refused = await admin.mutate('resources.create', { type: 'restapi', name: 'Mine', slug: 'my_api' })
    expect(refused.body.error?.message).toBe('The REST API resource is built in: use rest_api')
  })
})

describe('service resources', () => {
  it('Slack: check the token is there on save, post a message, and connect accounts through OAuth', async () => {
    const created = data(
      await admin.mutate('resources.create', { type: 'slack', name: 'Slack', slug: 'slack' }),
    )
    const missing = await admin.mutate('resources.saveConfig', {
      resourceId: created.id,
      environmentId: prodId,
      config: { auth: { type: 'token' } },
      secrets: {},
    })
    expect(missing.body.error?.message).toContain('Add the token')
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: created.id,
        environmentId: prodId,
        config: { auth: { type: 'token' } },
        secrets: { token: fake.slack.token },
      }),
    )
    const posted = await run(
      created.id,
      { action: 'postMessage', channel: '#general', text: 'Hi {{ who }}' },
      { who: 'all' },
    )
    expect(posted).toMatchObject({ ok: true, data: { channel: 'C001' } })
    expect(fake.slack.messages.at(-1)?.text).toBe('Hi all')

    // OAuth: M9's connect flow starts at Slack's consent screen with the app's client id and scopes.
    const oauth = data(
      await admin.mutate('resources.create', { type: 'slack', name: 'Slack app', slug: 'slack_app' }),
    )
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: oauth.id,
        environmentId: prodId,
        config: { auth: { type: 'oauth', clientId: 'slack-client' } },
        secrets: { clientSecret: 'slack-secret' },
      }),
    )
    const started = await env.app.inject({
      method: 'GET',
      url: `/api/oauth/start?resourceId=${oauth.id}&environmentId=${prodId}&account=shared`,
      headers: { cookie: adminCookie },
    })
    const location = new URL(String(started.headers.location))
    expect(location.origin + location.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(location.searchParams.get('client_id')).toBe('slack-client')
    expect(location.searchParams.get('scope')).toBe('channels:read,chat:write')
    const connections = data(await admin.query('resources.oauthConnections', { resourceId: oauth.id }))
    expect(
      connections.environments.find((e: { environmentId: string }) => e.environmentId === prodId),
    ).toMatchObject({
      tokens: 'shared',
    })
    const unconnected = await run(oauth.id, { action: 'postMessage', channel: '#general', text: 'x' })
    expect(unconnected).toMatchObject({ ok: false, error: { code: 'auth_required' } })
  })

  it('Stripe and Airtable (M29): keys checked on save, a run’s create is idempotent, records written', async () => {
    const stripe = data(
      await admin.mutate('resources.create', { type: 'stripe', name: 'Stripe', slug: 'stripe' }),
    )
    const missing = await admin.mutate('resources.saveConfig', {
      resourceId: stripe.id,
      environmentId: prodId,
      config: {},
      secrets: {},
    })
    expect(missing.body.error?.message).toContain('Add the secret key')
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: stripe.id,
        environmentId: prodId,
        config: {},
        secrets: { token: fake.stripe.key },
      }),
    )
    const made = await run(
      stripe.id,
      { action: 'create', kind: 'customers', params: '{"email": "{{ email }}"}' },
      { email: 'ada@example.com' },
    )
    expect(made).toMatchObject({ ok: true, data: { email: 'ada@example.com' } })
    // The playground isn't a run: its key is random, so the same create twice makes two customers.
    await run(
      stripe.id,
      { action: 'create', kind: 'customers', params: '{"email": "{{ email }}"}' },
      { email: 'ada@example.com' },
    )
    expect(fake.stripe.objects.get('customers')?.size).toBe(2)
    expect(data(await admin.query('resources.types'))).toEqual(
      expect.arrayContaining([
        { type: 'stripe', label: 'Stripe', group: 'Services' },
        { type: 'airtable', label: 'Airtable', group: 'Services' },
        { type: 's3', label: 'Amazon S3', group: 'Storage' },
      ]),
    )

    const base = 'appFAKEBASE000002'
    fake.airtable.bases.set(base, [
      {
        id: 'tblStock00000001',
        name: 'Stock',
        fields: [{ id: 'fldSku', name: 'SKU', type: 'singleLineText' }],
        records: new Map(),
      },
    ])
    const at = await resourceOf('airtable', 'airtable', { base }, { token: fake.airtable.token })
    expect(
      await run(at, { action: 'create', table: 'Stock', records: '[{"SKU": "A"}, {"SKU": "B"}]' }),
    ).toMatchObject({
      ok: true,
      data: [{ SKU: 'A' }, { SKU: 'B' }],
    })
  })

  it('Jira and Notion (M29): settings checked on save, an issue created, a database queried', async () => {
    const jira = data(await admin.mutate('resources.create', { type: 'jira', name: 'Jira', slug: 'jira' }))
    const cloudSite = { siteUrl: fake.urls.jiraCloud, deployment: 'cloud', allowPrivateNetwork: true }
    const noEmail = await admin.mutate('resources.saveConfig', {
      resourceId: jira.id,
      environmentId: prodId,
      config: cloudSite,
      secrets: { token: 'x' },
    })
    expect(noEmail.body.error?.message).toContain('Add the email')
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: jira.id,
        environmentId: prodId,
        config: { ...cloudSite, email: fake.jira.email },
        secrets: { token: fake.jira.apiToken },
      }),
    )
    expect(
      await run(
        jira.id,
        { action: 'createIssue', project: 'OPS', issueType: 'Task', summary: 'From {{ who }}' },
        { who: 'a workflow' },
      ),
    ).toMatchObject({
      ok: true,
      data: { key: expect.stringMatching(/^OPS-/) },
    })

    const db = '2a3b4c5d-6e7f-4089-9abc-def012345678'
    fake.notion.databases.set(db, {
      id: db,
      title: 'Suppliers',
      properties: { Name: { id: 'title', type: 'title' } },
    })
    const notion = await resourceOf('notion', 'notion', {}, { token: fake.notion.token })
    await run(notion, { action: 'createPage', parent: db, properties: '{"Name": "Acme"}' })
    expect(await run(notion, { action: 'queryDatabase', id: db })).toMatchObject({
      ok: true,
      data: [{ Name: 'Acme' }],
    })
  })

  it('HubSpot: create and search records, and list an object’s properties for the forms', async () => {
    const id = await resourceOf('hubspot', 'crm', { auth: { type: 'token' } }, { token: fake.hubspot.token })
    await run(id, { action: 'create', objectType: 'contacts', properties: '{"email": "ada@example.com"}' })
    const found = await run(id, {
      action: 'search',
      objectType: 'contacts',
      filters: '[{"propertyName": "email", "operator": "EQ", "value": "ada@example.com"}]',
    })
    expect(found).toMatchObject({ ok: true, data: [{ properties: { email: 'ada@example.com' } }] })
    const props = data(
      await admin.query('resources.hubspotProperties', {
        resourceId: id,
        environmentId: prodId,
        objectType: 'deals',
      }),
    )
    expect(props.properties.map((p: { name: string }) => p.name)).toEqual(['dealname', 'amount', 'dealstage'])
    const odd = await admin.query('resources.hubspotProperties', {
      resourceId: id,
      environmentId: prodId,
      objectType: '../x',
    })
    expect(odd.status).toBe(400)
  })

  it('SendGrid: send through the EU host', async () => {
    const id = await resourceOf('sendgrid', 'mail', { region: 'eu' }, { token: fake.sendgrid.key })
    const sent = await run(id, {
      action: 'send',
      from: 'noreply@optiply.example',
      to: 'ada@example.com',
      subject: 'Hello',
      text: 'Hi',
    })
    expect(sent).toMatchObject({ ok: true, data: { status: 202 } })
    expect(fake.sendgrid.mails.at(-1)?.region).toBe('eu')
  })

  it('Google Sheets: a service account key, and the server’s identity only for admins where allowed', async () => {
    fake.sheets.spreadsheets.set('doc-1', {
      title: 'Stock',
      sharedWith: [fake.sheets.serviceAccountEmail],
      sheets: [
        {
          sheetId: 1,
          title: 'Stock',
          values: [
            ['sku', 'qty'],
            ['A-1', 3],
          ],
        },
      ],
    })
    const id = await resourceOf(
      'googlesheets',
      'stock',
      { auth: { type: 'serviceAccount' }, testSpreadsheet: 'doc-1' },
      { serviceAccountKey: fake.sheets.serviceAccountKey },
    )
    expect(await run(id, { action: 'read', spreadsheet: 'doc-1' })).toMatchObject({
      ok: true,
      data: [{ sku: 'A-1', qty: '3' }],
    })
    const tested = data(await admin.mutate('resources.test', { resourceId: id, environmentId: prodId }))
    expect(tested).toMatchObject({
      ok: true,
      message: `Google Sheets as ${fake.sheets.serviceAccountEmail}; spreadsheet “Stock”`,
    })

    const server = data(
      await admin.mutate('resources.create', { type: 'googlesheets', name: 'Server', slug: 'stock_server' }),
    )
    const save = (as: ReturnType<typeof trpc>) =>
      as.mutate('resources.saveConfig', {
        resourceId: server.id,
        environmentId: prodId,
        config: { auth: { type: 'server' } },
        secrets: {},
      })
    expect((await save(admin)).body.error?.message).toContain(
      "doesn't let resources use its own Google identity",
    )

    // The instance allows it: the server's credentials are the fake's service account, through its token endpoint.
    const keyFile = join(tmpdir(), `ow-sheets-${process.pid}.json`)
    writeFileSync(keyFile, fake.sheets.serviceAccountKey)
    configureGoogle(
      { GOOGLE_SERVER_IDENTITY: 'allow', GOOGLE_TOKEN_URL: fake.urls.googleToken },
      { GOOGLE_APPLICATION_CREDENTIALS: keyFile },
    )
    try {
      const groupId = data(await admin.mutate('groups.create', { name: 'Editors' })).id
      await admin.mutate('groups.addMember', { groupId, userId: memberId })
      data(
        await admin.mutate('permissions.set', {
          objectType: 'resource',
          objectId: server.id,
          groupId,
          environmentId: null,
          level: 'edit',
        }),
      )
      expect((await save(member)).status).toBe(403)
      expect((await save(admin)).status).toBe(200)
      expect(await run(server.id, { action: 'info', spreadsheet: 'doc-1' })).toMatchObject({
        ok: true,
        data: { title: 'Stock' },
      })
    } finally {
      configureGoogle({ GOOGLE_SERVER_IDENTITY: 'deny', GOOGLE_TOKEN_URL: fake.urls.googleToken })
    }
  })

  it('count queries by type, action and outcome', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/metrics' })
    expect(res.body).toMatch(
      /ow_connector_queries_total\{type="slack",action="postMessage",outcome="ok"\} [1-9]/,
    )
    expect(res.body).toMatch(
      /ow_connector_queries_total\{type="slack",action="postMessage",outcome="auth_required"\} 1/,
    )
  })

  it('never send a token or key back', () => {
    const all = seen.join('\n')
    for (const secret of [
      gql.token,
      fake.slack.token,
      fake.hubspot.token,
      fake.sendgrid.key,
      'slack-secret',
      'PRIVATE KEY',
    ]) {
      expect(all).not.toContain(secret)
    }
  })
})
