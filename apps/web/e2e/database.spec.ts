import { expect, type Page, test } from '@playwright/test'
import { acceptConfirms, signIn, trpcMutate } from './helpers'

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
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Database' }).click()
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
    await acceptConfirms(page)
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

/** The schema editor and the import wizard: make a table, change its shape, and fill it from CSV files. */
test('make and change a table, and import CSV files into it', async ({ page }) => {
  const name = `crm_${Date.now().toString(36)}`
  const csvFile = (fileName: string, text: string) => ({
    name: fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(text),
  })
  await signIn(page)
  await page.goto('/database?env=production')

  await test.step('a new table with its columns', async () => {
    await page.getByRole('button', { name: 'New table' }).click()
    const dialog = page.getByRole('dialog', { name: 'New table' })
    // The field's hint is part of its accessible name.
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(name)
    await dialog.getByLabel('Column name').fill('email')
    await dialog.getByRole('checkbox', { name: 'Required' }).check()
    await dialog.getByRole('checkbox', { name: 'Unique' }).check()
    await dialog.getByRole('button', { name: 'Add column' }).click()
    await dialog.getByLabel('Column name').nth(1).fill('score')
    await dialog.getByLabel('Preset').nth(1).selectOption('integer')
    await dialog.getByLabel('Default').nth(1).selectOption('value')
    await dialog.getByLabel('Default value').fill('0')
    await dialog.getByRole('button', { name: 'Create table' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /email/ })).toBeVisible()
  })

  const schema = () => page.getByRole('dialog', { name: /^Table / })
  await test.step('columns are added, changed and deleted; the table is renamed', async () => {
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await schema().getByRole('button', { name: 'Add column' }).click()
    const add = page.getByRole('dialog', { name: `Add a column to ${name}` })
    await add.getByRole('textbox', { name: /^Name/ }).fill('joined')
    await add.getByRole('combobox', { name: /^Preset/ }).selectOption('date')
    await add.getByRole('button', { name: 'Add column' }).click()
    await expect(page.getByTestId('schema-column-joined')).toContainText('Date')

    await schema().getByRole('button', { name: 'Edit score' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit score' })
    await edit.getByRole('combobox', { name: /^Preset/ }).selectOption('number')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('schema-column-score')).toContainText('Number')
    await expect(page.getByTestId('schema-column-score')).toContainText('default 0')

    await acceptConfirms(page)
    await schema().getByRole('button', { name: 'Delete joined' }).click()
    await expect(page.getByTestId('schema-column-joined')).toHaveCount(0)

    await schema().getByRole('textbox', { name: /^Name/ }).fill(`${name}_v2`)
    await schema().getByRole('button', { name: 'Rename' }).click()
    await expect(page.getByRole('heading', { name: `${name}_v2` })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`table=${name}_v2`))
  })

  await test.step('a CSV is added to the open table, its columns mapped by name', async () => {
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import CSV' })
    await expect(dialog.getByLabel('Import into')).toHaveValue('append')
    await dialog
      .getByLabel('CSV file')
      .setInputFiles(csvFile('people.csv', 'email,score,ignored\na@x.nl,3.5,x\nb@x.nl,2,y\n'))
    await expect(dialog.getByLabel('Target of column 1')).toHaveValue('email')
    await expect(dialog.getByLabel('Target of column 2')).toHaveValue('score')
    await expect(dialog.getByLabel('Target of column 3')).toHaveValue('')
    await dialog.getByRole('button', { name: 'Import' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('row-count')).toHaveText('2 rows')
  })

  await test.step('a bad file imports nothing and says which line to fix', async () => {
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import CSV' })
    await dialog
      .getByLabel('CSV file')
      .setInputFiles(csvFile('more.csv', 'email,score\nc@x.nl,1\nd@x.nl,lots\n'))
    await expect(dialog.getByLabel('Target of column 2')).toHaveValue('score')
    await dialog.getByRole('button', { name: 'Import' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Nothing was imported.')
    await expect(dialog.getByRole('alert')).toContainText(
      'Line 3, score: invalid input syntax for type numeric',
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('row-count')).toHaveText('2 rows')
  })

  await test.step('a Dutch file becomes a new table, its types, delimiter and decimal commas guessed', async () => {
    await page.getByRole('button', { name: 'Import CSV' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import CSV' })
    const file = `prijzen_${Date.now().toString(36)}`
    await dialog
      .getByLabel('CSV file')
      .setInputFiles(
        csvFile(`${file}.csv`, 'Naam;Prijs;Datum\nKoffie;1,50;31-01-2026\nThee;2,25;01-02-2026\n'),
      )
    await expect(dialog.getByLabel('Table name')).toHaveValue(file)
    await expect(dialog.getByLabel('Delimiter')).toHaveValue(';')
    await expect(dialog.getByRole('checkbox', { name: 'Decimal comma (1.234,50)' })).toBeChecked()
    await expect(dialog.getByLabel('Type of column 2')).toHaveValue('decimal')
    await expect(dialog.getByLabel('Type of column 3')).toHaveValue('date')
    await expect(dialog.getByTestId('import-preview')).toContainText('Koffie')
    await dialog.getByRole('button', { name: 'Import' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: file })).toBeVisible()
    await expect(cell(page, 0, 'prijs')).toHaveText('1.50')
    await expect(cell(page, 1, 'datum')).toHaveText('2026-02-01')
  })

  await test.step('a table is deleted', async () => {
    await page
      .getByRole('navigation', { name: 'Tables' })
      .getByRole('link', { name: `${name}_v2` })
      .click()
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await acceptConfirms(page)
    await schema().getByRole('button', { name: 'Delete table' }).click()
    await expect(
      page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: `${name}_v2` }),
    ).toHaveCount(0)
  })
})

/** The built-in resource on the Resources pages: marked, not editable, and queried from the playground. */
test('the built-in resource queries the managed tables', async ({ page }) => {
  const table = `notes_${Date.now().toString(36)}`
  await signIn(page)
  const status = await trpcQuery<{ environments: { id: string; slug: string }[] }>(
    page,
    'database.environments',
  )
  const environmentId = status.environments.find((e) => e.slug === 'production')!.id
  await trpcMutate(page, 'database.createTable', {
    environmentId,
    name: table,
    columns: [{ name: 'body', type: 'text' }],
  })
  await trpcMutate(page, 'database.insertRow', {
    environmentId,
    table,
    values: { body: 'hello from the grid' },
  })

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Resources' }).click()
  const row = page.getByRole('link', { name: /Optiply Database/ })
  await expect(row).toContainText('Built-in')
  await row.click()
  await expect(page.getByRole('button', { name: 'Delete resource' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('managed by the platform')).toBeVisible()
  await expect(page.getByRole('textbox', { name: /^Host/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Query' }).click()
  await page.getByRole('textbox', { name: /^SQL/ }).fill(`select body from ${table}`)
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText('hello from the grid')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('link', { name: 'Open the tables on the Database page' }).click()
  await expect(page).toHaveURL(/\/database\?env=production/)
})

/**
 * Retool's column presets in the schema editor: UUID and Created time come with their defaults, the
 * auto-incrementing ID is numbered by Postgres, an enum's cells are a choice of its values, a foreign key points at
 * another table's key, and a custom column takes any Postgres type by name.
 */
test('columns from the presets: UUID, auto ID, created time, enum, foreign key, custom', async ({ page }) => {
  const suffix = Date.now().toString(36)
  const teams = `teams_${suffix}`
  const tickets = `tickets_${suffix}`
  await signIn(page)
  const status = await trpcQuery<{ environments: { id: string; slug: string }[] }>(
    page,
    'database.environments',
  )
  const environmentId = status.environments.find((e) => e.slug === 'production')!.id
  await trpcMutate(page, 'database.createTable', {
    environmentId,
    name: teams,
    columns: [{ name: 'name', type: 'text' }],
  })
  await trpcMutate(page, 'database.insertRow', { environmentId, table: teams, values: { name: 'Support' } })
  await page.goto('/database?env=production')

  await test.step('a table made from the presets', async () => {
    await page.getByRole('button', { name: 'New table' }).click()
    const dialog = page.getByRole('dialog', { name: 'New table' })
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(tickets)
    const columns: [string, string][] = [
      ['ref', 'uuid'],
      ['number', 'autoId'],
      ['created', 'createdTime'],
      ['status', 'enum'],
      ['team', 'foreignKey'],
      ['code', 'custom'],
    ]
    for (const [i, [column, preset]] of columns.entries()) {
      if (i > 0) await dialog.getByRole('button', { name: 'Add column' }).click()
      await dialog.getByLabel('Column name').nth(i).fill(column)
      await dialog.getByLabel('Preset').nth(i).selectOption(preset)
    }
    await dialog.getByLabel('Enum values').fill('open\nin progress\ndone')
    await dialog.getByLabel('Referenced table').selectOption(teams)
    await expect(dialog.getByLabel('Referenced column')).toHaveValue('id')
    await dialog.getByLabel('On delete').selectOption('cascade')
    await dialog.getByLabel('Postgres type').fill('varchar(20)')
    await dialog.getByRole('button', { name: 'Create table' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: tickets })).toBeVisible()
    const header = (column: string) => page.getByRole('columnheader', { name: new RegExp(`^${column}`) })
    await expect(header('ref')).toContainText('UUID')
    await expect(header('number')).toContainText('Auto ID')
    await expect(header('created')).toContainText('Created time')
    await expect(header('status')).toContainText('Enum')
    await expect(header('team')).toContainText(`→ ${teams}`)
    await expect(header('code')).toContainText('character varying(20)')
  })

  await test.step('a row: the enum is a choice, the rest is filled in by Postgres', async () => {
    await page.getByRole('button', { name: 'Add row' }).click()
    const dialog = page.getByRole('dialog', { name: /Add a row/ })
    await expect(dialog.getByLabel(/^status/)).toHaveRole('combobox')
    await dialog.getByLabel(/^status/).selectOption('in progress')
    await dialog.getByLabel(/^team/).fill('1')
    await dialog.getByLabel(/^code/).fill('T-1')
    await dialog.getByRole('button', { name: 'Add row' }).click()
    await expect(page.getByTestId('row-count')).toHaveText('1 row')
    await expect(cell(page, 0, 'status')).toHaveText('in progress')
    await expect(cell(page, 0, 'number')).toHaveText('1')
    await expect(cell(page, 0, 'ref')).toHaveText(/^[0-9a-f-]{36}$/)
    await expect(cell(page, 0, 'created')).not.toBeEmpty()
  })

  await test.step('the schema reads the presets back, and an enum is changed', async () => {
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    const schema = page.getByRole('dialog', { name: /^Table / })
    await expect(page.getByTestId('schema-column-team')).toContainText(`→ ${teams}`)
    await schema.getByRole('button', { name: 'Edit status' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit status' })
    await expect(edit.getByRole('combobox', { name: /^Preset/ })).toHaveValue('enum')
    await expect(edit.getByLabel('Enum values')).toHaveValue('open\nin progress\ndone')
    await edit.getByLabel('Enum values').fill('open\nin progress\ndone\nwon’t fix')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toHaveCount(0)
    await schema.getByRole('button', { name: 'Edit status' }).click()
    await expect(page.getByRole('dialog', { name: 'Edit status' }).getByLabel('Enum values')).toHaveValue(
      'open\nin progress\ndone\nwon’t fix',
    )
  })
})
