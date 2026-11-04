import { createHmac } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { block, field, openRail, signIn, trpcMutate, trpcQuery, typeInto } from './helpers'

/**
 * M15 step 6a: a webhook's authentication, rate limit and environments set in the trigger panel, and a call the
 * live webhook refused shown there with its reason.
 */
test('sign a webhook with GitHub, and see a forged call refused', async ({ page, request }) => {
  const suffix = Date.now().toString(36)
  const secretName = `GH_SECRET_${suffix.toUpperCase()}`
  let workflowId = ''

  await test.step('a secret config var and a workflow', async () => {
    await signIn(page)
    const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
    const secret = await trpcMutate<{ id: string }>(page, 'configVars.create', {
      name: secretName,
      isSecret: true,
    })
    await trpcMutate(page, 'configVars.setValue', {
      configVarId: secret.id,
      environmentId: envs.find((e) => e.isDefault)!.id,
      value: 'the-real-secret',
    })
    workflowId = (
      await trpcMutate<{ id: string }>(page, 'workflows.create', {
        slug: `signed-${suffix}`,
        name: `Signed ${suffix}`,
      })
    ).id
    await trpcMutate(page, 'workflows.saveDraft', {
      id: workflowId,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'reply', type: 'response', config: { status: '200', body: '{{ "ok" }}' } },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
      },
    })
  })

  await test.step('choose a GitHub signature, its secret and a limit in the panel', async () => {
    await page.goto(`/workflows/${workflowId}`)
    await openRail(page, 'triggers')
    const webhook = page.getByTestId('webhook-trigger')
    await webhook.getByLabel('Enabled').check()
    await expect(webhook.getByText('X-Api-Key: <your API key>')).toBeVisible()

    await webhook.getByLabel('Authentication').selectOption('public')
    await expect(webhook.getByRole('note')).toContainText('Anyone who knows the URL can start this workflow')

    await webhook.getByLabel('Authentication').selectOption('signature')
    await expect(webhook).toContainText('Choose the secret config var that holds the signing secret')
    await webhook.getByLabel('Provider').selectOption('github')
    await webhook.getByLabel('Signing secret').selectOption(secretName)
    await expect(webhook).not.toContainText('Choose the secret config var')
    await expect(webhook).toContainText('Checks the x-hub-signature-256 header.')
    await expect(webhook.getByText('x-hub-signature-256: <signature>')).toBeVisible()
    await expect(webhook.getByText('X-Api-Key')).toHaveCount(0)
    // GitHub's delivery id is the idempotency header unless another is named.
    await expect(webhook.getByLabel('Idempotency header')).toHaveAttribute('placeholder', 'x-github-delivery')

    await webhook.getByLabel('Requests').fill('5')
    await saved(page)
    const draft = await trpcQuery<{ draftDefinition: { triggers: { webhook: unknown } } }>(
      page,
      'workflows.get',
      {
        id: workflowId,
      },
    )
    expect(draft.draftDefinition.triggers.webhook).toEqual({
      enabled: true,
      auth: { type: 'signature', preset: 'github', secret: secretName },
      rateLimit: { requests: 5, windowSeconds: 60 },
    })
  })

  await test.step('publish; a forged call is refused and listed with its reason', async () => {
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('textarea').fill('Signed')
    await page.getByTestId('publish-confirm').click()
    await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')

    const body = '{"action":"opened"}'
    const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const url = `/api/v1/workflows/signed-${suffix}/webhook`
    const headers = { 'content-type': 'application/json' }
    const forged = await request.post(url, {
      headers: { ...headers, 'x-hub-signature-256': sign('a-guess') },
      data: body,
    })
    expect(forged.status()).toBe(401)
    const real = await request.post(url, {
      headers: { ...headers, 'x-hub-signature-256': sign('the-real-secret') },
      data: body,
    })
    expect(real.status()).toBe(200)

    const refused = page.getByTestId('webhook-rejections')
    await refused.getByTitle('Refresh').click()
    await expect(refused.locator('li')).toHaveCount(1)
    await expect(refused.locator('li')).toContainText("Signature didn't match")
    await expect(refused.locator('li')).toContainText('401')
  })
})

/**
 * M15 step 6b: a body schema drafted from the test input, half-typed JSON left unsaved, and completions for
 * `startTrigger.data` following the schema.
 */
test('draft a body schema, and complete startTrigger.data from it', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await signIn(page)
  const workflowId = (
    await trpcMutate<{ id: string }>(page, 'workflows.create', {
      slug: `schema-${suffix}`,
      name: `Schema ${suffix}`,
    })
  ).id
  await trpcMutate(page, 'workflows.saveDraft', {
    id: workflowId,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        {
          name: 'startTrigger',
          type: 'startTrigger',
          config: { testInput: { orderId: 7, lines: [{ sku: 'A' }] } },
        },
        { name: 'code1', type: 'code', config: { code: 'return 1' } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'code1' }],
      triggers: { webhook: { enabled: true } },
    },
  })
  const draftSchema = async () =>
    (
      await trpcQuery<{ draftDefinition: { triggers: { webhook: { bodySchema?: unknown } } } }>(
        page,
        'workflows.get',
        {
          id: workflowId,
        },
      )
    ).draftDefinition.triggers.webhook.bodySchema

  await page.goto(`/workflows/${workflowId}`)
  await openRail(page, 'triggers')
  const schemaField = page.getByTestId('body-schema')
  await schemaField.getByRole('button', { name: 'Draft from the test input' }).click()
  await saved(page)
  const drafted = {
    type: 'object',
    properties: {
      orderId: { type: 'integer' },
      lines: {
        type: 'array',
        items: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      },
    },
    // The test input comes back from jsonb, which orders keys shortest first.
    required: ['lines', 'orderId'],
  }
  expect(await draftSchema()).toEqual(drafted)

  // A typo that breaks the JSON isn't saved: the stored schema stays the drafted one. (Emptying the field is
  // "no schema", which is saved.)
  const schemaEditor = field(page, 'startTrigger', 'body-schema.json').locator('.monaco-editor')
  await schemaEditor.locator('.view-lines').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' x')
  await expect(schemaField).toContainText('Not valid JSON yet (not saved)')
  await saved(page)
  expect(await draftSchema()).toEqual(drafted)
  await typeInto(page, field(page, 'startTrigger', 'body-schema.json'), JSON.stringify(drafted))
  await expect(schemaField).not.toContainText('Not valid JSON yet')

  // Completions in a code block follow the schema.
  await block(page, 'code1').click()
  const code = field(page, 'code1', 'code.js').locator('.monaco-editor')
  await typeInto(page, field(page, 'code1', 'code.js'), 'return startTrigger.data.')
  await code.locator('.view-lines').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('End')
  await page.keyboard.press('Control+Space')
  // The visible one: the body schema's JSON editor keeps a (hidden) suggest widget of its own.
  const suggestions = page.locator('.suggest-widget.visible')
  await expect(suggestions).toContainText('orderId')
  await expect(suggestions).toContainText('lines')
})

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
