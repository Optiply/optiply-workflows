import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, typeInto } from './helpers'

/**
 * The app editor: components from the palette, a prop bound to another component with {{ }}, a query on the
 * managed database that re-runs with its input, renaming (references follow), dragging (the layout is saved), and
 * the draft surviving a reload.
 */
test('build an app in the editor', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `ed-${Date.now()}`
  await trpcMutate(page, 'apps.create', { slug, name: 'Editor check' })
  await page.goto(`/apps/${slug}/edit`)

  await page.getByRole('button', { name: 'Text input', exact: true }).click()
  await expect(page.getByTestId('inspector-textInput1')).toBeVisible()
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(page.getByTestId('inspector-text1')).toBeVisible()
  await typeInto(
    page,
    page.locator('[data-testid$="/components/1/props/value"]'),
    'Hello {{ textInput1.value }}',
  )

  // The canvas runs the draft: the text shows its evaluated value.
  await expect(page.getByTestId('frame-text1')).toContainText('Hello ')

  // A query on the managed database, re-run as the input changes.
  await page.getByTitle('Add a resource query').click()
  await expect(page.getByTestId('query-query1')).toBeVisible()
  await typeInto(
    page,
    page.locator('[data-testid$="/queries/0/query/sql"]'),
    "select 'hi ' || {{ textInput1.value }}::text as greeting",
  )
  await expect(page.getByTestId('result-query1')).toContainText('"greeting": "hi "', { timeout: 15000 })

  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })
  // Rename the input: references follow.
  await page.getByTestId('frame-textInput1').click()
  await page.getByTestId('inspector-textInput1').getByLabel('Name').fill('nameInput')
  await page.getByTestId('inspector-textInput1').getByLabel('Name').press('Enter')
  await expect(page.getByTestId('inspector-nameInput')).toBeVisible()
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('result-query1')).toContainText('"greeting": "hi "')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })

  // Drag the input down by its handle: the layout is saved.
  await page.getByTestId('frame-nameInput').click()
  const handle = page.getByTestId('frame-nameInput').getByTitle('Drag to move')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 10, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x + 300, box.y + 200, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })
  const saved = await page.request.get(
    `/api/trpc/apps.get?input=${encodeURIComponent(JSON.stringify({ json: { slug } }))}`,
  )
  const layout = (await saved.json()).result.data.json.draftDefinition.layout
  expect(layout.nameInput.x).toBeGreaterThan(0)

  await page.reload()
  await expect(page.getByTestId('frame-nameInput')).toBeVisible()
  await page.getByTestId('frame-text1').click()
  await expect(page.getByTestId('inspector-text1')).toContainText('nameInput.value')
  await page.getByRole('tab', { name: /State/ }).click()
  await expect(page.getByText('query1', { exact: true }).last()).toBeVisible()
  expect(errors).toEqual([])
})
