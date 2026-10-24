import { expect, type Page, test } from '@playwright/test'
import { E2E_SECOND_EMAIL } from './global-setup'
import { editorText, signIn, trpcMutate } from './helpers'

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
const sqlField = (page: Page) => page.locator('[data-testid^="code-library:"]')

/**
 * The library query editor together (M21 step 5b): two people see each other (avatars), type in the SQL at once
 * (merged, with each other's caret), add parameters the other sees, and undo only their own typing.
 */
test('two people edit a library query together', async ({ page, browser }) => {
  await signIn(page)
  const slug = `together_${Date.now()}`
  const { id } = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', {
    slug,
    name: `Together ${slug}`,
  })
  await trpcMutate(page, 'libraryQueries.saveDraft', {
    id,
    revision: 1,
    definition: { schemaVersion: 1, resource: 'optiply_db', query: { sql: 'select 1' }, params: [] },
  })
  await page.goto(`/library/${slug}`)
  await saved(page)

  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other, E2E_SECOND_EMAIL)
  await other.goto(`/library/${slug}`)
  await saved(other)

  await test.step('each sees the other', async () => {
    await expect(page.getByTestId('presence-Second')).toBeVisible()
    await expect(other.getByTestId('presence-E2E')).toBeVisible()
  })

  await test.step('typing at once in the SQL merges, with each other’s caret', async () => {
    const mine = sqlField(page)
    const theirs = sqlField(other)
    await expect.poll(() => editorText(theirs)).toBe('select 1')
    await mine.click()
    await page.keyboard.press('End')
    await theirs.click()
    await other.keyboard.press('Home')
    await Promise.all([
      page.keyboard.type(' as one', { delay: 60 }),
      other.keyboard.type('/*hi*/ ', { delay: 60 }),
    ])
    const merged = '/*hi*/ select 1 as one'
    await expect.poll(() => editorText(mine)).toBe(merged)
    await expect.poll(() => editorText(theirs)).toBe(merged)
    await expect(mine.locator('.ow-remote-caret')).toHaveCount(1)
    await expect(theirs.locator('.ow-remote-caret')).toHaveCount(1)
    await saved(page)
    await saved(other)

    // Undo takes back this side's typing only.
    await mine.click()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => editorText(mine)).toBe('/*hi*/ select 1')
    await expect.poll(() => editorText(theirs)).toBe('/*hi*/ select 1')
    await saved(page)
  })

  await test.step('a parameter added on one side appears on the other, and a reload shows it saved', async () => {
    await other.getByTestId('library-params').getByRole('button', { name: 'Add' }).click()
    await expect(page.getByLabel('Parameter 1 name')).toHaveValue('param1')
    await saved(other)
    await page.reload()
    await expect(page.getByLabel('Parameter 1 name')).toHaveValue('param1')
    await expect.poll(() => editorText(sqlField(page))).toBe('/*hi*/ select 1')
  })

  await otherContext.close()
})
