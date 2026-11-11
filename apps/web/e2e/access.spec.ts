import { expect, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/** Access (session 44, step 1): sharing with one person, a group's level on all workflows, a person's page. */

test('share a workflow with one person, give a group every workflow, and see it on their pages', async ({
  page,
  browser,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `shared-${stamp}`,
    name: `Shared ${stamp}`,
  })
  const people = await trpcQuery<{ id: string; email: string; name: string }[]>(
    page,
    'users.directory',
    undefined,
  )
  const member = people.find((p) => p.email === E2E_MEMBER_EMAIL)!

  await test.step('the workflow’s Access: Use for one person', async () => {
    await page.goto(`/workflows/${flow.id}`)
    await page.getByRole('banner').getByTitle('Access').click()
    const access = page.getByRole('dialog', { name: `Who can use Shared ${stamp}` })
    await access.getByLabel('Group or person').selectOption({ label: `${member.name} (${member.email})` })
    await access.getByRole('button', { name: 'Grant' }).click()
    await expect(access.getByTestId('grant-row').filter({ hasText: member.email })).toContainText(member.name)
  })

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  await test.step('the member sees it, read-only', async () => {
    await signIn(memberPage, E2E_MEMBER_EMAIL)
    await memberPage.goto('/workflows')
    await expect(memberPage.getByTestId(`workflow-shared-${stamp}`)).toContainText('Can run')
  })

  await test.step('a group’s Access: Edit on every workflow', async () => {
    const group = await trpcMutate<{ id: string }>(page, 'groups.create', { name: `Builders ${stamp}` })
    await trpcMutate(page, 'groups.addMember', { groupId: group.id, userId: member.id })
    await page.goto(`/settings/groups/${group.id}`)
    const select = page.getByLabel(`Workflows for Builders ${stamp}`)
    await select.selectOption({ label: 'Edit all, and create' })
    await page.reload()
    await expect(page.getByLabel(`Workflows for Builders ${stamp}`)).toHaveValue('edit')
    // Through the group the member can now change it, and create workflows.
    await memberPage.reload()
    await expect(memberPage.getByTestId(`workflow-shared-${stamp}`)).toContainText('Can edit')
    await trpcMutate(memberPage, 'workflows.create', { slug: `mine-${stamp}`, name: `Mine ${stamp}` })
  })

  await test.step('the person’s page lists what’s shared with them', async () => {
    await page.goto('/settings/users')
    await page.getByRole('link', { name: member.name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/settings/users/${member.id}$`))
    await expect(page.getByTestId('subject-grant').filter({ hasText: `Shared ${stamp}` })).toContainText(
      'Workflow',
    )
    await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toContainText(member.name)
  })
  await memberContext.close()
})
