import { expect, type Locator, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, typeInto } from './helpers'

/** The third column's computed value field. */
const valueField = (page: Page) => page.locator('[data-testid$="/props/columns/2/value"]')

/** A table's cells, row by row, as text (read at once, so a table re-rendering meanwhile can't hang it). */
const cells = (table: Locator) =>
  table
    .locator('[data-row]')
    .evaluateAll((rows) =>
      rows.map((r) =>
        [...r.querySelectorAll('[role="gridcell"]')].map((c) => (c as HTMLElement).innerText.trim()),
      ),
    )

/**
 * The columns list editor and computed columns (M24): columns added, configured and reordered in the inspector; a
 * computed column from `currentRow` follows what it reads; a name it doesn't know is a problem under the field; the
 * table shows the computed values in the editor and the published app.
 */
test('edits a table’s columns as a list, with a computed column', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `columns-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Columns' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        {
          name: 'lines',
          type: 'table',
          props: {
            data: [
              { id: 1, item: 'Apples', qty: 2, price: 3 },
              { id: 2, item: 'Pears', qty: 5, price: 1 },
            ],
            columns: [{ key: 'item' }, { key: 'qty' }],
          },
        },
        { name: 'vat', type: 'numberInput', props: { label: 'VAT', defaultValue: 1 } },
      ],
      queries: [],
      transformers: [],
      variables: [],
      layout: { lines: { x: 0, y: 0, w: 8, h: 12 }, vat: { x: 8, y: 0, w: 4, h: 2 } },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  const table = page.locator('[data-component="lines"]')
  await expect(table.getByRole('columnheader')).toHaveText(['item', 'qty'])

  await test.step('add a computed column and label it', async () => {
    await page.getByTestId('frame-lines').click()
    const editor = page.getByTestId('columns-lines')
    await editor.getByRole('button', { name: 'Add column' }).click()
    const column = editor.getByTestId('column-2')
    await column.getByLabel('Column key').fill('total')
    await column.getByLabel('Column label').fill('Total')
    await typeInto(page, valueField(page), '{{ currentRow.qty * currentRow.price * vat.value }}')
    await expect(table.getByRole('columnheader')).toHaveText(['item', 'qty', 'Total'])
    await expect
      .poll(() => cells(table))
      .toEqual([
        ['Apples', '2', '6'],
        ['Pears', '5', '5'],
      ])
    // Editable is off for a computed column.
    await expect(column.getByLabel('Editable')).toBeDisabled()
  })

  await test.step('it follows what it reads', async () => {
    await page.locator('[data-component="vat"]').getByRole('spinbutton').fill('2')
    await expect
      .poll(() => cells(table))
      .toEqual([
        ['Apples', '2', '12'],
        ['Pears', '5', '10'],
      ])
  })

  await test.step('a name it doesn’t know is a problem; currentRow is fine', async () => {
    await typeInto(page, valueField(page), '{{ currentRow.qty * nope }}')
    await expect(valueField(page).locator('.squiggly-error')).not.toHaveCount(0)
    await typeInto(page, valueField(page), '{{ currentRow.qty * currentRow.price }}')
    await expect(valueField(page).locator('.squiggly-error')).toHaveCount(0)
  })

  await test.step('reorder and hide, then the JSON view shows the same columns', async () => {
    const editor = page.getByTestId('columns-lines')
    await editor.getByTestId('column-2').getByRole('button', { name: 'Move up' }).click()
    await expect(table.getByRole('columnheader')).toHaveText(['item', 'Total', 'qty'])
    await editor.getByTestId('column-0').getByRole('button', { name: /item/ }).click()
    await editor.getByTestId('column-0').getByLabel('Hidden').check()
    await expect(table.getByRole('columnheader')).toHaveText(['Total', 'qty'])
    await page.getByRole('button', { name: 'Edit as JSON' }).click()
    await expect(page.getByTestId('inspector-lines')).toContainText('"hidden": true')
    await page.getByRole('button', { name: 'Edit as list' }).click()
    await expect(editor.getByTestId('column-1')).toContainText('total')
  })

  await test.step('published, the app computes it too', async () => {
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByTestId('publish-confirm').click()
    await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
    await page.goto(`/apps/${slug}`)
    const live = page.locator('[data-component="lines"]')
    await expect(live.getByRole('columnheader')).toHaveText(['Total', 'qty'])
    await expect
      .poll(() => cells(live))
      .toEqual([
        ['6', '2'],
        ['5', '5'],
      ])
  })
  expect(errors).toEqual([])
})
