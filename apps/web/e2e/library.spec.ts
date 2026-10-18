import { expect, test } from '@playwright/test'
import { signIn, typeInto } from './helpers'

/**
 * The Query Library through the UI (M14 step 3a): a library query created from the Library page, its SQL and a
 * parameter edited, run with the test value, published twice and rolled back.
 */
test('create, run, publish and roll back a library query', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await signIn(page)
  const name = `Plus one ${Date.now()}`

  await page.getByRole('link', { name: 'Library' }).click()
  await expect(page.getByRole('heading', { name: 'Query Library' })).toBeVisible()
  await page.getByRole('button', { name: 'New query' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create query' }).click()
  await expect(page).toHaveURL(/\/library\/plus_one_\d+$/)
  const slug = page.url().split('/library/')[1]!

  // A parameter with a test value, read by the SQL.
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Parameter 1 name').fill('n')
  await page.getByLabel('n test value').fill('41')
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int + 1 as x')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.getByTestId('library-run').getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('library-run')).toContainText('42')

  // A name the query doesn't declare is a problem, shown at once, and Publish waits for the fix.
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ m }}::int as x')
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int + 1 as x')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  // v1.0.0, then v1.1.0.
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int + 2 as x')
  await expect(page.getByTestId('release-status')).toContainText('Unpublished changes')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByLabel('Version').selectOption('minor')
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.1.0')

  // Roll back; the list shows what's live.
  await page.getByTestId('release-status').click()
  await page.getByTestId('releases').getByRole('button', { name: 'Make live' }).click()
  await expect(page.getByTestId('releases').locator('li').filter({ hasText: 'v1.0.0' })).toContainText('Live')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-used-by')).toContainText('No app uses it yet')
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await expect(page.getByTestId(`library-${slug}`)).toContainText('Live v1.0.0')
})
