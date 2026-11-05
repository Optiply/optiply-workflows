import { expect, test } from '@playwright/test'
import { E2E_SECOND_EMAIL } from './global-setup'
import { openEditorPanel, signIn, trpcMutate, trpcQuery } from './helpers'

interface Draft {
  draftRevision: number
  draftDefinition: { components: { name: string; props?: Record<string, unknown> }[] }
}

/**
 * The draft's history (session 41): saves by two people as two entries labelled by what changed; comparing one with
 * the draft; restoring the older one; a new app from a version.
 */
test('draft history: entries, compare, restore, a new app from a version', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `hist-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'History' })
  const text = (value: string) => ({ name: 'title', type: 'text', props: { value } })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [text('First')],
      queries: [],
      layout: { title: { x: 0, y: 0, w: 4, h: 2 } },
    },
  })

  // Someone else saves next: an entry of their own.
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other, E2E_SECOND_EMAIL)
  await trpcMutate(other, 'apps.saveDraft', {
    id: app.id,
    revision: 2,
    definition: {
      schemaVersion: 1,
      components: [text('Second'), { name: 'save', type: 'button' }],
      queries: [],
      layout: { title: { x: 0, y: 0, w: 4, h: 2 }, save: { x: 4, y: 0, w: 2, h: 2 } },
    },
  })
  await otherContext.close()

  await page.goto(`/apps/${slug}/edit`)
  await expect(page.locator('[data-component="title"]')).toContainText('Second')
  await openEditorPanel(page, 'History')
  const history = page.getByTestId('history-panel')
  const newest = history.getByTestId('version-3')
  const older = history.getByTestId('version-2')
  await expect(newest).toContainText('Added save · Changed title')
  await expect(newest).toContainText('current')
  await expect(older).toContainText('Added title')

  await older.getByRole('button', { name: 'Compare' }).click()
  const compare = page.getByRole('dialog')
  await expect(compare).toContainText('save')
  await page.keyboard.press('Escape')
  await expect(compare).toHaveCount(0)

  await older.getByRole('button', { name: 'Restore' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('[data-component="title"]')).toContainText('First', { timeout: 15_000 })
  await expect(page.locator('[data-component="save"]')).toHaveCount(0)
  const restored = await trpcQuery<Draft>(page, 'apps.get', { slug })
  expect(restored.draftDefinition.components.map((c) => c.name)).toEqual(['title'])
  await openEditorPanel(page, 'History')
  await expect(page.getByTestId('history-panel').locator('li').first()).toContainText(
    'Restored an earlier version',
  )

  // A new app from the second save.
  await page
    .getByTestId('history-panel')
    .getByTestId('version-3')
    .getByRole('button', { name: 'New app' })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Create the app' }).click()
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}-r3/edit`))
  await expect(page.locator('[data-component="title"]')).toContainText('Second')
  expect(errors).toEqual([])
})
