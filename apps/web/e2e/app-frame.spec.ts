import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * The app frame (M24): a header bar and a sidebar set in the editor, components on every page placed in them, the
 * app's name and the signed-in person in the header; in the app the header stays while the page scrolls, and on a
 * narrow screen the sidebar waits behind a Menu button.
 */
test('frames an app with a header bar and a sidebar', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `frame-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Framed app' })
  const lines = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join('\n')
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      pages: [{ name: 'home', title: 'Home' }],
      components: [
        { name: 'greeting', type: 'text', props: { value: 'Hello from the frame' } },
        { name: 'links', type: 'text', props: { value: 'Side links' } },
        { name: 'body', type: 'text', page: 'home', props: { value: lines } },
      ],
      queries: [],
      transformers: [],
      variables: [],
      layout: {
        greeting: { x: 0, y: 0, w: 6, h: 2 },
        links: { x: 0, y: 2, w: 12, h: 2 },
        body: { x: 0, y: 0, w: 12, h: 120 },
      },
    },
  })

  await test.step('in the editor: the frame’s settings, and a component moved to the sidebar', async () => {
    await page.goto(`/apps/${slug}/edit`)
    const frame = page.getByRole('group', { name: 'Frame' })
    await frame.getByLabel('Header bar').check()
    await frame.getByLabel('Sidebar').selectOption('medium')
    await frame.getByLabel("Show the app's name").check()
    await frame.getByLabel("Show who's signed in").check()
    await expect(page.getByTestId('frame-sidebar')).toBeVisible()
    await expect(page.getByText('Header · on every page')).toBeVisible()
    await page.getByTestId('frame-links').click()
    await page.getByTestId('inspector-links').getByLabel('Area').selectOption('sidebar')
    await expect(page.getByTestId('frame-sidebar')).toContainText('Side links')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    const draft = await trpcQuery<{ draftDefinition: { frame: unknown } }>(page, 'apps.get', { slug })
    expect(draft.draftDefinition.frame).toEqual({
      header: true,
      sidebar: 'medium',
      showTitle: true,
      showUser: true,
    })
  })

  await test.step('in the app: the header stays while the page scrolls; the sidebar beside it', async () => {
    const revision = (await trpcQuery<{ draftRevision: number }>(page, 'apps.get', { slug })).draftRevision
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: revision })
    await page.goto(`/apps/${slug}`)
    const header = page.locator('[data-frame="header"]')
    await expect(header).toContainText('Framed app')
    await expect(header).toContainText('Hello from the frame')
    await expect(header.locator('[data-frame="user"]')).toBeVisible()
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
    await expect(sidebar).toContainText('Side links')
    const before = (await header.boundingBox())!.y
    await page.getByText('row 70').scrollIntoViewIfNeeded()
    await expect(page.getByText('row 70')).toBeInViewport()
    await expect(header).toBeInViewport()
    expect(Math.abs((await header.boundingBox())!.y - before)).toBeLessThan(40)
  })

  await test.step('on a narrow screen: the sidebar behind the Menu button', async () => {
    await page.setViewportSize({ width: 600, height: 900 })
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
    await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toContainText('Side links')
    // Over the page it covers the Menu button: a click beside it, or Escape, closes it.
    await page.getByRole('button', { name: 'Close the menu' }).click({ position: { x: 500, y: 450 } })
    await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(sidebar).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sidebar).toBeHidden()
  })
  expect(errors).toEqual([])
})
