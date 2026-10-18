import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

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

  await choose('System')
  await expect(html).not.toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveClass(/dark/)
})
