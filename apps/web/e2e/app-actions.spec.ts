import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

interface Draft {
  draftDefinition: { components: { name: string; events?: { action: Record<string, unknown> }[] }[] }
}

/**
 * Session 41's event actions, in the editor's running draft: Go to page with a parameter, Set URL parameters,
 * Set / Clear local storage (kept across a reload, read as localStorage.values), Export data (a CSV download) and
 * Copy to clipboard; and choosing one in the handler form.
 */
test('event actions: pages, URL parameters, local storage, export, clipboard', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await signIn(page)
  const slug = `actions-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Actions' })
  const click = (id: string, action: object) => ({ id, event: 'click', action })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      pages: [{ name: 'home' }, { name: 'detail' }],
      components: [
        {
          name: 'shown',
          type: 'text',
          props: {
            value: 'Tab {{ url.params.tab ?? "none" }}, theme {{ localStorage.values.theme ?? "none" }}',
          },
        },
        {
          name: 'go',
          type: 'button',
          page: 'home',
          props: { text: 'Go' },
          events: [click('a', { type: 'openPage', page: 'detail', params: { id: '{{ 7 }}' } })],
        },
        {
          name: 'tab',
          type: 'button',
          page: 'home',
          props: { text: 'Tab' },
          events: [click('b', { type: 'setUrlParams', params: { tab: 'notes' } })],
        },
        {
          name: 'keep',
          type: 'button',
          page: 'home',
          props: { text: 'Keep' },
          events: [click('c', { type: 'setLocalStorage', key: 'theme', value: '{{ "dark" }}' })],
        },
        {
          name: 'forget',
          type: 'button',
          page: 'home',
          props: { text: 'Forget' },
          events: [click('d', { type: 'clearLocalStorage' })],
        },
        {
          name: 'export',
          type: 'button',
          page: 'home',
          props: { text: 'Export' },
          events: [
            click('e', { type: 'download', data: '{{ [{ id: 1, name: "Ada" }] }}', fileName: 'people.csv' }),
          ],
        },
        {
          name: 'copy',
          type: 'button',
          page: 'home',
          props: { text: 'Copy' },
          events: [click('f', { type: 'copyToClipboard', text: 'copied {{ 1 + 1 }}' })],
        },
        { name: 'who', type: 'text', page: 'detail', props: { value: 'Detail {{ url.params.id }}' } },
      ],
      queries: [],
      layout: {
        shown: { x: 0, y: 0, w: 12, h: 2 },
        go: { x: 0, y: 0, w: 2, h: 3 },
        tab: { x: 2, y: 0, w: 2, h: 3 },
        keep: { x: 4, y: 0, w: 2, h: 3 },
        forget: { x: 6, y: 0, w: 2, h: 3 },
        export: { x: 8, y: 0, w: 2, h: 3 },
        copy: { x: 10, y: 0, w: 2, h: 3 },
        who: { x: 0, y: 0, w: 6, h: 2 },
      },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  await page.getByRole('button', { name: 'Preview' }).click()
  const shown = page.locator('[data-component="shown"]')
  await expect(shown).toHaveText('Tab none, theme none')

  await page.getByRole('button', { name: 'Tab', exact: true }).click()
  await expect(shown).toHaveText('Tab notes, theme none')

  await page.getByRole('button', { name: 'Keep', exact: true }).click()
  await expect(shown).toHaveText('Tab notes, theme dark')

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('people.csv')

  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByText('Copied')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('copied 2')

  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(page.locator('[data-component="who"]')).toHaveText('Detail 7')

  // Kept in this browser: after a reload the theme is still there, until Clear local storage.
  await page.reload()
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(shown).toContainText('theme dark')
  await page.getByRole('button', { name: 'Forget', exact: true }).click()
  await expect(shown).toContainText('theme none')

  await test.step('choosing Go to page in the handler form', async () => {
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByTestId('frame-tab').click()
    const inspector = page.getByTestId('inspector-tab')
    const handler = inspector.getByTestId('handler-click-0')
    await handler.getByRole('button', { name: /on click/ }).click()
    await handler.getByLabel('Action').selectOption({ label: 'Go to page' })
    await expect(handler.getByLabel('Page')).toHaveValue('home')
    await handler.getByLabel('Page').selectOption('detail')
    await handler.getByLabel('Wait').selectOption('throttle')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => {
        const def = (await trpcQuery<Draft>(page, 'apps.get', { slug })).draftDefinition
        return def.components.find((c) => c.name === 'tab')!.events![0]
      })
      .toMatchObject({ action: { type: 'openPage', page: 'detail' }, throttleMs: 300 })
  })
  expect(errors).toEqual([])
})
