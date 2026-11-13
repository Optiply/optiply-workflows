import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

// M29's done-when (architecture.md, the M29 row): S3 against an S3-compatible store in Docker and Stripe, Airtable,
// Jira, Notion and Salesforce against fakes, all from one workflow; an S3 resource made in the UI; an OpenAPI
// resource's operation run from its form in the playground.

const services = process.env.E2E_SERVICES!
const m29 = JSON.parse(process.env.E2E_M29!) as {
  stripe: string
  airtable: { token: string; base: string }
  jira: { site: string; email: string; token: string }
  notion: { token: string; database: string }
  salesforce: { clientId: string; clientSecret: string }
}
const s3 = process.env.E2E_S3
  ? (JSON.parse(process.env.E2E_S3) as {
      endpoint: string
      region: string
      accessKeyId: string
      secretAccessKey: string
    })
  : null

interface FakeState {
  m29: {
    stripe: Record<string, Record<string, unknown>[]>
    airtable: Record<string, Record<string, { fields: Record<string, unknown> }[]>>
    jira: { key: string; fields: Record<string, unknown> }[]
    notion: { properties: Record<string, unknown> }[]
    salesforce: Record<string, Record<string, unknown>[]>
    soql: string[]
  }
}
const fakeState = async (): Promise<FakeState> => (await fetch(`${services}/_fake/state`)).json()

async function production(page: Page): Promise<string> {
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  return envs.find((e) => e.slug === 'production')!.id
}

async function resourceOf(page: Page, type: string, slug: string, config: unknown, secrets: unknown) {
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

const query = (name: string, resource: string, q: object) => ({
  name,
  type: 'resourceQuery',
  config: { resource, query: q },
})

test('one workflow writes to S3, Stripe, Airtable, Jira, Notion and Salesforce, and reads back', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const slug = (name: string) => `m29_${name}_${stamp}`
  const s3Slug = slug('files')
  if (s3)
    await resourceOf(
      page,
      's3',
      s3Slug,
      {
        region: s3.region,
        identity: 'key',
        accessKeyId: s3.accessKeyId,
        endpoint: s3.endpoint,
        forcePathStyle: true,
        bucket: 'e2e-files',
      },
      { secretAccessKey: s3.secretAccessKey },
    )
  await resourceOf(page, 'stripe', slug('stripe'), {}, { token: m29.stripe })
  await resourceOf(
    page,
    'airtable',
    slug('airtable'),
    { base: m29.airtable.base },
    { token: m29.airtable.token },
  )
  await resourceOf(
    page,
    'jira',
    slug('jira'),
    { siteUrl: m29.jira.site, deployment: 'cloud', email: m29.jira.email, allowPrivateNetwork: true },
    { token: m29.jira.token },
  )
  await resourceOf(page, 'notion', slug('notion'), {}, { token: m29.notion.token })
  await resourceOf(
    page,
    'salesforce',
    slug('salesforce'),
    {
      domain: 'https://optiply.my.salesforce.com',
      auth: { type: 'clientCredentials', clientId: m29.salesforce.clientId },
    },
    { clientSecret: m29.salesforce.clientSecret },
  )

  const blocks = [
    ...(s3
      ? [
          query('saveOrder', s3Slug, {
            action: 'put',
            key: `orders/${stamp}.json`,
            body: '{{ startTrigger.data }}',
            format: 'json',
          }),
          query('listOrders', s3Slug, { action: 'list', prefix: 'orders/' }),
        ]
      : []),
    query('customer', slug('stripe'), {
      action: 'create',
      kind: 'customers',
      params: '{"email": "{{ startTrigger.data.email }}", "metadata": {"run": "{{ stamp }}"}}'.replace(
        '{{ stamp }}',
        stamp,
      ),
    }),
    query('stock', slug('airtable'), {
      action: 'upsert',
      table: 'Stock',
      mergeOn: 'SKU',
      records: '[{"SKU": "{{ startTrigger.data.sku }}", "Qty": {{ startTrigger.data.qty }}}]',
    }),
    query('ticket', slug('jira'), {
      action: 'createIssue',
      project: 'OPS',
      issueType: 'Task',
      summary: 'Restock {{ startTrigger.data.sku }}',
      description: 'Customer {{ customer.data.id }}',
    }),
    query('openTickets', slug('jira'), { action: 'search', jql: 'project = OPS AND statusCategory != Done' }),
    query('order', slug('notion'), {
      action: 'createPage',
      parent: m29.notion.database,
      properties:
        '{"Name": "PO {{ startTrigger.data.sku }}", "Qty": {{ startTrigger.data.qty }}, "Status": "Open"}',
    }),
    query('openOrders', slug('notion'), {
      action: 'queryDatabase',
      id: m29.notion.database,
      filter: '{"property": "Status", "status": {"equals": "Open"}}',
    }),
    query('account', slug('salesforce'), {
      action: 'create',
      object: 'Account',
      record: '{"Name": "{{ startTrigger.data.company }}"}',
    }),
    query('accounts', slug('salesforce'), {
      action: 'query',
      soql: 'SELECT Id, Name FROM Account WHERE Name = {{ startTrigger.data.company }}',
    }),
    {
      name: 'reply',
      type: 'response',
      config: {
        status: '200',
        body: `{{ ({ ${s3 ? 'files: listOrders.data.map((o) => o.key), ' : ''}customer: customer.data.id, stock: stock.data[0].Qty, ticket: ticket.data.key, open: openTickets.data.length, orders: openOrders.data.map((o) => o.Name), accounts: accounts.data.map((a) => a.Name) }) }}`,
      },
    },
  ]
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `m29-all-${stamp}`,
    name: 'M29 all',
  })
  const names = ['startTrigger', ...blocks.map((b) => b.name)]
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges: names.slice(1).map((to, i) => ({ from: names[i], port: 'out', to })),
    },
  })
  // A company whose name would break naive SOQL: its quote stays inside the value.
  const company = `O'Neil ${stamp}`
  const started = await page.request.post(`/api/v1/workflows/m29-all-${stamp}/runs`, {
    data: {
      input: { email: `ada-${stamp}@example.com`, sku: `SKU-${stamp}`, qty: 12, company },
      version: 'draft',
    },
  })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run.id as string
  let run: { status: string; response: { body: unknown } | null; error: unknown } | undefined
  await expect
    .poll(
      async () => {
        run = (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).run
        return run!.status
      },
      { timeout: 60_000 },
    )
    .toMatch(/succeeded|failed/)
  expect(run!.error ?? null).toBeNull()
  const body = run!.response!.body as Record<string, unknown>
  expect(body).toMatchObject({
    customer: expect.stringMatching(/^cus_/),
    stock: 12,
    ticket: expect.stringMatching(/^OPS-\d+$/),
    orders: expect.arrayContaining([`PO SKU-${stamp}`]),
    accounts: [company],
  })
  expect(body.open).toBeGreaterThanOrEqual(1)
  if (s3) expect(body.files).toContain(`orders/${stamp}.json`)

  const state = (await fakeState()).m29
  expect(state.stripe.customers?.find((c) => c.email === `ada-${stamp}@example.com`)).toMatchObject({
    metadata: { run: stamp },
  })
  expect(
    state.airtable[m29.airtable.base]!.Stock!.find((r) => r.fields.SKU === `SKU-${stamp}`)?.fields.Qty,
  ).toBe(12)
  expect(
    state.jira.find((i) => i.fields.summary === `Restock SKU-${stamp}`)?.fields.description,
  ).toMatchObject({ type: 'doc' })
  expect(state.soql.at(-1)).toBe(`SELECT Id, Name FROM Account WHERE Name = 'O\\'Neil ${stamp}'`)
})

test('an S3 resource made in the UI, and OpenAPI and Stripe from the playground', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)

  await test.step('the picker groups the new types', async () => {
    await page.goto('/resources')
    await page.getByRole('button', { name: 'New resource' }).click()
    const type = page.getByRole('combobox', { name: 'Type' })
    await expect(type.locator('optgroup[label="Storage"] option')).toHaveText(['Amazon S3'])
    await expect(type.locator('optgroup[label="Services"] option')).toContainText([
      'Stripe',
      'Airtable',
      'Jira',
      'Notion',
      'Salesforce',
    ])
    await expect(type.locator('optgroup[label="APIs"] option')).toContainText(['OpenAPI'])
  })

  if (s3) {
    await test.step('S3: the identity, endpoint and default bucket, tested, then an object put from the playground', async () => {
      const type = page.getByRole('combobox', { name: 'Type' })
      await type.selectOption('s3')
      await page.getByLabel('Name').fill(`Files ${stamp}`)
      await page.getByRole('button', { name: 'Create' }).click()
      await page.getByTestId('aws-region').fill(s3.region)
      await page.getByTestId('aws-access-key-id').fill(s3.accessKeyId)
      await page.getByPlaceholder('wJalrXUtnFEMI/K7MDENG/…').fill(s3.secretAccessKey)
      await page.getByTestId('s3-bucket').fill('e2e-files')
      await page.getByTestId('s3-endpoint').fill(s3.endpoint)
      await page.getByText('Path-style URLs', { exact: true }).click()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Saved.')).toBeVisible()
      await page.getByRole('button', { name: 'Test connection' }).click()
      await expect(page.getByText(`Bucket e2e-files in ${s3.region} is reachable`)).toBeVisible()

      await page.getByRole('button', { name: 'Query', exact: true }).click()
      await page.getByTestId('query-action').selectOption('put')
      await page.getByTestId('query-field-key').fill(`ui/${stamp}.txt`)
      await page.getByTestId('query-field-body').fill('from the playground')
      await page.getByRole('button', { name: 'Run' }).click()
      await expect(page.getByText('Success')).toBeVisible()
      await page.getByTestId('query-action').selectOption('get')
      await page.getByTestId('query-field-key').fill(`ui/${stamp}.txt`)
      await page.getByRole('button', { name: 'Run' }).click()
      await expect(page.getByText('"from the playground"').first()).toBeVisible()
    })
  }

  await test.step('OpenAPI: an operation chosen, its parameters filled in, run', async () => {
    const spec = [
      'openapi: 3.0.3',
      'info: { title: Echo, version: "1" }',
      'paths:',
      '  /echo/orders/{id}:',
      '    get:',
      '      operationId: getOrder',
      '      tags: [orders]',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: integer } }',
      '        - { name: expand, in: query, schema: { type: array, items: { type: string } }, explode: false }',
    ].join('\n')
    const id = await resourceOf(
      page,
      'openapi',
      `m29_echo_${stamp}`,
      { baseUrl: `${services}/_fake`, allowPrivateNetwork: true, spec },
      {},
    )
    await page.goto(`/resources/${id}`)
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByTestId('openapi-filter').fill('order')
    await page.getByTestId('openapi-operation').selectOption('getOrder')
    await expect(page.getByTestId('openapi-parameters')).toContainText('integer')
    await expect(page.getByTestId('openapi-parameters')).toContainText('path')
    // Choosing the operation filled in its parameters' names.
    await expect(page.getByTestId('openapi-field-parameters')).toHaveValue(/"id": ""/)
    await page.getByTestId('openapi-field-parameters').fill('{"id": 42, "expand": ["lines", "customer"]}')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('Success')).toBeVisible()
    await expect(page.getByText('/_fake/echo/orders/42').first()).toBeVisible()
    await expect(page.getByText('lines,customer').first()).toBeVisible()
  })

  await test.step('Stripe: the action form lists customers', async () => {
    const id = await resourceOf(page, 'stripe', `m29_stripe_ui_${stamp}`, {}, { token: m29.stripe })
    await page.goto(`/resources/${id}`)
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByTestId('query-action').selectOption('list')
    await page.getByTestId('query-field-max').fill('5')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('Success')).toBeVisible()
  })
})
