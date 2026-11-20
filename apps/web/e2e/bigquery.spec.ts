import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

// BigQuery's sign-in choice: a service account key, or Google OAuth with each person's own account. Connecting at
// Google itself isn't driven here (no fake Google consent and BigQuery API in e2e): the connector and server tests
// cover the token and the redirect.

test('a BigQuery resource signs in with a key or with each person’s Google account', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const { id } = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'bigquery',
    name: `Warehouse ${stamp}`,
    slug: `warehouse_${stamp}`,
  })
  await page.goto(`/resources/${id}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  await test.step('a service account key by default', async () => {
    await expect(page.getByTestId('service-auth')).toHaveValue('serviceAccount')
    await expect(page.getByText('Service account key', { exact: true })).toBeVisible()
    await expect(page.getByText("Defaults to the key's project.")).toBeVisible()
  })

  await test.step('OAuth: the Google app’s fields, the redirect URI, and the project it needs', async () => {
    await page.getByTestId('service-auth').selectOption('oauth')
    await expect(page.getByText('Service account key', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Redirect URI')).toBeVisible()
    await expect(page.getByLabel('Scopes')).toHaveValue(
      'openid email https://www.googleapis.com/auth/bigquery',
    )
    await expect(page.getByTestId('bigquery-oauth-note')).toContainText('BigQuery Job User')
    await expect(page.getByText('Required with OAuth sign-in.')).toBeVisible()
    await page.getByTestId('oauth-client-id').fill(`${stamp}.apps.googleusercontent.com`)
    await page.getByLabel('Client secret').fill(`GOCSPX-${stamp}-secret`)
    await page.getByLabel('Accounts').selectOption('perUser')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Set the project queries run in')).toBeVisible()
    await page.getByTestId('bigquery-project').fill('optiply-dw')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(`GOCSPX-${stamp}-secret`)
  })

  await test.step('each person connects their own account before Test connection or a query', async () => {
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
    await expect(page.getByText('Not connected')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText('Connect your account to this resource to use it.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect your account' }).first()).toBeVisible()
  })

  await test.step('back to a key: its field returns, and saving without one says so', async () => {
    await page.getByTestId('service-auth').selectOption('serviceAccount')
    await expect(page.getByText('Service account key', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Add the service account key')).toBeVisible()
  })
})
