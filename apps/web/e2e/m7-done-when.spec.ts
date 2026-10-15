import { expect, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, field, signIn, typeInto } from './helpers'

/**
 * M7's done-when, all in the browser: create a table on the Database page, import a CSV into it, and query it
 * from a workflow in the editor through the built-in optiply_db resource.
 */
test('create a table, import a CSV, and query it from a workflow', async ({ page }) => {
  const suffix = Date.now().toString(36)
  const table = `suppliers_${suffix}`

  await test.step('create a table', async () => {
    await signIn(page)
    await page.getByRole('link', { name: 'Database' }).click()
    await page.getByRole('button', { name: 'New table' }).click()
    const dialog = page.getByRole('dialog', { name: 'New table' })
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(table)
    await dialog.getByLabel('Column name').fill('name')
    await dialog.getByRole('checkbox', { name: 'Required' }).check()
    await dialog.getByRole('button', { name: 'Add column' }).click()
    await dialog.getByLabel('Column name').nth(1).fill('lead_days')
    await dialog.getByLabel('Column type').nth(1).selectOption('integer')
    await dialog.getByRole('button', { name: 'Create table' }).click()
    await expect(page.getByRole('heading', { name: table })).toBeVisible()
    await expect(page.getByText('No rows yet.')).toBeVisible()
  })

  await test.step('import a CSV into it', async () => {
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import CSV' })
    await dialog.getByLabel('CSV file').setInputFiles({
      name: 'suppliers.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name;lead_days\r\nAcme;12\r\nGlobex;3\r\nInitech;30\r\n'),
    })
    await expect(dialog.getByLabel('Target of column 1')).toHaveValue('name')
    await expect(dialog.getByLabel('Target of column 2')).toHaveValue('lead_days')
    await dialog.getByRole('button', { name: 'Import' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('row-count')).toHaveText('3 rows')
  })

  await test.step('query it from a workflow', async () => {
    await page.getByRole('link', { name: 'Workflows' }).click()
    await page.getByRole('button', { name: 'New workflow' }).click()
    await page.getByPlaceholder('Sync orders').fill(`Slow suppliers ${suffix}`)
    await page.getByRole('button', { name: 'Create workflow' }).click()
    await expect(block(page, 'startTrigger')).toBeVisible()

    await block(page, 'startTrigger').click()
    await typeInto(page, field(page, 'startTrigger', 'testInput.json'), '{"days": 10}')
    await addBlock(page, 'resource query')
    await expect(block(page, 'query1')).toBeVisible()
    const resource = page.getByTestId('side-panel').getByRole('combobox', { name: /^Resource/ })
    await resource.selectOption('optiply_db')
    await expect(page.getByTestId('side-panel')).toContainText(
      "The tables on the Database page, in the run's environment.",
    )
    await typeInto(
      page,
      field(page, 'query1', 'query.sql'),
      `select name, lead_days from ${table} where lead_days >= {{ startTrigger.data.days }} order by lead_days`,
    )
    await addBlock(page, 'response')
    await typeInto(page, field(page, 'response1', 'body.txt'), '{{ query1.data }}')
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await clickEmptyCanvas(page)
    await expect(page.getByTestId('side-panel')).toContainText('No problems found.')

    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
    await panel.getByRole('button', { name: 'output' }).click()
    const output = panel.getByTestId('run-output')
    await expect(output).toContainText('Acme')
    await expect(output).toContainText('Initech')
    await expect(output).not.toContainText('Globex')
  })
})
