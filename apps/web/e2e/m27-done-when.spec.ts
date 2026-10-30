import { expect, type Page, test } from '@playwright/test'
import { block, signIn, trpcMutate, trpcQuery } from './helpers'

// M27's done-when (architecture.md, the M27 row): the built-in REST API resource, GraphQL, and Slack, HubSpot,
// SendGrid and Google Sheets against fakes, each from a workflow, an app or the playground.

const services = process.env.E2E_SERVICES!
const tokens = JSON.parse(process.env.E2E_SERVICES_TOKENS!) as {
  slack: string
  hubspot: string
  sendgrid: string
}
const graphql = JSON.parse(process.env.E2E_GRAPHQL!) as { url: string; token: string }
const SERVICE_ACCOUNT = 'tunnel@fake-project.iam.gserviceaccount.com'
const API_TOKEN = `m27-token-${Date.now().toString(36)}`

interface FakeState {
  slack: { messages: { channel: string; ts: string; text?: string; blocks?: unknown; thread_ts?: string }[] }
  hubspot: Record<string, { id: string; properties: Record<string, string> }[]>
  sendgrid: { region: string; mail: Record<string, unknown> }[]
  sheets: Record<string, { sheets: { title: string; values: unknown[][] }[] }>
  calls: { service: string; method: string; path: string; authorization: string | null }[]
}

const fakeState = async (): Promise<FakeState> => (await fetch(`${services}/_fake/state`)).json()

/** Every response body the page saw, to check no secret ever came back. */
function recordResponses(page: Page): string[] {
  const bodies: string[] = []
  page.on('response', async (res) => {
    if (!res.url().includes('/api/')) return
    try {
      bodies.push(await res.text())
    } catch {}
  })
  return bodies
}

async function production(page: Page): Promise<string> {
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  return envs.find((e) => e.slug === 'production')!.id
}

async function resourceOf(page: Page, type: string, slug: string, config: unknown, secrets: unknown) {
  // Named to sort after the setup's Shop DB: new query blocks in other specs take the first resource.
  const created = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type,
    name: `Test ${slug}`,
    slug,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: created.id,
    environmentId: await production(page),
    config,
    secrets,
  })
  return created.id
}

/** A workflow from blocks run in a line after the start, its draft saved; returns its id, slug and draft revision. */
async function workflow(page: Page, slug: string, blocks: object[]) {
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  const names = ['startTrigger', ...blocks.map((b) => (b as { name: string }).name)]
  const saved = await trpcMutate<{ revision: number }>(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges: names.slice(1).map((to, i) => ({ from: names[i], port: 'out', to })),
    },
  })
  return { id: flow.id, slug, revision: saved.revision }
}

async function runWorkflow(page: Page, slug: string, input: unknown, version: 'draft' | 'live' = 'draft') {
  const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, { data: { input, version } })
  expect(started.status()).toBe(202)
  const id = (await started.json()).run.id as string
  let run: { status: string; response: { body: unknown } | null; error: unknown }
  await expect
    .poll(
      async () => {
        run = (await (await page.request.get(`/api/v1/runs/${id}`)).json()).run
        return run.status
      },
      { timeout: 30_000 },
    )
    .toMatch(/succeeded|failed/)
  return run!
}

/** The playground: the resource's page, its Query tab. */
async function playground(page: Page, resourceId: string) {
  await page.goto(`/resources/${resourceId}`)
  await page.getByRole('button', { name: 'Query', exact: true }).click()
}

async function runPlayground(page: Page) {
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText(/^(Success|Failed)$/)).toBeVisible()
}

test('the built-in REST API resource and GraphQL', async ({ page }) => {
  const seen = recordResponses(page)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const prod = await production(page)

  await test.step('a workflow GETs a URL through rest_api with a bearer token from a secret config var', async () => {
    await trpcMutate(page, 'configVars.create', { name: `M27_TOKEN_${stamp}`, isSecret: true })
    const vars = await trpcQuery<{ id: string; name: string }[]>(page, 'configVars.list', undefined)
    await trpcMutate(page, 'configVars.setValue', {
      configVarId: vars.find((v) => v.name === `M27_TOKEN_${stamp}`)!.id,
      environmentId: prod,
      value: API_TOKEN,
    })
    const flow = await workflow(page, `m27-rest-${stamp}`, [
      {
        name: 'call',
        type: 'resourceQuery',
        config: {
          resource: 'rest_api',
          query: {
            method: 'GET',
            url: `${services}/_fake/echo/orders/{{ startTrigger.data.id }}`,
            auth: { type: 'bearer', token: `{{ configVars.M27_TOKEN_${stamp} }}` },
          },
        },
      },
      { name: 'reply', type: 'response', config: { status: '200', body: '{{ call.data.path }}' } },
    ])
    // Secret config vars reach released runs only.
    await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: flow.revision })
    const run = await runWorkflow(page, flow.slug, { id: 42 }, 'live')
    expect(run).toMatchObject({ status: 'succeeded', response: { body: '/_fake/echo/orders/42' } })
    const call = (await fakeState()).calls.findLast((c) => c.path === '/_fake/echo/orders/42')
    expect(call?.authorization).toBe(`Bearer ${API_TOKEN}`)
    expect(JSON.stringify(run)).not.toContain(API_TOKEN)
  })

  await test.step("an app posts JSON through rest_api; its viewer's values can't change the host", async () => {
    const slug = `m27-app-${stamp}`
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Poster' })
    const query = (name: string, q: object) => ({
      name,
      kind: 'resource',
      resource: 'rest_api',
      query: q,
      run: 'manual',
    })
    await trpcMutate(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [],
        queries: [
          query('post', {
            method: 'POST',
            url: `${services}/_fake/echo/app`,
            body: { type: 'json', json: '{"qty": {{ qty.value }}}' },
          }),
          query('anywhere', { method: 'GET', url: '{{ target.value }}' }),
        ],
      },
    })
    const run = (name: string, values: Record<string, unknown>) =>
      trpcMutate<{ ok: boolean; data?: { body: string }; error?: { code: string; message: string } }>(
        page,
        'apps.runQuery',
        { appId: app.id, releaseId: null, query: name, environmentId: prod, values },
      )
    expect(await run('post', { ' qty.value ': 3 })).toMatchObject({ ok: true, data: { body: '{"qty":3}' } })
    expect(await run('anywhere', { ' target.value ': 'https://evil.example/' })).toMatchObject({
      ok: false,
      error: { code: 'blocked' },
    })
  })

  await test.step('a private address is refused (the playground)', async () => {
    const { resources } = await trpcQuery<{ resources: { id: string; slug: string }[] }>(
      page,
      'resources.list',
      undefined,
    )
    await playground(page, resources.find((r) => r.slug === 'rest_api')!.id)
    await page.getByTestId('request-url').fill('http://10.1.2.3/internal')
    await runPlayground(page)
    await expect(page.getByText('10.1.2.3 is a private address')).toBeVisible()
  })

  const shopId = await resourceOf(
    page,
    'graphql',
    `m27_shop_${stamp}`,
    { baseUrl: graphql.url, allowPrivateNetwork: true, auth: { type: 'bearer' } },
    { bearerToken: graphql.token },
  )

  await test.step('GraphQL: a query with variables returns data; an error comes back with its path', async () => {
    await playground(page, shopId)
    await page.getByTestId('graphql-query').fill('query($c: String) { orders(customer: $c) { id amount } }')
    await page.getByTestId('graphql-variables').fill('{"c": {{ who }}}')
    await page.getByLabel('Test values').fill('{"who": "acme"}')
    await runPlayground(page)
    await expect(page.getByText('Success')).toBeVisible()
    await expect(page.getByText('1200')).toBeVisible()

    await page.getByTestId('graphql-query').fill('{ order(id: "13") { id risk } }')
    await runPlayground(page)
    await expect(page.getByText('Risk service unavailable (at order.risk)')).toBeVisible()
  })

  await test.step("GraphQL's schema completes a field and marks an unknown one in the editor", async () => {
    const flow = await workflow(page, `m27-gql-${stamp}`, [
      {
        name: 'orders',
        type: 'resourceQuery',
        config: {
          resource: `m27_shop_${stamp}`,
          query: { query: '{ order(id: "1") { nope } }', variables: '' },
        },
      },
    ])
    await page.goto(`/workflows/${flow.id}`)
    await block(page, 'orders').click()
    const editor = page.locator('[data-testid$="/orders/query.query"]')
    await expect(editor.locator('.squiggly-error')).toBeVisible()
    await editor.locator('.view-line').first().click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('{ order(id: "1") { am')
    await page.keyboard.press('Control+Space')
    await expect(page.locator('.suggest-widget').getByText('amount')).toBeVisible()
  })

  for (const secret of [API_TOKEN, graphql.token]) expect(seen.join('\n')).not.toContain(secret)
})

test('Slack, HubSpot, SendGrid and Google Sheets', async ({ page }) => {
  const seen = recordResponses(page)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const prod = await production(page)

  await test.step('Slack: a workflow posts blocks, replies in the thread, and lists channels across pages', async () => {
    await resourceOf(
      page,
      'slack',
      `m27_slack_${stamp}`,
      { auth: { type: 'token' } },
      { token: tokens.slack },
    )
    const flow = await workflow(page, `m27-slack-${stamp}`, [
      {
        name: 'post',
        type: 'resourceQuery',
        config: {
          resource: `m27_slack_${stamp}`,
          query: {
            action: 'postMessage',
            channel: '#general',
            text: 'Order {{ startTrigger.data.id }}',
            blocks:
              '[{"type": "section", "text": {"type": "mrkdwn", "text": "*{{ startTrigger.data.id }}* shipped"}}]',
          },
        },
      },
      {
        name: 'reply',
        type: 'resourceQuery',
        config: {
          resource: `m27_slack_${stamp}`,
          query: {
            action: 'postMessage',
            channel: '{{ post.data.channel }}',
            text: 'Tracking soon',
            threadTs: '{{ post.data.ts }}',
          },
        },
      },
      {
        name: 'channels',
        type: 'resourceQuery',
        config: {
          resource: `m27_slack_${stamp}`,
          query: { action: 'listChannels', excludeArchived: 'false', max: '3' },
        },
      },
      {
        name: 'answer',
        type: 'response',
        config: { status: '200', body: '{{ channels.data.map((c) => c.name) }}' },
      },
    ])
    const run = await runWorkflow(page, flow.slug, { id: `A-${stamp}` })
    expect(run).toMatchObject({ status: 'succeeded', response: { body: ['general', 'team-1', 'team-2'] } })
    const messages = (await fakeState()).slack.messages
    const post = messages.find((m) => m.text === `Order A-${stamp}`)!
    expect(post.blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: `*A-${stamp}* shipped` } }])
    expect(messages.find((m) => m.thread_ts === post.ts)?.text).toBe('Tracking soon')
  })

  await test.step('HubSpot with a private app token: an app creates and updates a deal; the playground searches contacts', async () => {
    const crmId = await resourceOf(
      page,
      'hubspot',
      `m27_crm_${stamp}`,
      { auth: { type: 'token' } },
      { token: tokens.hubspot },
    )
    const slug = `m27-crm-${stamp}`
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Deals' })
    const q = (name: string, query: object) => ({
      name,
      kind: 'resource',
      resource: `m27_crm_${stamp}`,
      query,
      run: 'manual',
    })
    await trpcMutate(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [],
        queries: [
          q('create', {
            action: 'create',
            objectType: 'deals',
            properties: '{"dealname": {{ name.value }}, "amount": 100}',
          }),
          q('update', {
            action: 'update',
            objectType: 'deals',
            id: '{{ deal.value }}',
            properties: '{"dealstage": "closedwon"}',
          }),
          q('contact', {
            action: 'create',
            objectType: 'contacts',
            properties: '{"email": {{ email.value }}}',
          }),
        ],
      },
    })
    const run = (query: string, values: Record<string, unknown>) =>
      trpcMutate<{ ok: boolean; data: { id: string } }>(page, 'apps.runQuery', {
        appId: app.id,
        releaseId: null,
        query,
        environmentId: prod,
        values,
      })
    const deal = await run('create', { ' name.value ': `Deal ${stamp}` })
    expect(deal.ok).toBe(true)
    expect((await run('update', { ' deal.value ': deal.data.id })).ok).toBe(true)
    const stored = (await fakeState()).hubspot.deals!.find((d) => d.id === deal.data.id)!
    expect(stored.properties).toMatchObject({ dealname: `Deal ${stamp}`, dealstage: 'closedwon' })
    await run('contact', { ' email.value ': `ada-${stamp}@example.com` })

    await playground(page, crmId)
    await expect(page.getByTestId('query-action')).toHaveValue('search')
    await page
      .getByTestId('query-field-filters')
      .fill(`[{"propertyName": "email", "operator": "EQ", "value": "ada-${stamp}@example.com"}]`)
    await runPlayground(page)
    await expect(page.getByText(`ada-${stamp}@example.com`).first()).toBeVisible()
  })

  await test.step('HubSpot through OAuth: an account connected, then queries run as it', async () => {
    const id = await resourceOf(
      page,
      'hubspot',
      `m27_crm_oauth_${stamp}`,
      { auth: { type: 'oauth', clientId: 'hubspot-client' } },
      { clientSecret: 'hubspot-secret' },
    )
    // HubSpot's consent screen, answered at once. Playwright can't intercept the page a redirect leads to, so the start
    // is fetched here (its state cookie kept) and the popup sent straight back to the callback with a code.
    await page.context().route('**/api/oauth/start?**', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 })
      const asked = new URL(response.headers().location!)
      expect(asked.origin + asked.pathname).toBe('https://app.hubspot.com/oauth/authorize')
      expect(asked.searchParams.get('client_id')).toBe('hubspot-client')
      const back = new URL(asked.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', `code-${stamp}`)
      back.searchParams.set('state', asked.searchParams.get('state')!)
      await route.fulfill({ response, headers: { ...response.headers(), location: back.toString() } })
    })
    await page.goto(`/resources/${id}`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const popup = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Connect account', exact: true }).click()
    await (await popup).waitForEvent('close')
    await page.context().unroute('**/api/oauth/start?**')
    await expect(page.getByText('Connected', { exact: true })).toBeVisible()
    const out = await trpcMutate<{ ok: boolean; data: unknown[] }>(page, 'resources.run', {
      resourceId: id,
      environmentId: prod,
      query: { action: 'search', objectType: 'deals', filters: '[]' },
    })
    expect(out.ok).toBe(true)
    expect(
      (await fakeState()).calls.findLast((c) => c.path.endsWith('/deals/search'))?.authorization,
    ).toMatch(/^Bearer hub-oauth-\d+$/)
  })

  await test.step('SendGrid: a template email with data and an attachment, on the EU host (the playground)', async () => {
    const id = await resourceOf(
      page,
      'sendgrid',
      `m27_mail_${stamp}`,
      { region: 'eu' },
      { token: tokens.sendgrid },
    )
    await playground(page, id)
    await page.getByTestId('query-field-from').fill('Optiply <noreply@optiply.example>')
    await page.getByTestId('query-field-to').fill('{{ to }}')
    await page.getByTestId('query-field-templateId').fill('d-m27')
    await page.getByTestId('query-field-templateData').fill('{"name": {{ name }}}')
    await page.getByTestId('query-field-attachments').fill('{{ files }}')
    await page.getByLabel('Test values').fill(
      JSON.stringify({
        to: [`a-${stamp}@example.com`],
        name: 'Ada',
        files: [{ base64: 'JVBERg==', filename: 'invoice.pdf', contentType: 'application/pdf' }],
      }),
    )
    await runPlayground(page)
    await expect(page.getByText('Success')).toBeVisible()
    const mail = (await fakeState()).sendgrid.findLast((m) =>
      JSON.stringify(m.mail).includes(`a-${stamp}@example.com`),
    )!
    expect(mail.region).toBe('eu')
    expect(mail.mail).toMatchObject({
      template_id: 'd-m27',
      personalizations: [{ dynamic_template_data: { name: 'Ada' } }],
      attachments: [{ filename: 'invoice.pdf', type: 'application/pdf' }],
    })
  })

  await test.step('Google Sheets with a service account key: an app reads objects; append and update by column', async () => {
    const doc = `m27-${stamp}`
    await fetch(`${services}/_fake/sheets/${doc}`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Stock',
        sharedWith: [SERVICE_ACCOUNT],
        sheets: [
          {
            sheetId: 1,
            title: 'Stock',
            values: [
              ['sku', 'qty'],
              ['A-1', 3],
              ['B-2', 5],
            ],
          },
        ],
      }),
    })
    await resourceOf(
      page,
      'googlesheets',
      `m27_sheets_${stamp}`,
      { auth: { type: 'serviceAccount' } },
      { serviceAccountKey: process.env.E2E_IAP_KEY },
    )
    const slug = `m27-stock-${stamp}`
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Stock' })
    await trpcMutate(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [
          {
            name: 'text1',
            type: 'text',
            props: { value: 'First: {{ stock.data[0].sku }} × {{ stock.data[0].qty }}' },
          },
        ],
        layout: { text1: { x: 0, y: 0, w: 6, h: 2 } },
        queries: [
          {
            name: 'stock',
            kind: 'resource',
            resource: `m27_sheets_${stamp}`,
            query: { action: 'read', spreadsheet: `https://docs.google.com/spreadsheets/d/${doc}/edit` },
            run: 'auto',
          },
        ],
      },
    })
    await page.goto(`/apps/${slug}/edit`)
    await expect(page.getByTestId('frame-text1')).toContainText('First: A-1 × 3')

    const flow = await workflow(page, `m27-sheets-${stamp}`, [
      {
        name: 'add',
        type: 'resourceQuery',
        config: {
          resource: `m27_sheets_${stamp}`,
          query: { action: 'append', spreadsheet: doc, rows: '{{ [{ qty: 7, sku: "C-3" }] }}' },
        },
      },
      {
        name: 'fix',
        type: 'resourceQuery',
        config: {
          resource: `m27_sheets_${stamp}`,
          query: {
            action: 'update',
            spreadsheet: doc,
            keyColumn: 'sku',
            rows: '{{ [{ sku: "B-2", qty: 9 }] }}',
          },
        },
      },
    ])
    expect((await runWorkflow(page, flow.slug, {})).status).toBe('succeeded')
    expect((await fakeState()).sheets[doc]!.sheets[0]!.values).toEqual([
      ['sku', 'qty'],
      ['A-1', 3],
      ['B-2', 9],
      ['C-3', 7],
    ])
  })

  await test.step("Google Sheets as this server's own identity, chosen by an admin", async () => {
    const id = await resourceOf(
      page,
      'googlesheets',
      `m27_sheets_server_${stamp}`,
      { auth: { type: 'server' } },
      {},
    )
    const out = await trpcMutate<{ ok: boolean; data: { title: string } }>(page, 'resources.run', {
      resourceId: id,
      environmentId: prod,
      query: { action: 'info', spreadsheet: `m27-${stamp}` },
    })
    expect(out).toMatchObject({ ok: true, data: { title: 'Stock' } })
  })

  for (const secret of [tokens.slack, tokens.hubspot, tokens.sendgrid, 'hubspot-secret', 'PRIVATE KEY']) {
    expect(seen.join('\n')).not.toContain(secret)
  }
})
