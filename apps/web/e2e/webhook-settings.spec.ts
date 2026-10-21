import { createHmac } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { block, signIn, trpcMutate, trpcQuery } from './helpers'

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
    await block(page, 'startTrigger').click()
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

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
