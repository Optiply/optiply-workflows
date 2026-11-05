import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * The Workflows page (session 40): rows with the last run, live triggers and last editor; a search across every
 * folder; sorting, remembered per browser.
 */

async function workflow(page: Page, slug: string, extra: object = {}) {
  const created = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  const saved = await trpcMutate<{ revision: number }>(page, 'workflows.saveDraft', {
    id: created.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'a', type: 'code', config: { code: 'return 1' } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'a' }],
      ...extra,
    },
  })
  return { id: created.id, revision: saved.revision }
}

test('search every folder, sort by last run, and see each workflow’s run and triggers', async ({ page }) => {
  await signIn(page)
  const t = Date.now().toString(36)
  const folder = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: `Billing ${t}`,
    type: 'workflow',
  })
  const ran = await workflow(page, `zz-ran-${t}`, { triggers: { webhook: { enabled: true } } })
  await trpcMutate(page, 'releases.publish', { workflowId: ran.id, draftRevision: ran.revision })
  await trpcMutate(page, 'workflows.update', { id: ran.id, folderId: folder.id })
  const idle = await workflow(page, `aa-idle-${t}`)
  const started = await page.request.post(`/api/v1/workflows/zz-ran-${t}/runs?environment=production`, {
    data: { input: {} },
  })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run.id as string

  await page.goto('/workflows')
  const search = page.getByRole('searchbox', { name: 'Search workflows' })
  // Found inside its folder, with the folder named.
  await search.fill(`ran ${t}`)
  const results = page.getByRole('region', { name: 'Search results' })
  const row = results.getByTestId(`workflow-zz-ran-${t}`)
  await expect(row).toBeVisible()
  await expect(row.getByTestId('workflow-folder')).toHaveText(`Billing ${t}`)
  await expect(row.getByRole('img', { name: '1 webhook' })).toBeVisible()
  await expect(row.getByTestId('workflow-last-run')).toContainText(/succeeded|running|queued/)
  await expect(row).toContainText('edited just now by')
  await expect(results.getByTestId(`workflow-aa-idle-${t}`)).toHaveCount(0)
  await search.fill(`nothing-like-this ${t}`)
  await expect(page.getByText(`No workflows match “nothing-like-this ${t}”.`)).toBeVisible()

  // Sorted by last run: the one that ran comes before the one that never did, and the choice stays.
  await search.fill(t)
  await page.getByRole('combobox', { name: 'Sort workflows' }).selectOption('lastRun')
  const order = async () =>
    (await results
      .locator('[data-testid^="workflow-"][data-testid$="' + t + '"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))) as string[]
  await expect.poll(order).toEqual([`workflow-zz-ran-${t}`, `workflow-aa-idle-${t}`])
  await page.getByRole('combobox', { name: 'Sort workflows' }).selectOption('name')
  await expect.poll(order).toEqual([`workflow-aa-idle-${t}`, `workflow-zz-ran-${t}`])
  await page.getByRole('combobox', { name: 'Sort workflows' }).selectOption('lastRun')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Sort workflows' })).toHaveValue('lastRun')
  await expect(page.getByTestId(`workflow-aa-idle-${t}`).getByText('Never run')).toBeVisible()

  // The last run opens in the editor.
  await search.fill(`ran ${t}`)
  await page.getByTestId(`workflow-zz-ran-${t}`).getByTestId('workflow-last-run').click()
  await expect(page).toHaveURL(new RegExp(`/workflows/${ran.id}\\?run=${runId}`))
  void idle
})

test('the folder tree opens folders, counts what they hold, and takes a dragged workflow', async ({
  page,
}) => {
  await signIn(page)
  const t = Date.now().toString(36)
  const parent = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: `Ops ${t}`,
    type: 'workflow',
  })
  const child = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: `Nightly ${t}`,
    type: 'workflow',
    parentId: parent.id,
  })
  const inChild = await workflow(page, `tree-in-${t}`)
  await trpcMutate(page, 'workflows.update', { id: inChild.id, folderId: child.id })
  await workflow(page, `tree-loose-${t}`)

  await page.goto('/workflows')
  const tree = page.getByRole('navigation', { name: 'Folders' })
  const opsNode = tree.getByTestId(`tree-folder-Ops ${t}`)
  // A folder counts what its subfolders hold.
  await expect(opsNode).toContainText('1')
  await tree.getByRole('button', { name: `Expand Ops ${t}` }).click()
  const nightlyNode = tree.getByTestId(`tree-folder-Nightly ${t}`)
  await expect(nightlyNode).toContainText('1')

  // Dragged from the top level onto a nested folder: it moves there.
  const loose = page.getByTestId(`workflow-tree-loose-${t}`)
  await loose.dragTo(nightlyNode)
  await expect(nightlyNode).toContainText('2')
  await expect(opsNode).toContainText('2')
  await expect(loose).toHaveCount(0)

  // Opening the folder from the tree shows it; dropped on "All workflows", it leaves every folder.
  await nightlyNode.getByRole('button', { name: `Nightly ${t}` }).click()
  await expect(page).toHaveURL(new RegExp(`folder=${child.id}`))
  const moved = page
    .getByRole('region', { name: `Folder Ops ${t}/Nightly ${t}` })
    .getByTestId(`workflow-tree-loose-${t}`)
  await expect(moved).toBeVisible()
  await moved.dragTo(tree.getByTestId('tree-all'))
  await expect(nightlyNode).toContainText('1')
  await expect(moved).toHaveCount(0)
})
