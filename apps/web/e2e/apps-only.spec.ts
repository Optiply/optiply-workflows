import { expect, type Page, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * Access to apps only: an admin switches a person on their page; that person lands on "Your apps", uses the app
 * shared with them, finds no way into the platform, and is sent back from its links.
 */

// The member is shared by every spec: back to the whole platform and no apps of ours afterwards.
let memberId: string | undefined
const made: string[] = []
test.afterEach(async ({ page }) => {
  if (memberId)
    await trpcMutate(page, 'users.setAccess', { userId: memberId, access: 'full' }).catch(() => {})
  for (const id of made.splice(0)) await trpcMutate(page, 'apps.delete', { id }).catch(() => {})
})

async function publishedApp(page: Page, slug: string, name: string, text: string) {
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name })
  made.push(app.id)
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'hello', type: 'text', props: { value: text } }],
      queries: [],
      layout: { hello: { x: 0, y: 0, w: 6, h: 3 } },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  return app
}

test('someone with access to apps only uses their app and never reaches the platform', async ({
  page,
  browser,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const app = await publishedApp(page, `stock-${stamp}`, `Stock ${stamp}`, 'Stock for partners')
  await publishedApp(page, `finance-${stamp}`, `Finance ${stamp}`, 'Finance numbers')
  const people = await trpcQuery<{ id: string; email: string }[]>(page, 'users.directory', undefined)
  memberId = people.find((p) => p.email === E2E_MEMBER_EMAIL)!.id
  await trpcMutate(page, 'permissions.set', {
    objectType: 'app',
    objectId: app.id,
    userId: memberId,
    environmentId: null,
    level: 'use',
  })

  await test.step('an admin switches them to apps only on their page', async () => {
    await page.goto(`/settings/users/${memberId}`)
    const section = page.getByRole('region', { name: 'Access type' })
    await section.getByText('Apps only', { exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Apps only' }).click()
    await expect(page.getByRole('heading', { name: 'Member' }).getByText('Apps only')).toBeVisible()
    // Only apps count for them now: the Apps row alone.
    await expect(
      page.getByRole('region', { name: 'Access' }).getByText('Workflows', { exact: true }),
    ).toBeHidden()
    await page.goto('/settings/users')
    await page.getByRole('button', { name: /^Apps only/ }).click()
    await expect(page.getByRole('link', { name: 'Member' })).toBeVisible()
  })

  const memberContext = await browser.newContext()
  const member = await memberContext.newPage()
  await test.step('they land on their apps: the one shared with them, not the one everyone else has', async () => {
    await signIn(member, E2E_MEMBER_EMAIL)
    await expect(member).toHaveURL(/\/my-apps$/)
    await expect(member.getByRole('heading', { name: 'Your apps' })).toBeVisible()
    await expect(member.getByTestId(`my-app-stock-${stamp}`)).toBeVisible()
    await expect(member.getByTestId(`my-app-finance-${stamp}`)).toHaveCount(0)
  })

  await test.step('they use it; the account menu offers their apps, not the platform', async () => {
    await member.getByTestId(`my-app-stock-${stamp}`).click()
    await expect(member.getByText('Stock for partners')).toBeVisible()
    await member.getByRole('button', { name: 'Account' }).click()
    await expect(member.getByRole('menuitem', { name: 'Open Optiply Workflows' })).toHaveCount(0)
    await member.getByRole('menuitem', { name: 'Your apps' }).click()
    await expect(member).toHaveURL(/\/my-apps$/)
  })

  await test.step('platform links send them back; another app is refused', async () => {
    for (const path of ['/workflows', '/', '/settings/users', `/apps/stock-${stamp}/edit`]) {
      await member.goto(path)
      await expect(member).toHaveURL(/\/my-apps$/)
    }
    await member.goto(`/apps/finance-${stamp}`)
    await expect(member.getByText("You don't have access to this app")).toBeVisible()
  })

  await test.step('back to the whole platform: the sidebar returns', async () => {
    await trpcMutate(page, 'users.setAccess', { userId: memberId, access: 'full' })
    await member.goto('/apps')
    await expect(member.getByRole('navigation').getByRole('link', { name: 'Apps' })).toBeVisible()
  })

  await test.step('switched while in the platform: their next click takes them to their apps', async () => {
    await trpcMutate(page, 'users.setAccess', { userId: memberId, access: 'apps_only' })
    // ⌘K asks the server for the platform's lists, which it now refuses them; no reload needed. (A background
    // refetch may be refused first and take them there before the click: the same handling.)
    await member
      .getByText('Search…')
      .click({ timeout: 5_000 })
      .catch(() => {})
    await expect(member).toHaveURL(/\/my-apps$/)
    await expect(member.getByRole('heading', { name: 'Your apps' })).toBeVisible()
  })
  await memberContext.close()
})
