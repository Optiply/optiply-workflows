import { expect, test } from '@playwright/test'
import { clickEmptyCanvas, signIn } from './helpers'

/**
 * M23 step 3: a workflow's Python packages in its Settings, checked line by line, saved with the draft. (Installing
 * them comes with the builder; this needs no code executor.)
 */
test("a workflow's Python packages in its settings", async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(`Packages ${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await clickEmptyCanvas(page)
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Settings', exact: true }).click()

  const packages = panel.getByLabel('Python packages')
  await packages.fill('polars==1.9.0\n\n-e git+https://github.com/x/y\nPolars>=1')
  const problems = panel.getByTestId('requirement-problems')
  await expect(problems).toContainText(
    '-e git+https://github.com/x/y: pip options (like -e or --index-url) are not allowed',
  )
  await expect(problems).toContainText('Polars>=1: "Polars" is already on line 1')
  await panel.getByRole('button', { name: 'Problems', exact: true }).click()
  await expect(panel).toContainText('pip options')
  await panel.getByRole('button', { name: 'Settings', exact: true }).click()

  await packages.fill('polars==1.9.0\nopenpyxl>=3.1')
  await expect(problems).toHaveCount(0)
  // A run timeout set and cleared again leaves the packages alone.
  const timeout = panel.getByPlaceholder('15')
  await timeout.fill('5')
  await timeout.fill('')
  await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()

  await page.reload()
  await clickEmptyCanvas(page)
  await panel.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(panel.getByLabel('Python packages')).toHaveValue('polars==1.9.0\nopenpyxl>=3.1')
  await expect(panel.getByPlaceholder('15')).toHaveValue('')
})
