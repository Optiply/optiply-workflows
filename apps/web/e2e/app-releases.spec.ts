import { expect, test } from '@playwright/test'
import { acceptConfirms, signIn, trpcMutate, typeInto } from './helpers'

/**
 * An app's life cycle through the UI: created from the Apps page, published as v1.0.0, changed and published as
 * v1.1.0, seen by its viewer, rolled back to v1.0.0, shared with a group, and renamed.
 */
test('create, publish, roll back and share an app', async ({ page }) => {
  await acceptConfirms(page)
  await signIn(page)
  const name = `Release check ${Date.now()}`
  const group = await trpcMutate<{ id: string }>(page, 'groups.create', { name: `Viewers ${Date.now()}` })
  void group

  await page.getByRole('link', { name: 'Apps' }).click()
  await page.getByRole('button', { name: 'New app' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create app' }).click()
  await expect(page).toHaveURL(/\/apps\/release-check-\d+\/edit$/)
  const slug = page.url().split('/apps/')[1]!.replace('/edit', '')

  // Before the first release, the app's address says so and leads its editors to the editor.
  await page.goto(`/apps/${slug}`)
  await expect(page.getByText("This app hasn't been published yet")).toBeVisible()
  await page.getByRole('link', { name: 'Open the editor' }).click()
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}/edit$`))

  // v1.0.0
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  const valueField = page.locator('[data-testid$="/components/0/props/value"]')
  await typeInto(page, valueField, 'Hello v1')
  await expect(page.locator('[data-component="text1"]')).toHaveText('Hello v1')
  await expect(page.getByTestId('release-status')).toContainText('Not published')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()

  // v1.1.0
  await page.getByTestId('frame-text1').click()
  await typeInto(page, valueField, 'Hello v2')
  await expect(page.getByTestId('release-status')).toContainText('Unpublished changes')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByText('Minor · v1.1.0').click()
  await page.getByLabel('Release notes').fill('Says v2')
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.1.0')

  // The viewer shows the live release, with a way back to the editor.
  await page.getByRole('link', { name: 'Open app' }).click()
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}$`))
  await expect(page.locator('[data-component="text1"]')).toHaveText('Hello v2')
  await expect(page.getByText('v1.1.0')).toBeVisible()

  // Back in the editor (from the viewer), it has the latest draft: an edit saves without a conflict.
  await page.getByRole('link', { name: 'Edit', exact: true }).click()
  await page.getByTestId('frame-text1').click()
  await expect(page.getByTestId('inspector-text1')).toContainText('Hello v2')
  await typeInto(page, valueField, 'Hello v3')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByTestId('release-status')).toContainText('Unpublished changes')

  // Roll back from the editor's Releases.
  await page.getByRole('button', { name: 'Releases' }).first().click()
  const releases = page.getByTestId('releases')
  await expect(releases.getByRole('listitem')).toHaveCount(2)
  await expect(releases).toContainText('Says v2')
  await releases
    .getByRole('listitem')
    .filter({ hasText: 'v1.0.0' })
    .getByRole('button', { name: 'Make live' })
    .click()
  await expect(releases.getByRole('listitem').filter({ hasText: 'v1.0.0' })).toContainText('Live')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
  await page.goto(`/apps/${slug}`)
  await expect(page.locator('[data-component="text1"]')).toHaveText('Hello v1')

  // Share it with a group, and rename it.
  await page.goto(`/apps/${slug}/edit`)
  await page.getByRole('button', { name: 'Access' }).click()
  const access = page.getByRole('dialog')
  await access
    .getByLabel('Group')
    .selectOption({ label: (await access.getByLabel('Group').locator('option').nth(1).textContent())! })
  await expect(access.getByLabel('Environment')).toHaveCount(0)
  await access.getByRole('button', { name: 'Grant' }).click()
  await expect(access.getByText('No grants yet.')).toBeHidden()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'App settings' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill(`${name} (renamed)`)
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('link', { name: 'Apps' }).click()
  const row = page.getByTestId(`app-${slug}`)
  await expect(row).toContainText(`${name} (renamed)`)
  await expect(row).toContainText('Live')
})
