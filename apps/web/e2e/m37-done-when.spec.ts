import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

// M37's done-when (architecture.md §2.41), against fakes: a Gemini resource made and tested in the UI, a workflow
// extracting with it through the Gemini API and classifying through Vertex AI, an agent calling a workflow through
// Gemini's function calling; a Gmail resource acting as a Workspace mailbox (delegation) searching, reading and
// replying with an attachment; a Teams Workflows webhook posting a card; an SDK resource made in the UI, its Python
// SDK installed and tested, called from a workflow (its prints in the run's log), a host it doesn't allow blocked.

const ai = JSON.parse(process.env.E2E_AI!) as { geminiUrl: string; geminiKey: string; vertexUrl: string }
const services = process.env.E2E_SERVICES!
const googleKey = process.env.E2E_IAP_KEY!

async function production(page: Page): Promise<string> {
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  return envs.find((e) => e.slug === 'production')!.id
}

async function resourceOf(page: Page, type: string, slug: string, config: unknown, secrets: unknown) {
  const created = await trpcMutate<{ id: string }>(page, 'resources.create', { type, name: slug, slug })
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

async function workflow(page: Page, slug: string, blocks: object[], extra: object = {}) {
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug, ...extra })
  const names = ['startTrigger', ...blocks.map((b) => (b as { name: string }).name)]
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges: names.slice(1).map((to, i) => ({ from: names[i], port: 'out', to })),
    },
  })
  return flow.id
}

interface Run {
  id: string
  status: string
  error: { code: string; message: string; block?: string } | null
}

async function runDraft(page: Page, slug: string, input: unknown): Promise<Run> {
  const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, {
    data: { input, version: 'draft' },
  })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run.id as string
  let run: Run | undefined
  await expect
    .poll(
      async () => {
        run = (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).run
        return run!.status
      },
      { timeout: 120_000 },
    )
    .toMatch(/succeeded|failed/)
  return run!
}

async function blockData(page: Page, runId: string, key: string) {
  return (await (await page.request.get(`/api/v1/runs/${runId}/blocks/${key}`)).json()).block
}

async function fakeState() {
  return (await (await fetch(`${services}/_fake/state`)).json()) as {
    gmail: { sent: { mailbox: string; kind: string; raw: string; threadId: string | null }[] }
    teams: { webhooks: { id: string; body: unknown }[] }
  }
}

test('Gemini: made and tested in the UI; extract, classify through Vertex, an agent', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  await page.goto('/resources')
  await page.getByRole('button', { name: 'New resource' }).click()
  await page.getByRole('combobox', { name: 'Type' }).selectOption('gemini')
  await page.getByLabel('Name').fill(`Gemini ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('ai-model')).toHaveValue('gemini-3.8-flash')
  await page.getByLabel('API key').fill(ai.geminiKey)
  await page.getByTestId('ai-base-url').fill(ai.geminiUrl)
  await page.getByText('Allow a private network address', { exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Signed in: 3 models, gemini-3.8-flash among them/)).toBeVisible()

  const geminiApi = await resourceOf(
    page,
    'gemini',
    `gemini_api_${stamp}`,
    { baseUrl: ai.geminiUrl, allowPrivateNetwork: true },
    { apiKey: ai.geminiKey },
  )
  void geminiApi
  await resourceOf(
    page,
    'gemini',
    `vertex_${stamp}`,
    {
      platform: 'vertex',
      identity: 'key',
      location: 'europe-west4',
      baseUrl: ai.vertexUrl,
      allowPrivateNetwork: true,
    },
    { serviceAccountKey: googleKey },
  )
  const schema = JSON.stringify({
    type: 'object',
    properties: { customer: { type: 'string' }, quantity: { type: 'integer' } },
    required: ['customer', 'quantity'],
  })
  await workflow(page, `m37-triage-${stamp}`, [
    query('order', `gemini_api_${stamp}`, {
      action: 'extract',
      input: '{{ startTrigger.data.email }}',
      schema,
    }),
    query('kind', `vertex_${stamp}`, {
      action: 'classify',
      input: 'LABEL=order {{ startTrigger.data.email }}',
      labels: 'order, question',
    }),
  ])
  const run = await runDraft(page, `m37-triage-${stamp}`, { email: 'Ada: 3 lamps please' })
  expect(run.error).toBeNull()
  expect((await blockData(page, run.id, 'order')).data).toEqual({
    customer: 'customer from the text',
    quantity: 1,
  })
  const kind = await blockData(page, run.id, 'kind')
  expect(kind.data).toEqual({ label: 'order', reason: 'reason from the text' })
  expect(kind.metadata).toMatchObject({ provider: 'gemini', costUsd: expect.any(Number) })
  const logs = (await (await page.request.get(`/api/v1/runs/${run.id}/logs`)).json()).logs as {
    message: string
  }[]
  expect(logs.filter((l) => l.message.startsWith('AI call: gemini gemini-3.8-flash'))).toHaveLength(2)

  // An agent: Gemini calls a published workflow through function calling.
  const lookup = await workflow(
    page,
    `m37-lookup-${stamp}`,
    [
      {
        name: 'reply',
        type: 'response',
        config: { status: '200', body: '{{ ({ name: "Ada Lovelace" }) }}' },
      },
    ],
    { description: 'Looks a customer up by email' },
  )
  await trpcMutate(page, 'releases.publish', { workflowId: lookup, draftRevision: 2 })
  await workflow(page, `m37-agent-${stamp}`, [
    query('agent', `gemini_api_${stamp}`, {
      action: 'agent',
      prompt: 'Who is {{ startTrigger.data.email }}?',
      tools: `m37-lookup-${stamp}`,
    }),
  ])
  const agentRun = await runDraft(page, `m37-agent-${stamp}`, { email: 'ada@example.com' })
  expect(agentRun.error).toBeNull()
  // The fake says "(signature lost)" when Gemini's thought signature didn't come back with the tool's result.
  expect((await blockData(page, agentRun.id, 'agent')).data.answer).toBe('Done: {"name":"Ada Lovelace"}')
})

test('Gmail: a Workspace mailbox through delegation searches, reads, replies with an attachment', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const id = await resourceOf(
    page,
    'gmail',
    `support_mail_${stamp}`,
    { auth: { type: 'delegation', mailbox: 'support@optiply.nl' } },
    { serviceAccountKey: googleKey },
  )
  await page.goto(`/resources/${id}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByTestId('gmail-mailbox')).toHaveValue('support@optiply.nl')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Gmail: support@optiply.nl/)).toBeVisible()

  await workflow(page, `m37-mail-${stamp}`, [
    query('found', `support_mail_${stamp}`, { action: 'search', q: 'from:ada order' }),
    query('mail', `support_mail_${stamp}`, { action: 'getMessage', id: '{{ found.data[0].id }}' }),
    query('file', `support_mail_${stamp}`, {
      action: 'getAttachment',
      messageId: '{{ mail.data.id }}',
      attachmentId: '{{ mail.data.attachments[0].attachmentId }}',
      filename: '{{ mail.data.attachments[0].filename }}',
      contentType: 'text/csv',
    }),
    query('reply', `support_mail_${stamp}`, {
      action: 'send',
      replyToMessage: '{{ mail.data.id }}',
      text: 'Thanks {{ startTrigger.data.name }}, it ships today.',
      attachments: '{{ file.data }}',
    }),
  ])
  const run = await runDraft(page, `m37-mail-${stamp}`, { name: 'Ada' })
  expect(run.error).toBeNull()
  expect((await blockData(page, run.id, 'mail')).data).toMatchObject({
    subject: 'Order 1042: 3 lamps',
    text: 'Please send 3 lamps.',
  })
  const sent = (await fakeState()).gmail.sent.at(-1)!
  expect(sent).toMatchObject({ mailbox: 'support@optiply.nl', kind: 'send', threadId: 'order-mail' })
  expect(sent.raw).toContain('Subject: Re: Order 1042: 3 lamps')
  expect(sent.raw).toContain('In-Reply-To: <order-1042@example.com>')
  expect(sent.raw).toContain('filename="order.csv"')
})

test('Teams: a Workflows webhook posts a card from the playground', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const id = await resourceOf(
    page,
    'msteams',
    `ops_teams_${stamp}`,
    { auth: { type: 'webhook' } },
    { webhookUrl: `${services}/teams-webhook/flow-1` },
  )
  await page.goto(`/resources/${id}`)
  await page.getByRole('button', { name: 'Query', exact: true }).click()
  await page.getByTestId('query-action').selectOption('postWebhook')
  const before = (await fakeState()).teams.webhooks.length
  await page.getByRole('button', { name: 'Run' }).click()
  // Neither text nor card: the query says so.
  await expect(page.getByText('Give the message text or a card')).toBeVisible()
  await page.getByTestId('query-field-text').fill(`Stock low ${stamp}`)
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText('Success')).toBeVisible()
  const posted = (await fakeState()).teams.webhooks
  expect(posted).toHaveLength(before + 1)
  expect(JSON.stringify(posted.at(-1)!.body)).toContain(`Stock low ${stamp}`)
})

test('an SDK resource: made in the UI, its Python SDK installed and tested, called from a workflow', async ({
  page,
}) => {
  test.skip(!process.env.E2E_SDK, 'needs Docker (the SDK runner and the package builder)')
  test.setTimeout(300_000)
  const sdk = JSON.parse(process.env.E2E_SDK!) as { apiUrl: string; token: string }
  await signIn(page)
  const stamp = Date.now().toString(36)
  const slug = `acme_${stamp}`
  await page.goto('/resources')
  await page.getByRole('button', { name: 'New resource' }).click()
  const type = page.getByRole('combobox', { name: 'Type' })
  await expect(type.locator('optgroup[label="APIs"] option')).toContainText(['SDK (Python or JavaScript)'])
  await type.selectOption('sdk')
  await page.getByLabel('Name').fill(slug)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('sdk-language')).toHaveValue('python')
  await page.getByTestId('sdk-packages').fill('acme-py==3.0.0')
  await page.getByTestId('sdk-base-url').fill(sdk.apiUrl)
  await page.getByText('Allow a private network address', { exact: true }).click()
  await page.getByRole('textbox', { name: /^Token/ }).fill(sdk.token)
  // The setup code, replacing the template.
  const setup = page.getByTestId('sdk-setup').locator('.monaco-editor')
  await setup.click({ position: { x: 200, y: 10 } })
  await expect(setup).toHaveClass(/focused/)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(
    'import acme_py\n\n\ndef client(token, base_url):\n    return acme_py.Acme(token, base_url)\n',
  )
  await expect(setup.locator('.view-lines')).toContainText('acme_py.Acme(token, base_url)')
  await expect(setup.locator('.view-lines')).not.toContainText('acme_sdk')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(
    page.getByText(/The client \(acme_py.Acme\) has 3 members; installed acme-py 3.0.0/),
  ).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('body')).not.toContainText(sdk.token)

  await workflow(page, `m37-sdk-${stamp}`, [
    query('orders', slug, { action: 'call', method: 'orders', args: '["{{ startTrigger.data.status }}"]' }),
    query('me', slug, {
      action: 'code',
      code: 'print("token length", len(token))\nreturn client.get(params["path"])',
      params: '{"path": "/me"}',
    }),
  ])
  const run = await runDraft(page, `m37-sdk-${stamp}`, { status: 'open' })
  expect(run.error).toBeNull()
  expect((await blockData(page, run.id, 'orders')).data).toEqual([
    { id: 1042, status: 'open', customer: 'Ada' },
  ])
  expect((await blockData(page, run.id, 'me')).data).toEqual({ path: '/me' })
  const logs = (await (await page.request.get(`/api/v1/runs/${run.id}/logs`)).json()).logs as {
    message: string
  }[]
  expect(logs.map((l) => l.message)).toEqual(
    expect.arrayContaining(['GET /orders?status=open', 'token length 16']),
  )

  // A host the resource doesn't name: blocked, and the block says so.
  await workflow(page, `m37-sdk-out-${stamp}`, [
    query('out', slug, {
      action: 'code',
      code: 'import urllib.request\nreturn urllib.request.urlopen("https://example.com", timeout=5).status',
    }),
  ])
  const blocked = await runDraft(page, `m37-sdk-out-${stamp}`, {})
  expect(blocked.status).toBe('failed')
  expect(blocked.error?.message).toContain('Blocked: example.com:443')
})
