import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Session 41's components in a running app: the new inputs set their values (read back by a text), and the
 * presentation components show theirs.
 */
test('the new inputs and presentation components', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `more-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'More components' })
  const options = '{{ ["red", "green", "blue"] }}'
  const components = [
    { name: 'notes', type: 'textArea', props: { label: 'Notes' } },
    { name: 'on', type: 'switch', props: { label: 'Active' } },
    { name: 'colors', type: 'checkboxGroup', props: { label: 'Colors', options } },
    { name: 'one', type: 'radioGroup', props: { label: 'One', options, orientation: 'horizontal' } },
    {
      name: 'seg',
      type: 'segmentedControl',
      props: { label: 'View', options: '{{ ["List", "Grid"] }}', defaultValue: 'List' },
    },
    { name: 'period', type: 'dateRange', props: { label: 'Period' } },
    { name: 'upload', type: 'fileInput', props: { label: 'File' } },
    {
      name: 'out',
      type: 'text',
      props: {
        value:
          '{{ JSON.stringify([notes.value, on.value, colors.value, one.value, seg.value, period.value, upload.value.map((f) => f.name + ":" + f.size)]) }}',
      },
    },
    {
      name: 'total',
      type: 'statistic',
      props: {
        label: 'Revenue',
        value: '{{ 1234.5 }}',
        format: 'currency',
        currency: 'EUR',
        decimals: 0,
        trend: 12,
      },
    },
    {
      name: 'warn',
      type: 'alert',
      props: { title: 'Careful', description: 'Stock is low', tone: 'warning' },
    },
    { name: 'done', type: 'progressBar', props: { label: 'Done', value: '{{ 140 }}' } },
    { name: 'kv', type: 'keyValue', props: { data: '{{ { sku: "A-1", stock: 3 } }}' } },
    {
      name: 'json',
      type: 'jsonExplorer',
      props: { value: '{{ { items: [1, 2], name: "x" } }}', expandDepth: 1 },
    },
    { name: 'pic', type: 'image', props: { src: 'javascript:alert(1)' } },
    { name: 'line', type: 'divider', props: { label: 'More' } },
  ]
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components,
      queries: [],
      layout: Object.fromEntries(
        components.map((c, i) => [c.name, { x: (i % 2) * 6, y: Math.floor(i / 2) * 8, w: 6, h: 6 }]),
      ),
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  await page.getByRole('button', { name: 'Preview' }).click()
  const out = page.locator('[data-component="out"]')
  await expect(out).toHaveText('["",false,[],null,"List",null,[]]')

  await page.getByRole('textbox', { name: 'Notes' }).fill('two\nlines')
  await page.getByRole('switch', { name: 'Active' }).click()
  await page.getByRole('checkbox', { name: 'blue' }).check()
  await page.getByRole('checkbox', { name: 'red' }).check()
  await page.getByRole('radio', { name: 'green' }).check()
  await page.getByRole('radio', { name: 'Grid' }).click()
  await page.getByLabel('From').fill('2026-11-01')
  await page.getByLabel('To').fill('2026-11-30')
  await page.locator('[data-component="upload"] input[type="file"]').setInputFiles({
    name: 'stock.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('sku,stock\nA-1,3\n'),
  })
  // The checked colors in the options' order, whatever the order they were checked in.
  await expect(out).toHaveText(
    '["two\\nlines",true,["red","blue"],"green","Grid",{"start":"2026-11-01","end":"2026-11-30"},["stock.csv:16"]]',
  )

  await expect(page.locator('[data-component="total"]')).toContainText('Revenue')
  await expect(page.locator('[data-component="total"]')).toContainText('1,235')
  await expect(page.locator('[data-component="warn"]').getByRole('status')).toContainText('Stock is low')
  await expect(page.getByRole('progressbar', { name: 'Done' })).toHaveAttribute('aria-valuenow', '100')
  await expect(page.locator('[data-component="kv"]')).toContainText('stock3')
  const json = page.locator('[data-component="json"]')
  await expect(json).toContainText('items: [2]')
  await json.getByRole('button', { name: /items/ }).click()
  await expect(json).toContainText('1')
  // Only http(s) and data:image sources show.
  await expect(page.locator('[data-component="pic"]')).toContainText(
    'Only http(s) and data:image sources show',
  )
  await expect(page.locator('[data-component="line"]')).toContainText('More')
  expect(errors).toEqual([])
})
