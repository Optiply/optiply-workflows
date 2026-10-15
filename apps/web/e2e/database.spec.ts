import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/** A tRPC query as the signed-in user, returning its data. */
async function trpcQuery<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  const res = await page.request.get(`/api/trpc/${path}${qs}`)
  const body = await res.json()
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${JSON.stringify(body)}`)
  return body.result.data.json
}

const cell = (page: Page, row: number, column: string) =>
  page.getByTestId('grid-row').nth(row).locator(`[data-column="${column}"]`)

/**
 * M7: the Database page. A table made through the API shows up in the grid; cells are edited in place (and a
 * value that doesn't fit its type is refused on the spot), headers sort, filters narrow, columns hide, rows are
 * added through the form and deleted, and the export follows what's on screen.
 */
test('browse and edit a managed table in the grid', async ({ page }) => {
  const table = `fruit_${Date.now().toString(36)}`
  let environmentId = ''

  await test.step('a table with a few rows', async () => {
    await signIn(page)
    const status = await trpcQuery<{ environments: { id: string; slug: string }[] }>(
      page,
      'database.environments',
    )
    environmentId = status.environments.find((e) => e.slug === 'production')!.id
    await trpcMutate(page, 'database.createTable', {
      environmentId,
      name: table,
      columns: [
        { name: 'name', type: 'text', nullable: false },
        { name: 'stock', type: 'integer' },
        { name: 'organic', type: 'boolean' },
      ],
    })
    for (const [name, stock, organic] of [
      ['apple', 10, true],
      ['banana', 3, false],
      ['cherry', 25, true],
    ] as const) {
      await trpcMutate(page, 'database.insertRow', {
        environmentId,
        table,
        values: { name, stock, organic },
      })
    }
  })

  await test.step('the table opens in the grid', async () => {
    await page.getByRole('link', { name: 'Database' }).click()
    await page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: table }).click()
    await expect(page.getByTestId('row-count')).toHaveText('3 rows')
    await expect(cell(page, 0, 'name')).toHaveText('apple')
    await expect(cell(page, 1, 'organic')).toHaveText('false')
  })

  await test.step('a double click edits a cell; Enter saves it', async () => {
    await cell(page, 1, 'stock').dblclick()
    const editor = cell(page, 1, 'stock').locator('input')
    await editor.fill('42')
    await editor.press('Enter')
    await expect(cell(page, 1, 'stock')).toHaveText('42')
    // Saved, not just shown: a fresh read has it.
    const rows = await trpcQuery<{ rows: { name: string; stock: number }[] }>(page, 'database.rows', {
      environmentId,
      table,
    })
    expect(rows.rows.find((r) => r.name === 'banana')?.stock).toBe(42)
  })

  await test.step('a value that does not fit is refused on the spot, and Escape gives up', async () => {
    await cell(page, 0, 'stock').dblclick()
    const editor = cell(page, 0, 'stock').locator('input')
    await editor.fill('lots')
    await editor.press('Enter')
    await expect(page.getByRole('alert')).toContainText('invalid input syntax for type integer')
    await editor.press('Escape')
    await expect(cell(page, 0, 'stock')).toHaveText('10')
  })

  await test.step('keyboard: arrows move, Enter edits', async () => {
    await cell(page, 0, 'name').click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const editor = cell(page, 2, 'name').locator('input')
    await expect(editor).toBeFocused()
    await editor.fill('cherry pie')
    await editor.press('Enter')
    await expect(cell(page, 2, 'name')).toHaveText('cherry pie')
  })

  await test.step('a header click sorts', async () => {
    await page.getByRole('columnheader', { name: /stock/ }).getByRole('button').click()
    await expect(cell(page, 0, 'name')).toHaveText('apple')
    await page.getByRole('columnheader', { name: /stock/ }).getByRole('button').click()
    await expect(cell(page, 0, 'name')).toHaveText('banana')
    await expect(page.getByRole('columnheader', { name: /stock/ })).toHaveAttribute('aria-sort', 'descending')
  })

  await test.step('filters narrow the rows, and the export follows them', async () => {
    await page.getByRole('button', { name: 'Filter' }).click()
    const bar = page.getByTestId('filter-bar')
    await bar.getByLabel('Filter column').selectOption('organic')
    await bar.getByLabel('Filter comparison').selectOption('eq')
    await bar.getByLabel('Filter value').selectOption('true')
    await expect(page.getByTestId('row-count')).toHaveText('2 rows')
    const href = await page.getByRole('link', { name: 'Export CSV' }).getAttribute('href')
    const csv = await (await page.request.get(href!)).text()
    expect(csv.trim().split('\r\n')).toEqual([
      'id,name,stock,organic',
      '3,cherry pie,25,true',
      '1,apple,10,true',
    ])
    await bar.getByRole('button', { name: 'Remove filter' }).click()
    await expect(page.getByTestId('row-count')).toHaveText('3 rows')
  })

  await test.step('columns can be hidden', async () => {
    await page.getByRole('button', { name: 'Columns' }).click()
    await page.getByRole('checkbox', { name: 'organic' }).uncheck()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('columnheader', { name: /organic/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Columns (1 hidden)' })).toBeVisible()
  })

  await test.step('rows are added through the form, which names the field a problem is in', async () => {
    await page.getByRole('button', { name: 'Add row' }).click()
    const dialog = page.getByRole('dialog', { name: `Add a row to ${table}` })
    await dialog.getByLabel('stock').fill('7')
    await dialog.getByRole('button', { name: 'Add row' }).click()
    await expect(dialog.getByText('is required')).toBeVisible()
    await dialog.getByLabel('name').fill('date')
    await dialog.getByRole('button', { name: 'Add row' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('row-count')).toHaveText('4 rows')
  })

  await test.step('selected rows are deleted', async () => {
    const row = page.getByTestId('grid-row').filter({ hasText: 'banana' })
    await row.getByRole('checkbox', { name: 'Select row' }).check()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: 'Delete 1' }).click()
    await expect(page.getByTestId('row-count')).toHaveText('3 rows')
    await expect(page.getByTestId('grid-row').filter({ hasText: 'banana' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
    await page.screenshot({ path: 'test-results/database-grid.png' })
  })
})

/** Long tables load a page at a time as the grid scrolls, rendering only the rows on screen. */
test('loads more rows as the grid scrolls', async ({ page }) => {
  const table = `many_${Date.now().toString(36)}`
  await signIn(page)
  const status = await trpcQuery<{ environments: { id: string; slug: string }[] }>(
    page,
    'database.environments',
  )
  const environmentId = status.environments.find((e) => e.slug === 'production')!.id
  const csv = ['n', ...Array.from({ length: 350 }, (_, i) => String(i + 1))].join('\n')
  const spec = {
    environmentId,
    mode: 'create',
    table,
    delimiter: ',',
    columns: [{ source: 0, name: 'n', type: 'integer' }],
  }
  const res = await page.request.post('/api/v1/database/import', {
    headers: { 'content-type': 'application/x-ow-csv-import' },
    data: `${JSON.stringify(spec)}\n${csv}\n`,
  })
  expect(res.status(), await res.text()).toBe(200)

  await page.goto(`/database?env=production&table=${table}`)
  await expect(page.getByTestId('row-count')).toHaveText('350 rows · 100 loaded')
  // Only what's on screen (plus a margin) is in the page.
  expect(await page.getByTestId('grid-row').count()).toBeLessThan(80)
  await expect(async () => {
    await page.getByTestId('grid').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(page.getByTestId('row-count')).toHaveText('350 rows', { timeout: 1000 })
  }).toPass()
  // The last page made the list longer: scroll to its new end.
  await page.getByTestId('grid').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect(page.locator('[data-column="n"]').filter({ hasText: /^350$/ })).toBeVisible()
})
