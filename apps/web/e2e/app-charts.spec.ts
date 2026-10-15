import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Charts on a published app, fed by queries: stacked bars, a two-series line, an area and a pie whose small slices
 * fold into "Other". Each canvas is labelled for screen readers and has a Table view with the same values.
 */
test('charts render from query results, with a table view of their values', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await signIn(page)
  const slug = `charts-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Sales' })
  const chart = (name: string, props: object) => ({
    name,
    type: 'chart',
    props: { data: '{{ sales.data }}', ...props },
  })
  const definition = {
    schemaVersion: 1,
    components: [
      chart('bars', {
        title: 'Orders by month',
        chartType: 'bar',
        xKey: 'month',
        series: ['nl', 'be', 'de'],
        stacked: true,
      }),
      chart('lines', { title: 'Revenue', chartType: 'line', xKey: 'month', series: ['revenue', 'target'] }),
      chart('area', { title: 'Revenue (area)', chartType: 'area', xKey: 'month', series: ['revenue'] }),
      chart('pie', {
        title: 'Orders per product',
        chartType: 'pie',
        data: '{{ products.data }}',
        xKey: 'product',
        series: ['orders'],
      }),
    ],
    queries: [
      {
        name: 'sales',
        kind: 'resource',
        resource: 'optiply_db',
        run: 'auto',
        query: {
          sql: `select to_char(make_date(2026, m, 1), 'Mon') as month,
                       (40 + m * 7)::int as nl, (20 + m * 3)::int as be, (10 + (m % 4) * 5)::int as de,
                       (1000 + m * 230 + (m % 3) * 150)::numeric as revenue, (1100 + m * 200)::numeric as target
                from generate_series(1, 10) as m order by m`,
        },
      },
      {
        name: 'products',
        kind: 'resource',
        resource: 'optiply_db',
        run: 'auto',
        query: {
          sql: "select 'Product ' || p as product, (100 - p * 8)::int as orders from generate_series(1, 11) as p",
        },
      },
    ],
    layout: {
      bars: { x: 0, y: 0, w: 6, h: 18 },
      lines: { x: 6, y: 0, w: 6, h: 18 },
      area: { x: 0, y: 18, w: 6, h: 18 },
      pie: { x: 6, y: 18, w: 6, h: 18 },
    },
  }
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  await page.goto(`/apps/${slug}`)
  await expect(
    page.getByRole('img', { name: /Revenue: line chart of revenue, target by month/ }),
  ).toBeVisible()
  await expect(page.getByText('4 smaller slices are grouped as Other.')).toBeVisible()
  await page.locator('[data-component="pie"]').getByRole('button', { name: 'Table' }).click()
  await expect(page.locator('[data-component="pie"] table')).toContainText('Other')
  await page.locator('[data-component="pie"]').getByRole('button', { name: 'Chart' }).click()
  for (const name of [
    /Orders by month: bar chart of nl, be, de by month/,
    /Revenue \(area\): area chart/,
    /Orders per product: pie chart of orders by product/,
  ]) {
    await expect(page.getByRole('img', { name })).toBeVisible()
  }
  // The table view.
  await page.locator('[data-component="lines"]').getByRole('button', { name: 'Table' }).click()
  await expect(page.locator('[data-component="lines"] table')).toContainText('Mar')
  await expect(page.locator('[data-component="lines"] table')).toContainText('2,380')
  expect(errors).toEqual([])
})
