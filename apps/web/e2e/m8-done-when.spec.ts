import { expect, type Page, test } from '@playwright/test'
import { openDebug, openEditorPanel, signIn, trpcMutate, typeInto } from './helpers'

/**
 * M8's done-when, in the browser: build a CRUD app on a Postgres table with an editable Table and a save query.
 * The table is made through the Database API (M7 proves its UI); everything after that is the app builder: a
 * query reading the table, a Table showing it with an editable column, a save query over the table's changeset
 * that re-reads the table when it succeeds, the Table's save wired to it, publishing, and a person editing a cell
 * in the published app and saving it to the database.
 */
test('build a CRUD app on a Postgres table with an editable Table and a save query', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const table = `stock_${Date.now().toString(36)}`
  let environmentId = ''

  await test.step('a Postgres table with rows (the managed database)', async () => {
    await signIn(page)
    const envs = await (await page.request.get('/api/trpc/environments.list')).json()
    environmentId = envs.result.data.json.find((e: { slug: string }) => e.slug === 'production').id
    await trpcMutate(page, 'database.createTable', {
      environmentId,
      name: table,
      columns: [
        { name: 'name', type: 'text', nullable: false },
        { name: 'stock', type: 'integer' },
      ],
    })
    for (const [name, stock] of [
      ['Widget', 5],
      ['Gadget', 12],
      ['Sprocket', 0],
    ] as const) {
      await trpcMutate(page, 'database.insertRow', { environmentId, table, values: { name, stock } })
    }
  })

  await test.step('a new app', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Apps' }).click()
    await page.getByRole('button', { name: 'New app' }).click()
    await page.getByLabel('Name', { exact: true }).fill(`Stock ${table}`)
    await page.getByRole('button', { name: 'Create app' }).click()
    await expect(page).toHaveURL(/\/edit$/)
  })

  await test.step('a query reading the table', async () => {
    await openEditorPanel(page, 'Code')
    await page.getByTitle('Add a resource query').click()
    await rename(page, page.getByTestId('query-query1'), 'products')
    await typeInto(
      page,
      page.locator('[data-testid$="/queries/0/query/sql"]'),
      `select id, name, stock from ${table} order by id`,
    )
    await expect(page.getByTestId('result-products')).toContainText('3 rows', { timeout: 15_000 })
  })

  await test.step('a Table showing it, with stock editable', async () => {
    await openEditorPanel(page, 'Add components')
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    const inspector = page.getByTestId('inspector-table1')
    await typeInto(
      page,
      inspector.locator('[data-testid$="/components/0/props/data"]'),
      '{{ products.data }}',
    )
    await expect(page.locator('[data-component="table1"]').getByRole('row')).toHaveCount(4)
    await inspector.getByRole('button', { name: 'From data' }).click()
    // Columns are a list since M24; this types them as JSON.
    await inspector.getByRole('button', { name: 'Edit as JSON' }).click()
    await typeInto(
      page,
      inspector.locator('[data-testid$="/components/0/props/columns"]'),
      '[{"key": "id"}, {"key": "name", "label": "Product"}, {"key": "stock", "label": "In stock", "editable": true}]',
    )
    await expect(
      page.locator('[data-component="table1"]').getByRole('columnheader', { name: 'In stock' }),
    ).toBeVisible()
  })

  await test.step('a save query over the changeset, re-reading the table when it succeeds', async () => {
    await openEditorPanel(page, 'Code')
    await page.getByTitle('Add a resource query').click()
    const query = page.getByTestId('query-query1')
    await rename(page, query, 'save_stock')
    const editor = page.getByTestId('query-save_stock')
    await editor.getByLabel('Run').selectOption('manual')
    await typeInto(
      page,
      page.locator('[data-testid$="/queries/1/query/sql"]'),
      `update ${table} t set stock = x.stock from jsonb_to_recordset({{ table1.changesetArray }}::jsonb) as x(id bigint, stock integer) where t.id = x.id`,
    )
    await editor.getByRole('button', { name: 'Add handler' }).click()
    // A new handler starts as "on success → trigger" the first query: products, which is what's wanted.
    await expect(editor.getByTestId('handler-success-0')).toContainText('trigger products')
  })

  await test.step("the Table's save runs it", async () => {
    await page.getByTestId('frame-table1').click()
    const inspector = page.getByTestId('inspector-table1')
    await inspector.getByRole('button', { name: 'Add handler' }).click()
    await inspector.getByLabel('Event', { exact: true }).selectOption('save')
    await inspector.getByLabel('Query', { exact: true }).selectOption('save_stock')
    await expect(inspector.getByTestId('handler-save-0')).toContainText('trigger save_stock')
  })

  await test.step('publish', async () => {
    await openDebug(page, 'Problems')
    await expect(page.getByText('No problems.')).toBeVisible()
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByTestId('publish-confirm').click()
    await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
  })

  await test.step('edit a cell in the published app and save it', async () => {
    await page.getByRole('link', { name: 'Open app' }).click()
    // The editor's canvas has a table1 too, with the same rows: wait for the viewer (its Edit link) before editing,
    // or a slow runner edits the editor's table and the viewer then opens without the change.
    await expect(page).toHaveURL(/\/apps\/[^/?]+(\?|$)/)
    await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeVisible()
    const grid = page.getByRole('grid', { name: 'table1' })
    await expect(grid.getByRole('row')).toHaveCount(4)
    // Only the editable column edits.
    await grid.locator('[data-row="0"] [data-column="name"]').dblclick()
    await expect(page.getByLabel('Cell value')).toHaveCount(0)
    await grid.locator('[data-row="0"] [data-column="stock"]').dblclick()
    await page.getByLabel('Cell value').fill('42')
    await page.getByLabel('Cell value').press('Enter')
    await expect(page.getByText('1 changed row')).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('1 changed row')).toBeHidden()
    await expect(grid.locator('[data-row="0"] [data-column="stock"]')).toHaveText('42')
  })

  await test.step('the database has it', async () => {
    const res = await page.request.get(
      `/api/trpc/database.rows?input=${encodeURIComponent(JSON.stringify({ json: { environmentId, table } }))}`,
    )
    const rows = (await res.json()).result.data.json.rows as { name: string; stock: number }[]
    expect(rows.map((r) => [r.name, Number(r.stock)])).toEqual([
      ['Widget', 42],
      ['Gadget', 12],
      ['Sprocket', 0],
    ])
    expect(errors).toEqual([])
  })
})

/** Renames a query or component through the name field inside `scope`. */
async function rename(page: Page, scope: ReturnType<Page['getByTestId']>, name: string) {
  const field = scope.getByLabel('Name', { exact: true })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByTestId(`query-${name}`)).toBeVisible()
}
