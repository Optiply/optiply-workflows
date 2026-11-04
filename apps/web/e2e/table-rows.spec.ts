import { expect, type Locator, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/** The first column's values of a table's rows, as shown (read at once). */
const firstCells = (table: Locator) =>
  table
    .locator('[data-row]')
    .evaluateAll((rows) => rows.map((r) => r.querySelector('[role="gridcell"]')?.textContent?.trim() ?? ''))

/** Drags a column's right edge by `dx` pixels. */
async function resize(page: Page, table: Locator, column: string, dx: number) {
  const box = (await table.getByRole('separator', { name: `Resize ${column}` }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
}

const headerWidth = async (table: Locator, column: string) =>
  (await table.getByRole('columnheader').filter({ hasText: column }).boundingBox())!.width

/**
 * Resizing columns and adding rows (M24): a drag in the editor saves the column's width; in the app it holds until
 * a reload; rows added in the table reach an insert query through `newRows`, and Save clears them.
 */
test('resizes columns and adds rows', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const stamp = Date.now()
  const slug = `rows-${stamp}`
  const table = `rows_${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Rows' })
  const q = (name: string, sql: string, run: 'auto' | 'manual' = 'auto', events: object[] = []) => ({
    name,
    kind: 'resource',
    resource: 'optiply_db',
    run,
    query: { sql },
    ...(events.length && { events }),
  })
  const definition = {
    schemaVersion: 1,
    components: [
      {
        name: 'items',
        type: 'table',
        props: {
          data: '{{ everything.data }}',
          allowAddRow: true,
          columns: [
            { key: 'id' },
            { key: 'name', editable: true },
            { key: 'qty', type: 'number', editable: true },
          ],
        },
        events: [
          { id: 's', event: 'save', action: { type: 'controlQuery', query: 'insert', method: 'trigger' } },
        ],
      },
    ],
    queries: [
      q('setup', `create table ${table} (id serial primary key, name text not null, qty int)`, 'manual'),
      q('everything', `select id, name, qty from ${table} order by id`),
      q(
        'insert',
        `insert into ${table} (name, qty) select name, qty from jsonb_to_recordset({{ items.newRows }}::jsonb) as x(name text, qty int)`,
        'manual',
        [
          {
            id: 'r',
            event: 'success',
            action: { type: 'controlQuery', query: 'everything', method: 'trigger' },
          },
        ],
      ),
    ],
    layout: { items: { x: 0, y: 0, w: 8, h: 16 } },
  }
  const envs = await page.request.get('/api/trpc/environments.list')
  const prod = (await envs.json()).result.data.json.find((e: { slug: string }) => e.slug === 'production')
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await trpcMutate(page, 'apps.runQuery', {
    appId: app.id,
    releaseId: null,
    query: 'setup',
    environmentId: prod.id,
    values: {},
  })

  await test.step('in the editor, a drag saves the column’s width', async () => {
    await page.goto(`/apps/${slug}/edit`)
    const items = page.locator('[data-component="items"]')
    await expect(items.getByRole('columnheader')).toHaveText(['id', 'name', 'qty'])
    const before = await headerWidth(items, 'name')
    await resize(page, items, 'name', 80)
    await expect.poll(() => headerWidth(items, 'name')).toBeGreaterThan(before + 60)
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const got = await trpcQuery<{
          draftDefinition: { components: { props: { columns: { width?: number }[] } }[] }
        }>(page, 'apps.get', { slug })
        return got.draftDefinition.components[0]!.props.columns[1]!.width ?? 0
      })
      .toBeGreaterThan(before + 60)
  })

  await test.step('in the app: a drag holds, rows are added and saved', async () => {
    const draft = await trpcQuery<{ draftRevision: number }>(page, 'apps.get', { slug })
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: draft.draftRevision })
    await page.goto(`/apps/${slug}`)
    const items = page.locator('[data-component="items"]')
    await expect(items).toContainText('0 rows')
    const before = await headerWidth(items, 'qty')
    await resize(page, items, 'qty', 60)
    await expect.poll(() => headerWidth(items, 'qty')).toBeGreaterThan(before + 40)

    await items.getByRole('button', { name: 'Add row' }).click()
    await items.getByRole('button', { name: 'Add row' }).click()
    const rows = items.getByTestId('new-rows')
    await rows.getByLabel('New name').first().fill('Bolts')
    await rows.getByLabel('New qty').first().fill('12')
    await rows.getByLabel('New name').nth(1).fill('Nuts')
    await rows.getByLabel('New qty').nth(1).fill('x')
    await expect(rows.getByLabel('New qty').nth(1)).toHaveAttribute('aria-invalid', 'true')
    await rows.getByLabel('New qty').nth(1).fill('7')
    await expect(items).toContainText('2 new rows')
    await items.getByRole('button', { name: 'Save changes' }).click()
    await expect.poll(() => firstCells(items)).toHaveLength(2)
    await expect(items.getByTestId('new-rows')).toHaveCount(0)
    await expect(items).toContainText('Bolts')
    await expect(items).toContainText('Nuts')

    // A new row can be dropped before saving; Discard drops them all.
    await items.getByRole('button', { name: 'Add row' }).click()
    await items.getByRole('button', { name: 'Remove new row 1' }).click()
    await expect(items.getByTestId('new-rows')).toHaveCount(0)
    await items.getByRole('button', { name: 'Add row' }).click()
    await items.getByRole('button', { name: 'Discard' }).click()
    await expect(items.getByTestId('new-rows')).toHaveCount(0)

    // A reload forgets the dragged width.
    await page.reload()
    await expect(items).toContainText('2 rows')
    expect(await headerWidth(items, 'qty')).toBeLessThan(before + 20)
  })
  expect(errors).toEqual([])
})
