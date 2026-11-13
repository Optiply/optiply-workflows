import { expect, test } from '@playwright/test'
import { openEditorPanel, signIn, trpcMutate, trpcQuery, typeInto } from './helpers'

interface Draft {
  draftDefinition: { theme?: Record<string, unknown>; css?: string }
}

/**
 * The app's theme and custom CSS (session 41): set in App settings, applied inside the app (in the editor and where
 * it's used) and not to the platform around it; CSS can't load anything from elsewhere.
 */
test('app theme and custom CSS', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `theme-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Theme' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'save', type: 'button', props: { text: 'Save' } },
        { name: 'title', type: 'text', props: { value: 'Orders' } },
      ],
      queries: [],
      layout: { save: { x: 0, y: 0, w: 2, h: 2 }, title: { x: 2, y: 0, w: 4, h: 2 } },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  const save = page.locator('[data-component="save"] button')
  const publish = page.getByRole('button', { name: 'Publish', exact: true })
  const background = (l: typeof save) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
  const optiplyBlue = await background(save)

  await openEditorPanel(page, 'App settings')
  const settings = page.getByTestId('app-settings')
  await settings.getByLabel('Primary hex').fill('#7c3aed')
  await settings.getByLabel('Primary hex').blur()
  await expect.poll(() => background(save)).toBe('rgb(124, 58, 237)')
  // The editor around the app keeps Optiply's colours.
  expect(await background(publish)).not.toBe('rgb(124, 58, 237)')
  expect(optiplyBlue).not.toBe('rgb(124, 58, 237)')

  await settings.getByLabel('Corner radius (px)').fill('0')
  await expect.poll(() => save.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px')

  // Custom CSS, inside the app; url() never loads.
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await typeInto(
    page,
    settings.locator('[data-testid$="/css"]'),
    '[data-component="title"] { color: rgb(255, 0, 0); background: url(https://leak.example/x) }',
  )
  const title = page.locator('[data-component="title"] > div')
  await expect.poll(() => title.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 0, 0)')
  expect(await title.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none')
  expect(requests.some((u) => u.includes('leak.example'))).toBe(false)

  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  const saved = (await trpcQuery<Draft>(page, 'apps.get', { slug })).draftDefinition
  expect(saved.theme).toEqual({ primary: '#7c3aed', radius: 0 })
  expect(saved.css).toContain('[data-component="title"]')

  // Where the app is used: the same look.
  await trpcMutate(page, 'apps.publish', {
    appId: app.id,
    draftRevision: (await trpcQuery<{ draftRevision: number }>(page, 'apps.get', { slug })).draftRevision,
  })
  await page.goto(`/apps/${slug}`)
  await expect
    .poll(() => background(page.locator('[data-component="save"] button')))
    .toBe('rgb(124, 58, 237)')
  await expect
    .poll(() => page.locator('[data-component="title"] > div').evaluate((el) => getComputedStyle(el).color))
    .toBe('rgb(255, 0, 0)')
  expect(errors).toEqual([])
})
