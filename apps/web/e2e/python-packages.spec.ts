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
  // Undo and redo show in the field (it follows the draft, not only its own typing).
  await packages.fill('polars==1.9.0\nopenpyxl>=3.1\nnumpy')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(packages).toHaveValue('polars==1.9.0\nopenpyxl>=3.1')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(packages).toHaveValue('polars==1.9.0\nopenpyxl>=3.1\nnumpy')
  await packages.fill('polars==1.9.0\nopenpyxl>=3.1')
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

test('installing the packages from the settings, and why it failed', async ({ page }) => {
  test.skip(!process.env.E2E_PYTHON_PACKAGES, 'needs the package builder (Docker)')
  await signIn(page)
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(`Install ${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await clickEmptyCanvas(page)
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Settings', exact: true }).click()
  const state = panel.getByTestId('packages-state')

  // Requirements only this run asks for (the specifier changes nothing): nothing has installed them before.
  await panel.getByLabel('Python packages').fill(`owtest-a\nowtest-b!=0.0.${Date.now()}`)
  await expect(state).toContainText('Not installed yet')
  await state.getByRole('button', { name: 'Install now' }).click()
  await expect(state).toContainText('Installed: owtest-a==1.0.0, owtest-b==1.0.0', { timeout: 60_000 })

  await panel.getByLabel('Python packages').fill('owtest-missing')
  await expect(state).toContainText('Not installed yet')
  await state.getByRole('button', { name: 'Install now' }).click()
  await expect(state).toContainText('Install failed', { timeout: 60_000 })
  await state.getByText("pip's output").click()
  await expect(state.locator('pre')).toContainText('owtest-missing')
})
