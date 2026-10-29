import { expect, type Locator, type Page, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/** The folder path's links and the folder open, as read. */
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Folder path' })
/** The Edit folder dialog's Inside option for that path (other runs leave folders of their own). */
const option = (dialog: Locator, path: string) =>
  dialog
    .getByLabel('Inside')
    .locator('option')
    .filter({ hasText: new RegExp(`^${path}$`) })

/**
 * Folders for workflows and apps, as for resources, one folder open at a time: the path to it, its subfolders, then
 * what's in it. Folders are made inside the one open, items moved into them from their row, renamed and moved
 * (never into themselves), their access opened from them, and deleting one leaves what it held at the top. Each
 * kind's folders are its own.
 */
test('nested folders on the workflows and apps lists', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const stamp = Date.now()
  const flows = `Flows ${stamp}`
  const tools = `Tools ${stamp}`
  await trpcMutate(page, 'workflows.create', { slug: `fold-${stamp}`, name: `Folded ${stamp}` })

  // Workflows: a folder at the top, and the workflow moved into it from its row.
  await page.goto('/workflows')
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill(flows)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const flowsRow = page.getByRole('listitem', { name: `Subfolder ${flows}` })
  await expect(flowsRow).toContainText('Empty')
  await page.getByLabel(`Folder of Folded ${stamp}`).selectOption({ label: flows })
  await expect(flowsRow).toContainText('1 workflow')
  await expect(page.getByTestId(`workflow-fold-${stamp}`)).toHaveCount(0)

  // Opened: the path, and what's inside; the address keeps it.
  await flowsRow.getByRole('link', { name: flows }).click()
  await expect(page).toHaveURL(/\?folder=/)
  await expect(crumbs(page)).toHaveText(`All workflows${flows}`)
  const inFlows = page.getByRole('region', { name: `Folder ${flows}` })
  await expect(inFlows.getByTestId(`workflow-fold-${stamp}`)).toBeVisible()
  await page.reload()
  await expect(inFlows.getByTestId(`workflow-fold-${stamp}`)).toBeVisible()

  // A subfolder made inside the one open; a new workflow there starts in it.
  await page.getByRole('button', { name: 'New folder' }).click()
  await expect(page.getByRole('heading', { name: `New folder in ${flows}` })).toBeVisible()
  await page.getByLabel('Folder name').fill('Reports')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page
    .getByRole('listitem', { name: 'Subfolder Reports' })
    .getByRole('link', { name: 'Reports' })
    .click()
  await expect(crumbs(page)).toHaveText(`All workflows${flows}Reports`)
  await expect(page.getByRole('region', { name: `Folder ${flows}/Reports` })).toContainText('Empty folder.')
  await page.getByRole('button', { name: 'New workflow' }).click()
  await expect(page.getByLabel('Folder', { exact: true }).locator('option:checked')).toHaveText(
    `${flows}/Reports`,
  )
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Admins open a folder's access from it.
  await page.getByRole('button', { name: 'Access' }).click()
  const access = page.getByRole('dialog', { name: 'Access to Reports' })
  await expect(access).toContainText(
    'Grants on this folder apply to every workflow inside it and in its subfolders.',
  )
  await page.keyboard.press('Escape')

  // Renamed and moved to the top from its row in the folder above.
  await crumbs(page).getByRole('link', { name: flows }).click()
  await page.getByTitle('Edit folder Reports').click()
  const edit = page.getByRole('dialog', { name: 'Edit folder Reports' })
  // Never into itself.
  await expect(option(edit, flows)).toHaveCount(1)
  await expect(option(edit, `${flows}/Reports`)).toHaveCount(0)
  await edit.getByLabel('Name').fill(`Weekly ${stamp}`)
  await edit.getByLabel('Inside').selectOption({ label: 'The top level' })
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toHaveCount(0)
  await expect(page.getByRole('listitem', { name: /^Subfolder / })).toHaveCount(0)
  await crumbs(page).getByRole('link', { name: 'All workflows' }).click()
  await expect(page.getByRole('listitem', { name: `Subfolder Weekly ${stamp}` })).toBeVisible()

  // Flows moved into Weekly: Weekly can't then go into Flows, which is inside it now.
  await page.getByTitle(`Edit folder ${flows}`).click()
  await page
    .getByRole('dialog')
    .getByLabel('Inside')
    .selectOption({ label: `Weekly ${stamp}` })
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  const weeklyRow = page.getByRole('listitem', { name: `Subfolder Weekly ${stamp}` })
  await expect(weeklyRow).toContainText('1 folder')
  await weeklyRow.getByTitle(`Edit folder Weekly ${stamp}`).click()
  await expect(option(page.getByRole('dialog'), `Weekly ${stamp}`)).toHaveCount(0)
  await expect(option(page.getByRole('dialog'), `Weekly ${stamp}/${flows}`)).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  // A folder holding folders can't be deleted.
  await expect(weeklyRow.getByTitle('Delete or move its subfolders first')).toBeDisabled()

  // Deleting the open folder asks, goes up, and leaves what it held at the top.
  await weeklyRow.getByRole('link', { name: `Weekly ${stamp}` }).click()
  await page
    .getByRole('listitem', { name: `Subfolder ${flows}` })
    .getByRole('link', { name: flows })
    .click()
  await expect(crumbs(page)).toHaveText(`All workflowsWeekly ${stamp}${flows}`)
  await page.getByTitle(`Delete folder ${flows}`).click()
  const asked = page.getByRole('dialog', { name: 'Are you sure?' })
  await expect(asked).toContainText(`Delete folder "${flows}"? Its workflows move to the top level.`)
  await asked.getByTestId('confirm-ok').click()
  await expect(crumbs(page)).toHaveText(`All workflowsWeekly ${stamp}`)
  await crumbs(page).getByRole('link', { name: 'All workflows' }).click()
  await expect(page.getByTestId(`workflow-fold-${stamp}`)).toBeVisible()

  // Apps: each kind's folders are its own; a new app made in the folder open starts in it.
  await page.goto('/apps')
  await expect(page.getByRole('listitem', { name: `Subfolder Weekly ${stamp}` })).toHaveCount(0)
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill(tools)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page
    .getByRole('listitem', { name: `Subfolder ${tools}` })
    .getByRole('link', { name: tools })
    .click()
  await page.getByRole('button', { name: 'New app' }).click()
  await page.getByLabel('Name', { exact: true }).fill(`Foldered app ${stamp}`)
  await expect(page.getByLabel('Folder', { exact: true }).locator('option:checked')).toHaveText(tools)
  await page.getByRole('button', { name: 'Create app' }).click()
  await expect(page).toHaveURL(/\/edit$/)
  await page.goBack()
  const toolsFolder = page.getByRole('region', { name: `Folder ${tools}` })
  await expect(toolsFolder).toContainText(`Foldered app ${stamp}`)
  // Moved back out from its row.
  await page.getByLabel(`Folder of Foldered app ${stamp}`).selectOption({ label: 'Not in a folder' })
  await expect(toolsFolder).toContainText('Empty folder.')

  // Resource folders stay on their own page.
  await page.goto('/resources')
  await expect(page.getByRole('listitem', { name: `Subfolder ${tools}` })).toHaveCount(0)
  expect(errors).toEqual([])
})
