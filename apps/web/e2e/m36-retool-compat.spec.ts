import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * What M36 added for Retool's apps, in a published app: navigation action links (handlers check `clickedItem`),
 * Retool's container view keys, local storage methods, notifications and Markdown text.
 */
test('M36: navigation action links, Retool view keys, local storage and Markdown', async ({ page }) => {
  await signIn(page)
  const slug = `retool-compat-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Retool compat' })
  const nav = (item: string, code: string, id: string) => ({
    id,
    event: 'click',
    action: { type: 'runScript', code },
    onlyIf: `{{ nav.clickedItem === '${item}' }}`,
  })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        {
          name: 'nav',
          type: 'navigation',
          props: {
            orientation: 'vertical',
            items: [
              { key: 'orders', label: 'Orders' },
              { key: 'log', label: 'Log' },
            ],
          },
          events: [
            nav('orders', "box.setCurrentView('Open orders')", 'a'),
            nav(
              'log',
              "box.setCurrentViewIndex(1); localStorage.setValue('seen', 'log'); utils.showNotification({ title: 'Log', notificationType: 'success' })",
              'b',
            ),
          ],
        },
        {
          name: 'box',
          type: 'container',
          props: {
            views: [
              { name: 'open', label: 'Open orders' },
              { name: 'history', label: 'History' },
            ],
            showTabs: false,
          },
        },
        {
          name: 'heading',
          type: 'text',
          parent: 'box',
          slot: 'open',
          props: { value: '### Open **orders**', markdown: true },
        },
        {
          name: 'past',
          type: 'text',
          parent: 'box',
          slot: 'history',
          props: { value: 'Seen: {{ localStorage.values.seen }}' },
        },
      ],
      queries: [],
      layout: {
        nav: { x: 0, y: 0, w: 3, h: 8 },
        box: { x: 3, y: 0, w: 9, h: 10 },
        heading: { x: 0, y: 0, w: 12, h: 3 },
        past: { x: 0, y: 0, w: 12, h: 2 },
      },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  await page.goto(`/apps/${slug}`)

  const navigation = page.getByRole('navigation', { name: 'nav' })
  await expect(page.getByRole('heading', { name: 'Open orders' })).toBeVisible()
  await navigation.getByRole('button', { name: 'Log' }).click()
  await expect(page.locator('[data-component="past"]')).toContainText('Seen: log')
  await expect(navigation.getByRole('button', { name: 'Log' })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('status').filter({ hasText: 'Log' })).toBeVisible()
  await navigation.getByRole('button', { name: 'Orders' }).click()
  await expect(page.getByRole('heading', { name: 'Open orders' })).toBeVisible()
  await trpcMutate(page, 'apps.delete', { id: app.id }).catch(() => {})
})
