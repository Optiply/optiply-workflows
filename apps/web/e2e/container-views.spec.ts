import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

type Def = {
  components: {
    name: string
    type: string
    parent?: string
    slot?: string
    props?: Record<string, unknown>
    events?: { action: { code?: string } }[]
  }[]
}

/**
 * Containers with views (M24): tabs in the editor and the app, only the shown view rendering, the palette adding
 * into the view on screen, a view renamed (its components and `setView('…')` in code follow) and removed (its
 * components moved), and a button switching views by code.
 */
test('switches, edits and renames a container’s views', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `views-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Views' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        {
          name: 'box',
          type: 'container',
          props: {
            title: 'Orders',
            views: [
              { name: 'list', label: 'List' },
              { name: 'details', label: '{{ "Details" }}' },
            ],
          },
        },
        { name: 'listText', type: 'text', parent: 'box', slot: 'list', props: { value: 'All the orders' } },
        { name: 'detailText', type: 'text', parent: 'box', slot: 'details', props: { value: 'One order' } },
        {
          name: 'show',
          type: 'button',
          props: { text: 'Show details' },
          events: [
            { id: 'a', event: 'click', action: { type: 'runScript', code: "await box.setView('details')" } },
          ],
        },
      ],
      queries: [],
      transformers: [],
      variables: [],
      layout: {
        box: { x: 0, y: 0, w: 8, h: 14 },
        listText: { x: 0, y: 0, w: 6, h: 2 },
        detailText: { x: 0, y: 0, w: 6, h: 2 },
        show: { x: 8, y: 0, w: 3, h: 2 },
      },
    },
  })
  const draft = async () =>
    (await trpcQuery<{ draftDefinition: Def }>(page, 'apps.get', { slug })).draftDefinition
  const box = page.locator('[data-component="box"]')

  await test.step('in the editor: tabs switch the view, and only its components render', async () => {
    await page.goto(`/apps/${slug}/edit`)
    await expect(box.getByRole('tab')).toHaveText(['List', 'Details'])
    await expect(box).toContainText('All the orders')
    await expect(box).not.toContainText('One order')
    await box.getByRole('tab', { name: 'Details' }).click()
    await expect(box.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    await expect(box).toContainText('One order')
    await expect(box).not.toContainText('All the orders')
  })

  await test.step('the palette adds into the view on screen', async () => {
    await page.getByTestId('frame-box').click({ position: { x: 20, y: 30 } })
    await page.getByRole('button', { name: 'Button', exact: true }).click()
    await expect(page.getByTestId('inspector-button1')).toBeVisible()
    await expect(page.getByTestId('inspector-button1').getByLabel('Area')).toHaveValue('details')
    await expect(box.getByRole('tabpanel')).toContainText('Button')
  })

  await test.step('renaming a view: its components and setView in code follow', async () => {
    await page.getByTestId('frame-box').click({ position: { x: 20, y: 30 } })
    const views = page.getByTestId('views-box')
    const name = views.getByLabel('Name of view details')
    await name.fill('footer')
    await expect(views).toContainText('"footer" is the container\'s footer')
    await name.fill('info')
    await name.press('Enter')
    await expect(views.getByTestId('view-info')).toBeVisible()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const def = await draft()
        return [
          def.components.find((c) => c.name === 'detailText')?.slot,
          def.components.find((c) => c.name === 'button1')?.slot,
          def.components.find((c) => c.name === 'show')?.events?.[0]?.action.code,
        ]
      })
      .toEqual(['info', 'info', "await box.setView('info')"])
  })

  await test.step('removing a view moves its components to another', async () => {
    const views = page.getByTestId('views-box')
    await views.getByTestId('view-list').getByRole('button', { name: 'Remove view' }).click()
    await expect(views.getByLabel('Where its components go')).toHaveValue('info')
    await views.getByTestId('view-list').getByRole('button', { name: 'Remove view' }).last().click()
    await expect(box.getByRole('tab')).toHaveText(['Details'])
    await expect(box).toContainText('All the orders')
    await expect(box).toContainText('One order')
  })

  await test.step('in the app: a button switches the view by code', async () => {
    await page.getByRole('button', { name: 'Add view' }).click()
    await expect(box.getByRole('tab')).toHaveText(['Details', 'View 2'])
    await box.getByRole('tab', { name: 'View 2' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    const revision = (await trpcQuery<{ draftRevision: number }>(page, 'apps.get', { slug })).draftRevision
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: revision })
    await page.goto(`/apps/${slug}`)
    // The first view, until something switches.
    await expect(box.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    await box.getByRole('tab', { name: 'View 2' }).click()
    await expect(box).not.toContainText('One order')
    await page.locator('[data-component="show"]').getByRole('button').click()
    await expect(box.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    await expect(box).toContainText('One order')
  })
  expect(errors).toEqual([])
})
