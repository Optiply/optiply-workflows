import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, typeInto } from './helpers'

const appGet = async (page: Page, slug: string) => {
  const res = await page.request.get(
    `/api/trpc/apps.get?input=${encodeURIComponent(JSON.stringify({ json: { slug } }))}`,
  )
  const got = (await res.json()).result.data.json
  return { ...got, definition: got.draftDefinition } as {
    id: string
    draftRevision: number
    definition: {
      pages?: { name: string; title?: string }[]
      components: { name: string; page?: string }[]
      queries: { name: string; page?: string }[]
    }
  }
}

/**
 * Pages in the editor: a one-page app gets pages (what it had goes on the first), a page is renamed and titled,
 * components and queries land on the page being edited, a Navigation component on every page moves between them
 * in the preview and in the published app, and deleting a page takes what's on it.
 */
test('build a multipage app in the editor', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `edpages-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Paged' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'hello', type: 'text', props: { value: 'Hello from the start' } }],
      queries: [],
      layout: { hello: { x: 0, y: 0, w: 6, h: 3 } },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  const pages = page.getByRole('region', { name: 'Pages' })
  await expect(page.getByTestId('frame-hello')).toBeVisible()

  // The first page added: what the app had goes on page1, the new page2 is empty and being edited.
  await pages.getByRole('button', { name: 'Add a page' }).click()
  await expect(pages.getByRole('button', { name: 'page2' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('frame-hello')).toHaveCount(0)
  await expect(page.getByText('On every page')).toBeVisible()

  // Rename and title it.
  await pages.getByLabel('Page name').fill('detail')
  await pages.getByLabel('Page name').press('Enter')
  // Typed key by key, spaces and all.
  await pages.getByLabel('Page title').pressSequentially('Order details')
  await expect(pages.getByLabel('Page title')).toHaveValue('Order details')
  await pages.getByLabel('Page title').fill('Details')
  await expect(pages.getByRole('button', { name: /Details/ })).toHaveAttribute('aria-current', 'page')
  await pages.getByLabel('Page name').fill('edit')
  await expect(pages.getByText(/is the app's editor/)).toBeVisible()
  await pages.getByLabel('Page name').press('Escape')

  // A text on this page, reading the page's parameter; a query on it too.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(page.getByTestId('grid-page').getByTestId('frame-text1')).toBeVisible()
  await typeInto(
    page,
    page.locator('[data-testid$="/props/value"]').first(),
    'On {{ url.page }} for {{ url.params.id }}',
  )
  // The draft runs on the page being edited, even one added and renamed a moment ago.
  await expect(page.getByTestId('frame-text1')).toContainText('On detail for')
  await page.getByTitle('Add a JS query').click()
  await expect(page.getByTestId('query-query1').getByLabel('Page')).toHaveValue('detail')

  // A Navigation component, moved onto every page: it shows in the frame.
  await page.getByRole('button', { name: 'Navigation', exact: true }).click()
  await page.getByTestId('inspector-navigation1').getByLabel('Page').selectOption('')
  await expect(page.getByTestId('grid-frame').getByTestId('frame-navigation1')).toBeVisible()

  // Back on page1: what the app had, and the navigation above it.
  await pages.getByRole('button', { name: 'page1' }).click()
  await expect(page.getByTestId('grid-page').getByTestId('frame-hello')).toBeVisible()
  await expect(page.getByTestId('frame-text1')).toHaveCount(0)
  await expect(page.getByTestId('frame-navigation1')).toBeVisible()

  // In the preview, the navigation moves between the pages.
  await page.getByRole('button', { name: 'Preview' }).click()
  const nav = page.getByRole('navigation', { name: 'navigation1' })
  // Navigation's links are links since M24.
  await expect(nav.getByRole('link', { name: 'page1' })).toHaveAttribute('aria-current', 'page')
  await nav.getByRole('link', { name: 'Details' }).click()
  await expect(page.locator('[data-component="text1"]')).toContainText('On detail for')
  await expect(page.locator('[data-component="hello"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })

  // Saved as built: pages in order, things on their pages, the navigation global.
  const saved = await appGet(page, slug)
  expect(saved.definition.pages).toEqual([{ name: 'page1' }, { name: 'detail', title: 'Details' }])
  const pageOf = (name: string) => saved.definition.components.find((c) => c.name === name)?.page
  expect([pageOf('hello'), pageOf('text1'), pageOf('navigation1')]).toEqual(['page1', 'detail', undefined])
  expect(saved.definition.queries.find((q) => q.name === 'query1')?.page).toBe('detail')

  // Published: the navigation changes the URL, and the tab names the page.
  await trpcMutate(page, 'apps.publish', { appId: saved.id, draftRevision: saved.draftRevision })
  await page.goto(`/apps/${slug}`)
  await expect(page.locator('[data-component="hello"]')).toContainText('Hello from the start')
  await expect(page).toHaveTitle('page1 · Paged')
  await page.getByRole('navigation', { name: 'navigation1' }).getByRole('link', { name: 'Details' }).click()
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}/detail$`))
  await expect(page).toHaveTitle('Details · Paged')
  await expect(page.locator('[data-component="text1"]')).toContainText('On detail for')

  // Deleting a page takes what's on it.
  await page.goto(`/apps/${slug}/edit`)
  await pages.getByRole('button', { name: /Details/ }).click()
  page.once('dialog', (d) => {
    expect(d.message()).toBe('Delete page detail and the 2 components, queries and transformers on it?')
    void d.accept()
  })
  await pages.getByRole('button', { name: 'Delete the page' }).click()
  await expect(pages.getByRole('button', { name: 'page1' })).toHaveAttribute('aria-current', 'page')
  await expect(pages.getByRole('button', { name: /Details/ })).toHaveCount(0)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  const after = await appGet(page, slug)
  expect(after.definition.components.map((c) => c.name).sort()).toEqual(['hello', 'navigation1'])
  expect(after.definition.queries).toEqual([])
  expect(errors).toEqual([])
})
