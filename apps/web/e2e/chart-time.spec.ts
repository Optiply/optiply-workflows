import { expect, test } from '@playwright/test'
import { openEditorPanel, signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * A chart's time axis (M24): a line chart of daily rows, out of order and with a gap, places them by date (its
 * table shows them sorted, with dates); and renaming a page in the editor rewrites `utils.openPage('…')` in code.
 */
test('charts daily rows on a time axis; a page rename follows utils.openPage', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `time-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Time' })
  // January with a gap from the 10th to the 20th, given out of order.
  const days = [3, 1, 2, 9, 21, 22, 31].map((d) => ({
    day: `2026-01-${String(d).padStart(2, '0')}`,
    orders: d,
  }))
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      pages: [{ name: 'sales' }, { name: 'other' }],
      components: [
        {
          name: 'trend',
          type: 'chart',
          page: 'sales',
          props: { title: 'Orders a day', chartType: 'line', data: days, xKey: 'day', series: ['orders'] },
        },
        {
          name: 'go',
          type: 'button',
          page: 'other',
          props: { text: 'To sales' },
          events: [
            { id: 'g', event: 'click', action: { type: 'runScript', code: "utils.openPage('sales')" } },
          ],
        },
      ],
      queries: [],
      transformers: [],
      variables: [],
      layout: { trend: { x: 0, y: 0, w: 12, h: 18 }, go: { x: 0, y: 0, w: 3, h: 2 } },
    },
  })

  await test.step('the chart places the days by date, sorted', async () => {
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
    await page.goto(`/apps/${slug}`)
    const chart = page.locator('[data-component="trend"]')
    await expect(chart.locator('canvas')).toBeVisible()
    await chart.getByRole('button', { name: 'Table' }).click()
    const read = () =>
      chart
        .locator('tbody tr')
        .evaluateAll((rows) => rows.map((r) => r.querySelector('td, th')?.textContent?.trim() ?? ''))
    await expect.poll(async () => (await read()).length).toBe(7)
    const firstCells = await read()
    // Sorted by date: the 1st first, the 31st last, each a date.
    expect(firstCells[0]).toMatch(/1/)
    expect(firstCells[6]).toMatch(/31/)
    expect(firstCells.every((c) => /2026/.test(c))).toBe(true)
    await chart.getByRole('button', { name: 'Chart' }).click()
  })

  await test.step('renaming the page rewrites utils.openPage in the script', async () => {
    await page.goto(`/apps/${slug}/edit`)
    await openEditorPanel(page, 'Pages')
    const pages = page.getByRole('region', { name: 'Pages' })
    await pages.getByRole('button', { name: 'sales' }).click()
    await page.getByTestId('inspector-app').getByLabel('Page name').fill('orders')
    await page.getByTestId('inspector-app').getByLabel('Page name').press('Enter')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const got = await trpcQuery<{
          draftDefinition: { components: { name: string; events?: { action: { code?: string } }[] }[] }
        }>(page, 'apps.get', { slug })
        return got.draftDefinition.components.find((c) => c.name === 'go')?.events?.[0]?.action.code
      })
      .toBe("utils.openPage('orders')")
  })
  expect(errors).toEqual([])
})
