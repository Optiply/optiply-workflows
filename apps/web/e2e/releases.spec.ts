import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { acceptConfirms, block, field, signIn, trpcMutate, typeInto } from './helpers'

/**
 * M4 end to end: turn on a workflow's webhook in the editor, publish v1.0.0, create an API key in Settings and call
 * the webhook with it (from a client without the browser's cookies); publish a change as v1.1.0 and see the webhook
 * answer with it; roll back to v1.0.0 from the Releases tab and see the old answer again.
 */
test('publish, call the webhook with an API key, and roll back', async ({ page, request }) => {
  await acceptConfirms(page)
  const suffix = Date.now().toString(36)
  let workflowId = ''
  let apiKey = ''

  await test.step('a workflow with a code block and a Response block', async () => {
    await signIn(page)
    const created = await trpcMutate<{ id: string }>(page, 'workflows.create', {
      slug: `greeter-${suffix}`,
      name: `Greeter ${suffix}`,
    })
    workflowId = created.id
    await trpcMutate(page, 'workflows.saveDraft', {
      id: workflowId,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger', config: { testInput: { name: 'Ada' } } },
          { name: 'greet', type: 'code', config: { code: 'return "Hello " + startTrigger.data.name' } },
          {
            name: 'reply',
            type: 'response',
            config: { body: '{"greeting": {{ greet.data }}, "lang": {{ startTrigger.pathParams.lang }}}' },
          },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'greet' },
          { from: 'greet', port: 'out', to: 'reply' },
        ],
      },
    })
    await page.goto(`/workflows/${workflowId}`)
    await expect(page.getByTestId('release-status')).toContainText('Not published')
  })

  await test.step('turn on the webhook with an alias, and publish v1.0.0', async () => {
    await block(page, 'startTrigger').click()
    const webhook = page.getByTestId('webhook-trigger')
    await webhook.getByLabel('Enabled').check()
    await webhook.getByPlaceholder('orders/:orderId').fill(`greet-${suffix}/:lang`)
    await expect(webhook).toContainText(`/api/v1/hooks/greet-${suffix}/:lang`)
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()

    await publish(page, 'First release')
    await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
    await expect(page.getByTestId('release-status')).not.toContainText('Unpublished changes')
  })

  await test.step('create an API key in Settings and call the webhook with it', async () => {
    await page.goto('/settings/api-keys')
    await page.getByRole('button', { name: 'New API key' }).click()
    await page.getByLabel('Name').fill(`e2e ${suffix}`)
    await page.getByRole('button', { name: 'Create key' }).click()
    apiKey = (await page.getByTestId('new-api-key-value').innerText()).trim()
    expect(apiKey).toMatch(/^ow_/)

    expect(await greet(request, suffix, apiKey)).toEqual({ greeting: 'Hello Ada', lang: 'en' })
    const noKey = await request.post(`/api/v1/hooks/greet-${suffix}/en`, { data: { name: 'Ada' } })
    expect(noKey.status()).toBe(401)
  })

  await test.step('publish a change as v1.1.0: the webhook answers with it', async () => {
    await page.goto(`/workflows/${workflowId}`)
    await block(page, 'greet').click()
    await typeInto(page, field(page, 'greet', 'code.js'), 'return "Hi " + startTrigger.data.name')
    await expect(page.getByTestId('release-status')).toContainText('Unpublished changes')
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()

    await publish(page, 'Friendlier', 'Minor · v1.1.0')
    await expect(page.getByTestId('release-status')).toContainText('Live v1.1.0')
    expect(await greet(request, suffix, apiKey)).toEqual({ greeting: 'Hi Ada', lang: 'en' })
  })

  await test.step('roll back to v1.0.0 from the Releases tab', async () => {
    await page.getByTestId('release-status').click()
    const releases = page.getByTestId('releases')
    await expect(releases.locator('li')).toHaveCount(2)
    await releases.getByRole('button', { name: 'Make live' }).click()
    await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
    // The draft is v1.1.0's code, which is no longer what's live.
    await expect(page.getByTestId('release-status')).toContainText('Unpublished changes')
    expect(await greet(request, suffix, apiKey)).toEqual({ greeting: 'Hello Ada', lang: 'en' })
  })

  await test.step('compare v1.1.0 with v1.0.0 (M24): the code block’s line diff', async () => {
    const releases = page.getByTestId('releases')
    await releases
      .locator('li')
      .filter({ hasText: 'v1.1.0' })
      .getByRole('button', { name: 'Compare' })
      .click()
    const compare = page.getByRole('dialog', { name: 'Compare' }).getByTestId('compare')
    const blocks = compare.getByRole('region', { name: 'Blocks' })
    await expect(blocks).toContainText('greet')
    await expect(blocks.getByTestId('file-diff')).toContainText('+return "Hi " + startTrigger.data.name')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Compare' })).toBeHidden()
  })
})

/** Publishes from the header's Publish dialog, optionally picking a version choice by its label. */
async function publish(page: Page, notes: string, version?: string) {
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  if (version) await dialog.getByText(version, { exact: true }).click()
  await dialog.locator('textarea').fill(notes)
  await page.getByTestId('publish-confirm').click()
  await expect(dialog).toBeHidden()
}

/** Calls the webhook's alias the way another system would: no cookies, just the API key. */
async function greet(request: APIRequestContext, suffix: string, apiKey: string) {
  const res = await request.post(`/api/v1/hooks/greet-${suffix}/en`, {
    headers: { 'x-api-key': apiKey },
    data: { name: 'Ada' },
  })
  expect(res.status()).toBe(200)
  expect(res.headers()['x-run-id']).toMatch(/^[0-9a-f-]{36}$/)
  return res.json()
}
