import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * Navigation's links (M24): real links (an address to open in a new tab), icons, a group as a dropdown, URL params,
 * an outside link in a new tab, a link hidden by a condition; and the links edited as a list in the editor.
 */
test('links to pages and beyond, with icons, groups and conditions', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `nav-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Navigated' })
  const text = (name: string, pageName: string, value: string) => ({
    name,
    type: 'text',
    page: pageName,
    props: { value },
  })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      pages: [{ name: 'home', title: 'Home' }, { name: 'orders', title: 'Orders' }, { name: 'report' }],
      frame: { header: true },
      components: [
        {
          name: 'nav',
          type: 'navigation',
          props: {
            items: [
              { page: 'home', icon: 'home' },
              {
                label: 'Sales',
                icon: 'cart',
                items: [
                  { page: 'orders', params: { status: 'open' } },
                  { page: 'report', label: 'Report' },
                ],
              },
              { url: 'https://example.com/docs', label: 'Docs', icon: 'external' },
              {
                page: 'report',
                label: 'Secret',
                hidden: '{{ current_user.email !== "nobody@example.com" }}',
              },
            ],
          },
        },
        text('homeText', 'home', 'Welcome home'),
        text('ordersText', 'orders', 'Orders: {{ url.params.status }}'),
        text('reportText', 'report', 'The report'),
      ],
      queries: [],
      transformers: [],
      variables: [],
      layout: {
        nav: { x: 0, y: 0, w: 12, h: 3 },
        homeText: { x: 0, y: 0, w: 6, h: 2 },
        ordersText: { x: 0, y: 0, w: 6, h: 2 },
        reportText: { x: 0, y: 0, w: 6, h: 2 },
      },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  const nav = page.getByRole('navigation', { name: 'nav' })

  await test.step('real links, the page shown marked, a hidden one left out', async () => {
    await page.goto(`/apps/${slug}`)
    await expect(page.getByText('Welcome home')).toBeVisible()
    const home = nav.getByRole('link', { name: 'Home' })
    await expect(home).toHaveAttribute('aria-current', 'page')
    await expect(home).toHaveAttribute('href', new RegExp(`/apps/${slug}/home`))
    await expect(nav.locator('svg').first()).toBeVisible()
    const docs = nav.getByRole('link', { name: 'Docs' })
    await expect(docs).toHaveAttribute('href', 'https://example.com/docs')
    await expect(docs).toHaveAttribute('target', '_blank')
    await expect(nav.getByRole('link', { name: 'Secret' })).toHaveCount(0)
  })

  await test.step('a group’s dropdown opens a page in place, with its params', async () => {
    await nav.getByRole('button', { name: 'Sales' }).click()
    const orders = nav.getByRole('link', { name: 'Orders' })
    await expect(orders).toHaveAttribute('href', /\/orders\?status=open/)
    await orders.click()
    await expect(page).toHaveURL(new RegExp(`/apps/${slug}/orders\\?status=open`))
    await expect(page.getByText('Orders: open')).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Orders' })).toHaveCount(0)
    // The group is marked while one of its pages is shown.
    await expect(nav.getByRole('button', { name: 'Sales' })).toHaveClass(/text-accent/)
  })

  await test.step('a modifier-click opens the page in a new tab, from its address', async () => {
    await nav.getByRole('button', { name: 'Sales' }).click()
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      nav.getByRole('link', { name: 'Report' }).click({ modifiers: ['ControlOrMeta'] }),
    ])
    await expect(tab).toHaveURL(new RegExp(`/apps/${slug}/report`))
    await expect(tab.getByText('The report')).toBeVisible()
    await tab.close()
    await expect(page.getByText('Orders: open')).toBeVisible()
  })

  await test.step('in the editor: the links as a list', async () => {
    await page.goto(`/apps/${slug}/edit`)
    await page.getByTestId('frame-nav').click()
    const editor = page.getByTestId('nav-items-nav')
    await expect(editor.getByTestId('nav-item-0-1')).toContainText('2 links')
    await editor.getByRole('button', { name: 'Add link' }).last().click()
    const added = editor.getByTestId('nav-item-0-4')
    await added.getByLabel('Page').selectOption('report')
    await added.getByLabel('Label').fill('Reports')
    await added.getByLabel('Icon').selectOption('chart')
    await expect(page.locator('[data-component="nav"]').getByRole('link', { name: 'Reports' })).toBeVisible()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    const draft = await trpcQuery<{ draftDefinition: { components: { props?: { items?: unknown[] } }[] } }>(
      page,
      'apps.get',
      { slug },
    )
    expect(draft.draftDefinition.components[0]!.props!.items!.at(-1)).toEqual({
      page: 'report',
      label: 'Reports',
      icon: 'chart',
    })
  })
  expect(errors).toEqual([])
})
