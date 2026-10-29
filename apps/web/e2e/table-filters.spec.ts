import { expect, type Locator, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/** The first column's values of a table's rows, as shown (read at once: filtering removes rows). */
const firstCells = (table: Locator) =>
  table
    .locator('[role="row"]')
    .evaluateAll((rows) =>
      rows.slice(1).map((r) => r.querySelector('[role="gridcell"]')?.textContent?.trim() ?? ''),
    )

/**
 * Column filters (M24): set from a column's header, shown as chips, changed and removed; in the browser on a
 * computed column, and through `sql.where` on a table paged by its query, whose filters a button sets by code.
 */
test('filters tables from their headers, in the browser and through sql.where', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const stamp = Date.now()
  const slug = `filters-${stamp}`
  const table = `stock_${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Filters' })
  const q = (name: string, sql: string, run: 'auto' | 'manual' = 'auto') => ({
    name,
    kind: 'resource',
    resource: 'optiply_db',
    run,
    query: { sql },
  })
  const where = `{{ sql.where(remote.filters, ['id', 'name', 'qty']) }}`
  const definition = {
    schemaVersion: 1,
    components: [
      {
        name: 'local',
        type: 'table',
        props: {
          showFilters: true,
          data: [
            { id: 1, name: 'Apples', qty: 2, price: 3 },
            { id: 2, name: 'Pears', qty: 5, price: 1 },
            { id: 3, name: 'Plums', qty: 9, price: 2 },
          ],
          columns: [
            { key: 'name' },
            { key: 'qty' },
            { key: 'total', type: 'number', value: '{{ currentRow.qty * currentRow.price }}' },
          ],
        },
      },
      {
        name: 'remote',
        type: 'table',
        props: {
          showFilters: true,
          data: '{{ onePage.data }}',
          paging: 'server',
          pageSize: 10,
          totalRowCount: '{{ counted.data?.[0]?.n }}',
        },
      },
      {
        name: 'big',
        type: 'button',
        props: { text: 'Big ones' },
        events: [
          {
            id: 'b',
            event: 'click',
            action: {
              type: 'controlComponent',
              component: 'remote',
              method: 'setFilters',
              args: ["{{ [{ column: 'qty', op: 'gte', value: 95, type: 'number' }] }}"],
            },
          },
        ],
      },
    ],
    queries: [
      q(
        'setup',
        `create table ${table} (id int primary key, name text not null, qty int not null)`,
        'manual',
      ),
      q(
        'onePage',
        `select id, name, qty from ${table} where ${where} order by id limit {{ remote.pagination.pageSize }} offset {{ remote.pagination.offset }}`,
      ),
      q('counted', `select count(*)::int as n from ${table} where ${where}`),
    ],
    layout: {
      local: { x: 0, y: 0, w: 6, h: 16 },
      remote: { x: 6, y: 0, w: 6, h: 24 },
      big: { x: 0, y: 16, w: 2, h: 2 },
    },
  }
  const envs = await page.request.get('/api/trpc/environments.list')
  const prod = (await envs.json()).result.data.json.find((e: { slug: string }) => e.slug === 'production')
  const runSetup = () =>
    trpcMutate(page, 'apps.runQuery', {
      appId: app.id,
      releaseId: null,
      query: 'setup',
      environmentId: prod.id,
      values: {},
    })
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await runSetup()
  definition.queries[0] = q(
    'setup',
    `insert into ${table} select g, 'item ' || g, g from generate_series(1, 100) g`,
    'manual',
  )
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 2, definition })
  await runSetup()
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 3 })
  await page.goto(`/apps/${slug}`)
  const local = page.locator('[data-component="local"]')
  const remote = page.locator('[data-component="remote"]')

  await test.step('in the browser: a filter on a computed column, then another, as chips', async () => {
    await expect.poll(() => firstCells(local)).toEqual(['Apples', 'Pears', 'Plums'])
    await local.getByRole('button', { name: 'Filter total' }).click()
    const bar = local.getByTestId('filter-bar')
    await bar.getByLabel('Operator').selectOption({ label: '≥' })
    await bar.getByLabel('Value').fill('6')
    await bar.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(() => firstCells(local)).toEqual(['Apples', 'Plums'])
    await expect(local.getByTestId('filters')).toContainText('total ≥ 6')
    await local.getByRole('button', { name: 'Filter name' }).click()
    await local.getByTestId('filter-bar').getByLabel('Value').fill('PLU')
    await local.getByTestId('filter-bar').getByLabel('Value').press('Enter')
    await expect.poll(() => firstCells(local)).toEqual(['Plums'])
    await expect(local).toContainText('1 of 3 rows')
    await local.getByRole('button', { name: 'Remove the filter on total' }).click()
    await expect.poll(() => firstCells(local)).toEqual(['Plums'])
    await local.getByRole('button', { name: 'Remove the filter on name' }).click()
    await expect(local.getByTestId('filters')).toHaveCount(0)
    await expect(local).toContainText('3 rows')
  })

  await test.step('through sql.where: from the header and by code, back to the first page', async () => {
    await expect(remote).toContainText('100 rows')
    await remote.getByRole('button', { name: 'Next page' }).click()
    await expect(remote).toContainText('Page 2 of 10')
    await remote.getByRole('button', { name: 'Filter qty' }).click()
    const bar = remote.getByTestId('filter-bar')
    await bar.getByLabel('Operator').selectOption({ label: 'between' })
    await bar.getByLabel('From', { exact: true }).fill('12')
    await bar.getByLabel('To', { exact: true }).fill('30')
    await bar.getByRole('button', { name: 'Apply' }).click()
    await expect(remote).toContainText('19 rows')
    await expect(remote).toContainText('Page 1 of 2')
    await expect
      .poll(() => firstCells(remote))
      .toEqual(['12', '13', '14', '15', '16', '17', '18', '19', '20', '21'])
    await page.locator('[data-component="big"]').getByRole('button').click()
    await expect(remote).toContainText('6 rows')
    await expect(remote.getByTestId('filters')).toContainText('qty ≥ 95')
    await expect.poll(() => firstCells(remote)).toEqual(['95', '96', '97', '98', '99', '100'])
  })
  expect(errors).toEqual([])
})
