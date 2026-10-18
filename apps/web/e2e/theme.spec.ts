import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/** Optiply UI: the theme is chosen in the account menu, applied at once, and kept across reloads. */
test('switch to dark mode and back to the system theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await signIn(page)
  const html = page.locator('html')
  await expect(html).not.toHaveClass(/dark/)

  const choose = async (name: string) => {
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitemradio', { name }).click()
    await expect(page.getByRole('menu')).toBeHidden()
  }

  await choose('Dark')
  await expect(html).toHaveClass(/dark/)
  await page.reload()
  await expect(html).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Account' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()

  // Moving focus out of the menu (Tab, or anything else) closes it.
  await page.getByRole('button', { name: 'Account' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('link', { name: 'Workflows' }).focus()
  await expect(page.getByRole('menu')).toBeHidden()

  await choose('System')
  await expect(html).not.toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveClass(/dark/)
})

/** Optiply UI review: the canvas minimap can cover blocks, so it can be hidden; the choice is kept. */
test('hide the workflow canvas minimap, and it stays hidden after a reload', async ({ page }) => {
  await signIn(page)
  const slug = `minimap-${Date.now()}`
  const { id } = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  await page.goto(`/workflows/${id}`)
  const minimap = page.locator('.react-flow__minimap')
  await expect(minimap).toBeVisible()
  await page.getByRole('button', { name: 'Hide the minimap' }).click()
  await expect(minimap).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show the minimap' })).toBeVisible()
  await expect(minimap).toHaveCount(0)
  await page.getByRole('button', { name: 'Show the minimap' }).click()
  await expect(minimap).toBeVisible()
})
