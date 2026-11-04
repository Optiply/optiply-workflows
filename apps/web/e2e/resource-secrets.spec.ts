import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Secrets the platform stores (a resource's token) aren't the user's login: the field is a text input masked with
 * CSS, so Chrome doesn't offer to save it as a password (it did for `type="password"`, even with
 * `autocomplete="new-password"`).
 */
test("a resource's token is masked, and nothing on the page is a password field", async ({ page }) => {
  await signIn(page)
  const suffix = Date.now().toString(36)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Secrets',
    slug: `secrets_${suffix}`,
  })
  // An unconfigured resource opens on its settings.
  await page.goto(`/resources/${resource.id}`)
  await page.getByRole('combobox', { name: 'Authentication' }).selectOption('bearer')
  const token = page.getByLabel('Token', { exact: true })
  await token.fill('ow-token-value')
  await expect(token).toHaveValue('ow-token-value')
  expect(
    await token.evaluate((el) => [
      (el as HTMLInputElement).type,
      getComputedStyle(el).getPropertyValue('-webkit-text-security'),
    ]),
  ).toEqual(['text', 'disc'])
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
})
