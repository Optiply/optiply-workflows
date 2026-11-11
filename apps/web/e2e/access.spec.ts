import { expect, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/** Access (session 44): sharing with one person, a group's level on all workflows, a person's page, the sidebar. */

// What a test made, removed after it: the member is shared by every spec, and others expect them to have only Use
// (collab, workflow-undo) or no apps (m10). Deleting a group, workflow or app drops its grants.
const made: { kind: 'groups' | 'workflows' | 'apps'; id: string }[] = []
test.afterEach(async ({ page }) => {
  for (const { kind, id } of made.splice(0).reverse()) {
    await trpcMutate(page, `${kind}.delete`, { id }).catch(() => {})
  }
})

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
  made.push({ kind: 'workflows', id: flow.id })
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
    made.push({ kind: 'groups', id: group.id })
    await trpcMutate(page, 'groups.addMember', { groupId: group.id, userId: member.id })
    await page.goto(`/settings/groups/${group.id}`)
    const select = page.getByLabel(`Workflows for Builders ${stamp}`)
    await select.selectOption({ label: 'Edit all, and create' })
    await page.reload()
    await expect(page.getByLabel(`Workflows for Builders ${stamp}`)).toHaveValue('edit')
    // Through the group the member can now change it, and create workflows.
    await memberPage.reload()
    await expect(memberPage.getByTestId(`workflow-shared-${stamp}`)).toContainText('Can edit')
    const mine = await trpcMutate<{ id: string }>(memberPage, 'workflows.create', {
      slug: `mine-${stamp}`,
      name: `Mine ${stamp}`,
    })
    made.push({ kind: 'workflows', id: mine.id })
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

test('the sidebar shows only the sections someone can reach', async ({ page, browser }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
    slug: `reach-${stamp}`,
    name: `Reach ${stamp}`,
  })
  made.push({ kind: 'apps', id: app.id })
  const people = await trpcQuery<{ id: string; email: string }[]>(page, 'users.directory', undefined)
  const member = people.find((p) => p.email === E2E_MEMBER_EMAIL)!
  await trpcMutate(page, 'permissions.set', {
    objectType: 'app',
    objectId: app.id,
    userId: member.id,
    environmentId: null,
    level: 'use',
  })
  const memberPage = await (await browser.newContext()).newPage()
  await signIn(memberPage, E2E_MEMBER_EMAIL)
  type Me = { sections: Record<string, boolean>; canCreate: Record<string, boolean> }
  const me = await trpcQuery<Me>(memberPage, 'me', undefined)
  expect(me.sections.apps).toBe(true)

  // Other specs share things with the member too: the sidebar matches what the server says, section by section.
  const LABELS: Record<string, [string, string]> = {
    workflows: ['Workflows', '/workflows'],
    apps: ['Apps', '/apps'],
    library: ['Library', '/library'],
    modules: ['Modules', '/modules'],
    componentLibraries: ['Components', '/component-libraries'],
    resources: ['Resources', '/resources'],
    database: ['Database', '/database'],
    runs: ['Runs', '/runs'],
    inbox: ['Inbox', '/inbox'],
  }
  const nav = memberPage.getByRole('navigation', { name: 'Main' })
  for (const [key, [label]] of Object.entries(LABELS)) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(me.sections[key] ? 1 : 0)
  }
  // A section they can't reach, typed in: why, not an empty list.
  const hidden = Object.entries(LABELS).find(([key]) => !me.sections[key])
  if (hidden) {
    await memberPage.goto(hidden[1][1])
    await expect(memberPage.getByText(`No access to ${hidden[1][0]}`)).toBeVisible()
  }
  // New app only for those who may create apps; the app itself is there to use.
  await memberPage.goto('/apps')
  await expect(memberPage.getByRole('button', { name: 'New app' })).toHaveCount(me.canCreate.apps ? 1 : 0)
  await expect(memberPage.getByTestId(`app-reach-${stamp}`)).toBeVisible()
  // ⌘K's pages are the same sections.
  await memberPage.keyboard.press('ControlOrMeta+k')
  const palette = memberPage.getByRole('dialog', { name: 'Go to' })
  for (const [key, [label]] of Object.entries(LABELS)) {
    await expect(palette.getByRole('option', { name: label, exact: true })).toHaveCount(
      me.sections[key] ? 1 : 0,
    )
  }
})

test('someone with Use on an app gets the app, never the editor', async ({ page, browser }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const slug = `use-${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: `Use only ${stamp}` })
  made.push({ kind: 'apps', id: app.id })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'hello', type: 'text', props: { value: `Hello ${stamp}` } }],
      queries: [],
      layout: { hello: { x: 0, y: 0, w: 4, h: 2 } },
    },
  })
  const people = await trpcQuery<{ id: string; email: string }[]>(page, 'users.directory', undefined)
  const member = people.find((p) => p.email === E2E_MEMBER_EMAIL)!
  const memberPage = await (await browser.newContext()).newPage()
  await signIn(memberPage, E2E_MEMBER_EMAIL)

  await test.step('without access: told so, no editor offered', async () => {
    await memberPage.goto(`/apps/${slug}`)
    await expect(memberPage.getByText("You don't have access to this app")).toBeVisible()
    await expect(memberPage.getByRole('link', { name: 'Open the editor' })).toHaveCount(0)
  })

  await trpcMutate(page, 'permissions.set', {
    objectType: 'app',
    objectId: app.id,
    userId: member.id,
    environmentId: null,
    level: 'use',
  })
  await test.step('with Use, before it’s published: waiting for its owner', async () => {
    await memberPage.goto(`/apps/${slug}`)
    await expect(memberPage.getByText('You can use this app once its owner publishes it.')).toBeVisible()
    await expect(memberPage.getByRole('link', { name: 'Open the editor' })).toHaveCount(0)
  })

  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  await test.step('published: the app runs, with no way into the editor', async () => {
    await memberPage.goto(`/apps/${slug}`)
    await expect(memberPage.getByText(`Hello ${stamp}`)).toBeVisible()
    await expect(memberPage.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0)
    await memberPage.goto(`/apps/${slug}/edit`)
    await expect(memberPage).toHaveURL(new RegExp(`/apps/${slug}$`))
    await expect(memberPage.getByText(`Hello ${stamp}`)).toBeVisible()
  })

  await test.step('the owner, before publishing, is offered the editor', async () => {
    const draft = await trpcMutate<{ id: string }>(page, 'apps.create', {
      slug: `draft-${stamp}`,
      name: `Draft ${stamp}`,
    })
    made.push({ kind: 'apps', id: draft.id })
    await page.goto(`/apps/draft-${stamp}`)
    await expect(page.getByText('Not published yet')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open the editor' })).toBeVisible()
  })
})
