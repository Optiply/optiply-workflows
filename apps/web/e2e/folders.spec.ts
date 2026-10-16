import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Folders for workflows and apps, as for resources: made on their list page, items moved into them from their row,
 * a folder's access opened from its header, and deleting one leaves what it held at the top. Each kind's folders
 * are its own.
 */
test('folders on the workflows and apps lists', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const stamp = Date.now()
  const flows = `Flows ${stamp}`
  const tools = `Tools ${stamp}`
  await trpcMutate(page, 'workflows.create', { slug: `fold-${stamp}`, name: `Folded ${stamp}` })

  // Workflows: a folder, and the workflow moved into it from its row.
  await page.goto('/workflows')
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill(flows)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const flowsFolder = page.getByRole('region', { name: `Folder ${flows}` })
  await expect(flowsFolder).toContainText('Empty folder.')
  await page.getByLabel(`Folder of Folded ${stamp}`).selectOption({ label: flows })
  await expect(flowsFolder.getByTestId(`workflow-fold-${stamp}`)).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('region', { name: `Folder ${flows}` }).getByTestId(`workflow-fold-${stamp}`),
  ).toBeVisible()

  // Admins open a folder's access from its header.
  await page
    .getByRole('region', { name: `Folder ${flows}` })
    .getByRole('button', { name: 'Access' })
    .click()
  await expect(page.getByText('Grants on this folder apply to every workflow inside it.')).toBeVisible()

  // Apps: a folder, and a new app created straight into it.
  await page.goto('/apps')
  // Each kind's folders are its own.
  await expect(page.getByRole('region', { name: `Folder ${flows}` })).toHaveCount(0)
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill(tools)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('region', { name: `Folder ${tools}` })).toBeVisible()
  await page.getByRole('button', { name: 'New app' }).click()
  await page.getByLabel('Name', { exact: true }).fill(`Foldered app ${stamp}`)
  await page.getByLabel('Folder', { exact: true }).selectOption({ label: tools })
  await page.getByRole('button', { name: 'Create app' }).click()
  await expect(page).toHaveURL(/\/edit$/)
  await page.goto('/apps')
  const toolsFolder = page.getByRole('region', { name: `Folder ${tools}` })
  await expect(toolsFolder).toContainText(`Foldered app ${stamp}`)
  // Moved back out from its row.
  await page.getByLabel(`Folder of Foldered app ${stamp}`).selectOption({ label: 'Not in a folder' })
  await expect(toolsFolder).toContainText('Empty folder.')

  // Deleting a folder leaves what it held at the top.
  await page.goto('/workflows')
  page.once('dialog', (d) => {
    expect(d.message()).toBe(`Delete folder "${flows}"? Its workflows move out of it.`)
    void d.accept()
  })
  await page
    .getByRole('region', { name: `Folder ${flows}` })
    .getByTitle('Delete folder')
    .click()
  await expect(page.getByRole('region', { name: `Folder ${flows}` })).toHaveCount(0)
  await expect(page.getByTestId(`workflow-fold-${stamp}`)).toBeVisible()

  // Resource folders still work on their own page, and stay there.
  await page.goto('/resources')
  await expect(page.getByRole('region', { name: `Folder ${tools}` })).toHaveCount(0)
  expect(errors).toEqual([])
})
