import { expect, type Page, test } from '@playwright/test'
import { block, signIn, trpcMutate, trpcQuery } from './helpers'

// M27 step 5: the new resources' settings and query forms, in the playground, the workflow inspector and the app editor.

const services = process.env.E2E_SERVICES!
const tokens = JSON.parse(process.env.E2E_SERVICES_TOKENS!) as {
  slack: string
  hubspot: string
  sendgrid: string
}
const graphql = JSON.parse(process.env.E2E_GRAPHQL!) as { url: string; token: string }

async function production(page: Page): Promise<string> {
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  return envs.find((e) => e.slug === 'production')!.id
}

async function fakeState(): Promise<{
  slack: { messages: { channel: string; text?: string }[] }
  hubspot: Record<string, { properties: Record<string, string> }[]>
  sendgrid: { region: string; mail: Record<string, unknown> }[]
}> {
  return (await fetch(`${services}/_fake/state`)).json()
}

test('a Slack resource: the picker, its token, Test connection, and a message from the playground', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  await page.goto('/resources')
  await page.getByRole('button', { name: 'New resource' }).click()
  const type = page.getByRole('combobox', { name: 'Type' })
  await expect(type.locator('optgroup[label="Services"] option')).toHaveText([
    'Slack',
    'HubSpot',
    'SendGrid',
    'Google Sheets',
  ])
  await expect(type.locator('option[value="restapi"]')).toHaveCount(0)
  await type.selectOption('slack')
  await page.getByLabel('Name').fill(`Slack ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()

  await test.step('the token, saved and tested', async () => {
    await expect(page.getByTestId('service-auth')).toHaveValue('token')
    await page.getByPlaceholder('xoxb-…').fill(tokens.slack)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText('Connected · Slack: Fake Team, as ow-bot')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(tokens.slack)
  })

  await test.step('OAuth shows the app’s fields and the redirect URI', async () => {
    await page.getByTestId('service-auth').selectOption('oauth')
    await expect(page.getByTestId('oauth-client-id')).toBeVisible()
    await expect(page.getByText('Redirect URI')).toBeVisible()
    await page.getByTestId('service-auth').selectOption('token')
  })

  await test.step('the playground posts a message', async () => {
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await expect(page.getByTestId('query-action')).toHaveValue('postMessage')
    await page.getByTestId('query-field-channel').fill('#general')
    await page.getByTestId('query-field-text').fill(`From the playground ${stamp}`)
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('Success')).toBeVisible()
    await expect
      .poll(async () =>
        (await fakeState()).slack.messages.some((m) => m.text === `From the playground ${stamp}`),
      )
      .toBe(true)

    // A new action keeps the channel.
    await page.getByTestId('query-action').selectOption('listChannels')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('team-1')).toBeVisible()
  })
})

test('the built-in REST API resource: no settings, a full URL and its own auth', async ({ page }) => {
  await signIn(page)
  const { resources } = await trpcQuery<{ resources: { id: string; slug: string }[] }>(
    page,
    'resources.list',
    undefined,
  )
  const builtIn = resources.find((r) => r.slug === 'rest_api')!
  await page.goto(`/resources/${builtIn.id}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByTestId('built-in-rest')).toContainText('any public address')

  await page.getByRole('button', { name: 'Query', exact: true }).click()
  await page.getByTestId('request-url').fill(`${services}/_fake/echo/orders/{{ id }}`)
  await page.getByTestId('request-auth').selectOption('bearer')
  await page.getByTestId('request-auth-token').fill('tok-{{ id }}')
  await page.getByLabel('Test values').fill('{"id": 7}')
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText('Success')).toBeVisible()
  await expect(page.getByText('/_fake/echo/orders/7')).toBeVisible()
  await expect(page.getByText('Bearer tok-7')).toBeVisible()
})

test('a HubSpot query in the workflow inspector, and a GraphQL query in the app editor', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const prod = await production(page)
  const crm = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'hubspot',
    name: 'CRM',
    slug: `crm_${stamp}`,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: crm.id,
    environmentId: prod,
    config: { auth: { type: 'token' } },
    secrets: { token: tokens.hubspot },
  })
  const shop = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'graphql',
    name: 'Shop',
    slug: `shop_${stamp}`,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: shop.id,
    environmentId: prod,
    config: { baseUrl: graphql.url, allowPrivateNetwork: true, auth: { type: 'bearer' } },
    secrets: { bearerToken: graphql.token },
  })

  await test.step('the inspector: choosing the resource starts its first action; fields save to the draft', async () => {
    const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
      slug: `crm-${stamp}`,
      name: 'CRM',
    })
    await trpcMutate(page, 'workflows.saveDraft', {
      id: flow.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          {
            name: 'find',
            type: 'resourceQuery',
            config: { resource: 'rest_api', query: { url: 'https://' } },
          },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'find' }],
      },
    })
    await page.goto(`/workflows/${flow.id}`)
    await block(page, 'find').click()
    await expect(page.getByTestId('request-auth')).toBeVisible()
    await page.getByRole('combobox', { name: 'Resource' }).selectOption(`crm_${stamp}`)
    await expect(page.getByTestId('action-query-hubspot')).toBeVisible()
    await expect(page.getByTestId('query-action')).toHaveValue('search')
    await page.getByTestId('query-action').selectOption('create')
    await expect(page.getByTestId('query-field-objectType')).toHaveValue('contacts')
    await expect
      .poll(async () => {
        const wf = await trpcQuery<{ draftDefinition: { blocks: { name: string; config: unknown }[] } }>(
          page,
          'workflows.get',
          { id: flow.id },
        )
        return wf.draftDefinition.blocks.find((b) => b.name === 'find')?.config
      })
      .toMatchObject({ resource: `crm_${stamp}`, query: { action: 'create', objectType: 'contacts' } })
  })

  await test.step('the app editor: a GraphQL query with its query and variables', async () => {
    const slug = `gql-${stamp}`
    await trpcMutate(page, 'apps.create', { slug, name: 'Orders' })
    await page.goto(`/apps/${slug}/edit`)
    await page.getByTitle('Add a resource query').click()
    const panel = page.getByTestId('query-query1')
    await panel.getByRole('combobox', { name: 'Resource' }).selectOption(`shop_${stamp}`)
    await expect(panel.locator('[data-testid$="/queries/0/query/query"]')).toBeVisible()
    await expect(panel.locator('[data-testid$="/queries/0/query/variables"]')).toBeVisible()
  })
})

test('the GraphQL editor completes fields from the schema and marks unknown ones', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const prod = await production(page)
  const shop = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'graphql',
    name: 'Shop',
    slug: `gql_${stamp}`,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: shop.id,
    environmentId: prod,
    config: { baseUrl: graphql.url, allowPrivateNetwork: true, auth: { type: 'bearer' } },
    secrets: { bearerToken: graphql.token },
  })
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `gql-${stamp}`,
    name: 'GQL',
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        {
          name: 'orders',
          type: 'resourceQuery',
          config: {
            resource: `gql_${stamp}`,
            query: { query: '{ order(id: "1") { nope } }', variables: '' },
          },
        },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'orders' }],
    },
  })
  await page.goto(`/workflows/${flow.id}`)
  await block(page, 'orders').click()
  const editor = page.locator('[data-testid$="/orders/query.query"]')
  await expect(editor).toBeVisible()

  await test.step('an unknown field is marked, with the schema’s message', async () => {
    await expect(editor.locator('.squiggly-error')).toBeVisible()
    await editor.locator('.view-line span', { hasText: 'nope' }).last().hover()
    await expect(page.getByText('Cannot query field "nope" on type "Order".')).toBeVisible()
  })

  await test.step('completions offer the type’s fields', async () => {
    await editor.locator('.view-line').first().click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('{ order(id: "1") { cu')
    await page.keyboard.press('Control+Space')
    await expect(page.locator('.suggest-widget').getByText('customer')).toBeVisible()
  })
})
