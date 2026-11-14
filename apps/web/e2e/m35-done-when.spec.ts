import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

// M35's done-when (architecture.md §2.38): an Anthropic resource (the fake) made and tested in the UI; a workflow
// extracting an order from an email, classifying it and summarizing it, the run view showing tokens and cost; an agent
// calling a "look up customer" workflow and answering with what it returned (its child run linked); the run's budget
// stopping a second call; an OpenAI-compatible resource doing the same extract; an app's AI query.

const ai = JSON.parse(process.env.E2E_AI!) as {
  anthropicUrl: string
  anthropicKey: string
  openaiUrl: string
  openaiKey: string
}

const ORDER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { customer: { type: 'string' }, quantity: { type: 'integer' } },
  required: ['customer', 'quantity'],
  additionalProperties: false,
})

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

/** A draft workflow of blocks in a row after the Start trigger. */
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
      { timeout: 60_000 },
    )
    .toMatch(/succeeded|failed/)
  return run!
}

async function blockData(page: Page, runId: string, key: string) {
  return (await (await page.request.get(`/api/v1/runs/${runId}/blocks/${key}`)).json()).block
}

/** Opens the run in its workflow's editor and shows a block's result. */
async function showBlock(page: Page, workflowId: string, runId: string, block: string) {
  await page.goto(`/workflows/${workflowId}?run=${runId}`)
  await page
    .getByTestId('run-blocks')
    .getByRole('button', { name: new RegExp(block) })
    .click()
  return page.getByTestId('block-result')
}

test('an Anthropic resource made and tested in the UI', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  await page.goto('/resources')
  await page.getByRole('button', { name: 'New resource' }).click()
  const type = page.getByRole('combobox', { name: 'Type' })
  await expect(type.locator('optgroup[label="AI"] option')).toHaveText([
    'Anthropic',
    'OpenAI-compatible',
    'Gemini',
  ])
  await type.selectOption('anthropic')
  await page.getByLabel('Name').fill(`Claude ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByTestId('ai-model')).toHaveValue('claude-sonnet-5-5')
  await page.getByLabel('API key').fill(ai.anthropicKey)
  await page.getByTestId('ai-base-url').fill(ai.anthropicUrl)
  await page.getByTestId('ai-budget').fill('50000')
  await page.getByText('Allow a private network address', { exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Signed in: 3 models, claude-sonnet-5-5 among them/)).toBeVisible()
})

test('a workflow extracts, classifies and summarizes an email; an agent calls a workflow; budgets stop calls', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const claude = `m35_claude_${stamp}`
  const tight = `m35_tight_${stamp}`
  const llm = `m35_llm_${stamp}`
  await resourceOf(
    page,
    'anthropic',
    claude,
    { baseUrl: ai.anthropicUrl, allowPrivateNetwork: true },
    {
      apiKey: ai.anthropicKey,
    },
  )
  await resourceOf(
    page,
    'anthropic',
    tight,
    { baseUrl: ai.anthropicUrl, allowPrivateNetwork: true, budgetTokens: 1, hidePrompts: true },
    { apiKey: ai.anthropicKey },
  )
  await resourceOf(
    page,
    'openai_compatible',
    llm,
    { baseUrl: ai.openaiUrl, model: 'fake-llm', inputPrice: 1, outputPrice: 2, allowPrivateNetwork: true },
    { apiKey: ai.openaiKey },
  )
  const triage = (resource: string) => [
    query('order', resource, {
      action: 'extract',
      input: '{{ startTrigger.data.email }}',
      schema: ORDER_SCHEMA,
    }),
    query('kind', resource, {
      action: 'classify',
      input: '{{ startTrigger.data.email }}',
      labels: 'order, complaint, question',
    }),
    query('gist', resource, { action: 'summarize', input: '{{ startTrigger.data.email }}', length: 'short' }),
  ]
  const email = 'LABEL=order Hi, Ada here: 3 lamps please'

  await test.step('extract, classify, summarize: typed data, a line per call, tokens and cost in the run view', async () => {
    const id = await workflow(page, `m35-triage-${stamp}`, triage(claude))
    const run = await runDraft(page, `m35-triage-${stamp}`, { email })
    expect(run.error).toBeNull()
    expect((await blockData(page, run.id, 'order')).data).toEqual({
      customer: 'customer from the text',
      quantity: 1,
    })
    expect((await blockData(page, run.id, 'kind')).data).toMatchObject({ label: 'order' })
    const logs = (await (await page.request.get(`/api/v1/runs/${run.id}/logs`)).json()).logs as {
      message: string
    }[]
    expect(logs.filter((l) => l.message.startsWith('AI call: anthropic claude-sonnet-5-5'))).toHaveLength(3)

    const result = await showBlock(page, id, run.id, 'order')
    const call = result.getByTestId('ai-call')
    await expect(call).toContainText('claude-sonnet-5-5 (Anthropic)')
    await expect(call).toContainText(/\d+ input \+ \d+ output tokens · \$0\.\d+/)
    await call.getByText('Prompts sent').click()
    await expect(call).toContainText('3 lamps please')
  })

  await test.step('an agent calls "look up customer" (its child run linked) and answers with what it returned', async () => {
    const lookup = await workflow(
      page,
      `m35-lookup-${stamp}`,
      [
        {
          name: 'reply',
          type: 'response',
          config: { status: '200', body: '{{ ({ name: "Ada Lovelace", tier: "gold" }) }}' },
        },
      ],
      { description: 'Looks a customer up by email' },
    )
    await trpcMutate(page, 'releases.publish', { workflowId: lookup, draftRevision: 2 })
    const id = await workflow(page, `m35-agent-${stamp}`, [
      query('agent', claude, {
        action: 'agent',
        instructions: 'You answer support questions.',
        prompt: 'Who is {{ startTrigger.data.email }}?',
        tools: `m35-lookup-${stamp}`,
      }),
    ])
    const run = await runDraft(page, `m35-agent-${stamp}`, { email: 'ada@example.com' })
    expect(run.error).toBeNull()
    const agent = await blockData(page, run.id, 'agent')
    expect(agent.data.answer).toBe('Done: {"name":"Ada Lovelace","tier":"gold"}')
    const children = (await (await page.request.get(`/api/v1/runs/${run.id}/children`)).json()).runs
    expect(children).toHaveLength(1)

    const result = await showBlock(page, id, run.id, 'agent')
    const steps = result.getByTestId('ai-steps')
    await expect(steps).toContainText(`m35-lookup-${stamp}`)
    await steps.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/workflows/${lookup}\\?run=${children[0].id}`))
  })

  await test.step("the run's budget stops a second call; prompts hidden", async () => {
    const id = await workflow(page, `m35-tight-${stamp}`, triage(tight))
    const run = await runDraft(page, `m35-tight-${stamp}`, { email })
    expect(run.status).toBe('failed')
    expect(run.error).toMatchObject({ code: 'ai_budget', block: 'kind' })
    const result = await showBlock(page, id, run.id, 'order')
    await expect(result.getByTestId('ai-call')).toContainText('Prompts hidden')
  })

  await test.step('an OpenAI-compatible resource does the same extract, priced with its own prices', async () => {
    await workflow(page, `m35-llm-${stamp}`, triage(llm).slice(0, 1))
    const run = await runDraft(page, `m35-llm-${stamp}`, { email })
    expect(run.error).toBeNull()
    const order = await blockData(page, run.id, 'order')
    expect(order.data).toEqual({ customer: 'customer from the text', quantity: 1 })
    expect(order.metadata).toMatchObject({
      provider: 'openai_compatible',
      model: 'fake-llm',
      costUsd: expect.any(Number),
    })
  })

  await test.step("an app's AI query", async () => {
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
      slug: `m35-inbox-${stamp}`,
      name: 'Inbox',
    })
    await trpcMutate(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [{ name: 'email', type: 'textInput', props: { label: 'Email' } }],
        queries: [
          {
            name: 'kind',
            kind: 'resource',
            resource: claude,
            query: { action: 'classify', input: '{{ email.value }}', labels: 'order, complaint' },
            run: 'manual',
          },
        ],
        layout: { email: { x: 0, y: 0, w: 4, h: 3 } },
      },
    })
    const result = await trpcMutate<{ ok: boolean; data: unknown }>(page, 'apps.runQuery', {
      appId: app.id,
      releaseId: null,
      query: 'kind',
      environmentId: await production(page),
      values: { ' email.value ': 'LABEL=complaint the lamp broke' },
    })
    expect(result).toMatchObject({ ok: true, data: { label: 'complaint' } })
  })
})
