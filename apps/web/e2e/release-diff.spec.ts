import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

const definition = (layoutX: number, code: string, extra: object[] = []) => ({
  schemaVersion: 1,
  components: [{ name: 'title', type: 'text', props: { value: 'Orders' } }, ...extra],
  queries: [{ name: 'totals', kind: 'js', code }],
  transformers: [],
  variables: [],
  layout: {
    title: { x: layoutX, y: 0, w: 4, h: 2 },
    ...Object.fromEntries(
      extra.map((c, i) => [(c as { name: string }).name, { x: 0, y: 2 + i * 2, w: 3, h: 2 }]),
    ),
  },
})

/**
 * Compare (M24): an app's release against the draft and against the release before it, from the editor's
 * Releases dialog: a moved component, a query's code as a line diff, a component added.
 */
test('compares an app’s releases with each other and with the draft', async ({ page }) => {
  await signIn(page)
  const slug = `compare-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Compare' })
  const publish = (draftRevision: number) =>
    trpcMutate<{ id: string }>(page, 'apps.publish', { appId: app.id, draftRevision, bump: 'minor' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: definition(0, 'const rows = []\nreturn rows.length'),
  })
  await publish(2)
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 2,
    definition: definition(0, 'const rows = []\nreturn rows.length', [{ name: 'save', type: 'button' }]),
  })
  await publish(3)
  // The draft: the title moved, the query's second line changed.
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 3,
    definition: definition(4, 'const rows = []\nreturn rows.length * 2', [{ name: 'save', type: 'button' }]),
  })

  await page.goto(`/apps/${slug}/edit`)
  await page.getByRole('button', { name: 'Releases' }).first().click()
  const releases = page.getByTestId('releases')
  await expect(releases.getByRole('listitem')).toHaveCount(2)

  await test.step('the first release against the draft', async () => {
    await releases
      .getByRole('listitem')
      .filter({ hasText: 'v1.0.0' })
      .getByRole('button', { name: 'Compare' })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Compare' })
    await expect(dialog.getByLabel('From')).toHaveValue(/[0-9a-f-]{36}/)
    await expect(dialog.getByLabel('To')).toHaveValue('draft')
    const compare = dialog.getByTestId('compare')
    await expect(compare).toContainText('2 changed · 2 added')
    const queries = compare.getByRole('region', { name: 'Queries' })
    await expect(queries).toContainText('totals')
    const lines = queries.getByTestId('file-diff')
    await expect(lines).toContainText('−return rows.length')
    await expect(lines).toContainText('+return rows.length * 2')
    await expect(compare.getByRole('region', { name: 'Layout' })).toContainText('title')
    await expect(compare.getByRole('region', { name: 'Components' })).toContainText('Added')
  })

  await test.step('two releases, then swapped', async () => {
    const dialog = page.getByRole('dialog', { name: 'Compare' })
    const options = dialog.getByLabel('To').locator('option')
    await dialog
      .getByLabel('To')
      .selectOption({ label: (await options.filter({ hasText: 'v1.1.0' }).textContent())! })
    const compare = dialog.getByTestId('compare')
    await expect(compare).toContainText('2 added')
    await expect(compare.getByRole('region', { name: 'Components' })).toContainText('save')
    await expect(compare.getByRole('region', { name: 'Queries' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Swap' }).click()
    await expect(compare).toContainText('2 removed')
    await dialog
      .getByLabel('From')
      .selectOption({ label: (await options.filter({ hasText: 'v1.0.0' }).textContent())! })
    await expect(compare).toContainText('Nothing changed.')
  })

  await test.step('closing goes back to the releases', async () => {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('releases')).toBeVisible()
  })
})
