import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/** The palette (session 41): categories, a search by name or keyword, Enter adding the first match. */
test('the palette finds components and adds the first match on Enter', async ({ page }) => {
  await signIn(page)
  const slug = `palette-${Date.now()}`
  await trpcMutate(page, 'apps.create', { slug, name: 'Palette' })
  await page.goto(`/apps/${slug}/edit`)

  const palette = page.getByRole('complementary', { name: 'Left panel' })
  await expect(palette.getByRole('region', { name: 'Inputs' })).toBeVisible()
  const search = page.getByRole('searchbox', { name: 'Search components' })

  // A keyword finds what its name doesn't say: "dropdown" is the Select.
  await search.fill('dropdown')
  await expect(palette.getByRole('button', { name: 'Select', exact: true })).toBeVisible()
  await expect(palette.getByRole('button', { name: 'Table', exact: true })).toHaveCount(0)
  await search.press('Enter')
  await expect(page.getByTestId('inspector-select1')).toBeVisible()
  await expect(search).toHaveValue('')

  await search.fill('nothing like it')
  await expect(page.getByText('No component matches')).toBeVisible()
})
