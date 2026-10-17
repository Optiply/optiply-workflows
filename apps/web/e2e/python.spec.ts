import { expect, type Page, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, editorText, field, signIn, typeInto } from './helpers'

/**
 * M12 in the editor: a Python code block reads a query's rows, its syntax error shows before running, it runs on the
 * code executor, and renaming the query rewrites the Python.
 */
test.skip(!process.env.E2E_PYTHON, 'needs the code executor (Docker)')

test('a Python code block in the editor', async ({ page }) => {
  const python = () => field(page, 'python1', 'code.py')

  await test.step('build query → Python → response', async () => {
    await signIn(page)
    const suffix = Date.now().toString(36)
    await page.getByRole('button', { name: 'New workflow' }).click()
    await page.getByPlaceholder('Sync orders').fill(`Python ${suffix}`)
    await page.getByRole('button', { name: 'Create workflow' }).click()
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)

    await block(page, 'startTrigger').click()
    await addBlock(page, 'resource query')
    // Other specs add resources (REST ones too): pick the seeded Postgres.
    await page
      .getByTestId('side-panel')
      .getByRole('combobox', { name: /^Resource/ })
      .selectOption('shop_db')
    await typeInto(page, field(page, 'query1', 'query.sql'), 'select email, plan from customers order by id')

    await addBlock(page, 'Python code')
    await expect(block(page, 'python1')).toBeVisible()
    await expect(block(page, 'python1')).toContainText('python1')
    await expect(page.getByTestId('inspector-python1')).toContainText('Python')
    await expect(page.getByTestId('inspector-python1').getByLabel('Language')).toHaveValue('python')
  })

  await test.step("the executor's syntax check marks broken Python before running", async () => {
    // Balanced brackets: Monaco's Python mode closes an open one itself.
    await typeInto(page, python(), 'return [r["email"] for r in query1.data if]')
    await expect(python().locator('.squiggly-error')).not.toHaveCount(0, { timeout: 10_000 })
    await typeInto(page, python(), 'return [r["email"].upper() for r in query1.data if r.plan == "pro"]')
    await expect(python().locator('.squiggly-error')).toHaveCount(0, { timeout: 10_000 })

    await addBlock(page, 'response')
    await typeInto(page, field(page, 'response1', 'body.txt'), '{"emails": {{ python1.data }}}')
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await clickEmptyCanvas(page)
    await expect(page.getByTestId('side-panel')).toContainText('No problems found.')
  })

  await test.step('it runs on the code executor', async () => {
    await runAndExpect(page, 'ADA@EXAMPLE.COM')
    await expect(block(page, 'python1')).toHaveAttribute('data-status', 'succeeded')
  })

  await test.step('renaming the query rewrites the Python', async () => {
    // With the run panel open the canvas is shorter, and a block can sit under the minimap (bottom right), which then
    // takes a real click (it did, in full local runs). Dispatched on the block, the click still goes through React
    // Flow's own handler: it selects the block and shows its inspector.
    await block(page, 'query1').dispatchEvent('click')
    const name = page.getByTestId('block-name')
    await name.fill('customers')
    await name.press('Enter')
    await expect(block(page, 'customers')).toBeVisible()
    await block(page, 'python1').dispatchEvent('click')
    await expect
      .poll(() => editorText(python()))
      .toBe('return [r["email"].upper() for r in customers.data if r.plan == "pro"]')
    await runAndExpect(page, 'ADA@EXAMPLE.COM')
  })
})

/** Runs the workflow and waits for this run (not an earlier one) to reply with `text`. */
async function runAndExpect(page: Page, text: string) {
  const picker = page.getByLabel('Run', { exact: true })
  const previous = (await picker.count()) ? await picker.inputValue() : ''
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(picker).not.toHaveValue(previous)
  await expect(picker).not.toHaveValue('')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
  await panel.getByRole('button', { name: 'output' }).click()
  await expect(panel.getByTestId('run-output')).toContainText(text)
  await panel.getByRole('button', { name: 'blocks' }).click()
}
