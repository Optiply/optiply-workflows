import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * The Apps page (session 40, as the Workflows page): rows with the live version and last editor, a search across every
 * folder, sorting remembered per browser, and a folder tree that takes dragged apps.
 */

const DEF = {
  schemaVersion: 1,
  components: [{ name: 'hello', type: 'text', props: { value: 'Hello' } }],
  queries: [],
  layout: { hello: { x: 0, y: 0, w: 4, h: 2 } },
}

async function app(page: Page, slug: string, publish: boolean) {
  const created = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
  const saved = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
    id: created.id,
    revision: 1,
    definition: DEF,
  })
  if (publish) await trpcMutate(page, 'apps.publish', { appId: created.id, draftRevision: saved.revision })
  return created.id
}

test('search, sort by last published, and drag apps onto the folder tree', async ({ page }) => {
  await signIn(page)
  const t = Date.now().toString(36)
  const sales = await trpcMutate<{ id: string }>(page, 'folders.create', { name: `Sales ${t}`, type: 'app' })
  const reports = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: `Reports ${t}`,
    type: 'app',
    parentId: sales.id,
  })
  const live = await app(page, `zz-live-${t}`, true)
  await trpcMutate(page, 'apps.update', { id: live, folderId: reports.id })
  await app(page, `aa-draft-${t}`, false)

  await page.goto('/apps')
  const search = page.getByRole('searchbox', { name: 'Search apps' })
  await search.fill(`live ${t}`)
  const results = page.getByRole('region', { name: 'Search results' })
  const row = results.getByTestId(`app-zz-live-${t}`)
  await expect(row.getByTestId('app-folder')).toHaveText(`Sales ${t}/Reports ${t}`)
  await expect(row.getByTestId('app-published')).toHaveText(/^v1\.0\.0 · just now$/)
  await expect(row).toContainText('edited just now by')

  // Last published first; never published last; remembered.
  await search.fill(t)
  await page.getByRole('combobox', { name: 'Sort apps' }).selectOption('published')
  const order = () =>
    results
      .locator(`[data-testid^="app-"][data-testid$="-${t}"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  await expect.poll(order).toEqual([`app-zz-live-${t}`, `app-aa-draft-${t}`])
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Sort apps' })).toHaveValue('published')
  await expect(page.getByTestId(`app-aa-draft-${t}`).getByText('Never published')).toBeVisible()

  // The tree counts through subfolders; a dragged app moves there, and back out on "All apps".
  const tree = page.getByRole('navigation', { name: 'Folders' })
  const salesNode = tree.getByTestId(`tree-folder-Sales ${t}`)
  await expect(salesNode).toContainText('1')
  const draft = page.getByTestId(`app-aa-draft-${t}`)
  await draft.dragTo(salesNode)
  await expect(salesNode).toContainText('2')
  await expect(draft).toHaveCount(0)
  await salesNode.getByRole('button', { name: `Sales ${t}`, exact: true }).click()
  const inSales = page.getByRole('region', { name: `Folder Sales ${t}` }).getByTestId(`app-aa-draft-${t}`)
  await expect(inSales).toBeVisible()
  await inSales.dragTo(tree.getByTestId('tree-all'))
  await expect(salesNode).toContainText('1')
})
