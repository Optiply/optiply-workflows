import { expect, test } from '@playwright/test'
import { counterLibrary, publishedApp, publishedLibrary } from './custom-component-helpers'
import { signIn, trpcMutate, trpcQuery, typeInto } from './helpers'

/**
 * Custom components at run time (M25 step 4b): a library's component, built with an npm package from the test
 * registry, in a published app: its prop follows the app, its state and event reach the app, the app calls its
 * method, and it follows the theme.
 */

test('a custom component runs in a published app', async ({ page }) => {
  await signIn(page)
  const library = 'e2e-counters'
  await publishedLibrary(page, library, counterLibrary())
  await publishedApp(page, 'e2e-counter-app', {
    schemaVersion: 1,
    components: [
      {
        name: 'counter1',
        type: 'custom',
        props: { library, component: 'Counter', label: '{{ input1.value }}' },
        events: [
          {
            id: 'bump1',
            event: 'bump',
            action: { type: 'setVariable', variable: 'bumps', value: '{{ bumps.value + 1 }}' },
          },
        ],
      },
      {
        name: 'text1',
        type: 'text',
        props: { value: 'Count {{ counter1.count }}, bumps {{ bumps.value }}' },
      },
      {
        name: 'button1',
        type: 'button',
        props: { text: 'Highlight' },
        events: [
          { id: 'hl1', event: 'click', action: { type: 'controlQuery', query: 'hl', method: 'trigger' } },
        ],
      },
      { name: 'text2', type: 'text', props: { value: 'Result: {{ hl.data }}' } },
      { name: 'input1', type: 'textInput', props: { label: 'Greeting', defaultValue: 'Hi there' } },
    ],
    queries: [{ name: 'hl', kind: 'js', code: 'return await counter1.highlight(2)' }],
    variables: [{ name: 'bumps', initialValue: '{{ 0 }}' }],
    layout: {
      counter1: { x: 0, y: 0, w: 6, h: 6 },
      text1: { x: 6, y: 0, w: 6, h: 2 },
      button1: { x: 6, y: 2, w: 3, h: 2 },
      text2: { x: 6, y: 4, w: 6, h: 2 },
      input1: { x: 0, y: 6, w: 6, h: 4 },
    },
  })

  await page.goto('/apps/e2e-counter-app')
  const frame = page.frameLocator('[data-custom-component="Counter"] iframe')
  await expect(page.locator('[data-custom-component="Counter"]')).toHaveAttribute(
    'data-frame-status',
    'ready',
  )
  await expect(frame.getByTestId('label')).toHaveText('Hi there')
  // The npm package formats the count.
  await expect(frame.getByRole('button')).toHaveText('#000')

  await frame.getByRole('button').click()
  await frame.getByRole('button').click()
  await expect(frame.getByRole('button')).toHaveText('#002')
  await expect(page.getByText('Count 2, bumps 2')).toBeVisible()

  await page.getByRole('button', { name: 'Highlight' }).click()
  await expect(page.getByText('Result: highlighted 2')).toBeVisible()
  await expect(frame.getByTestId('mark')).toHaveText('row 2')

  // Props follow the app.
  await page.getByLabel('Greeting').fill('Hello again')
  await expect(frame.getByTestId('label')).toHaveText('Hello again')

  // The frame reads neither the page nor its cookies.
  const outside = await page
    .frameLocator('[data-custom-component="Counter"] iframe')
    .locator('body')
    .evaluate(() => {
      let parentDoc = 'blocked'
      try {
        parentDoc = String(window.parent.document.title)
      } catch {}
      let cookie = 'blocked'
      try {
        cookie = document.cookie
      } catch {}
      return { parentDoc, cookie, origin: window.origin }
    })
  expect(outside).toEqual({ parentDoc: 'blocked', cookie: 'blocked', origin: 'null' })

  const releases = await trpcQuery<{ bundleHash: string }[]>(page, 'componentLibraries.releases', {
    componentLibraryId: (await trpcQuery<{ id: string }>(page, 'componentLibraries.get', { slug: library }))
      .id,
  })
  expect(releases[0]!.bundleHash).toMatch(/^[0-9a-f]{64}$/)
})

test('a custom component is placed and set in the app editor', async ({ page }) => {
  await signIn(page)
  await publishedLibrary(page, 'e2e-editor-counters', counterLibrary())
  await trpcMutate(page, 'apps.create', { slug: 'custom-edit-app', name: 'Custom edit app' })
  await page.goto('/apps/custom-edit-app/edit')
  await page.getByRole('button', { name: 'Add a custom component' }).click()
  await page
    .getByTestId('custom-picker')
    .getByRole('button', { name: /e2e-editor-counters/ })
    .click()
  await expect(page.getByLabel('Library')).toHaveValue('e2e-editor-counters')
  await expect(page.getByLabel('Component', { exact: true })).toHaveValue('Counter')
  await typeInto(page, page.locator('[data-testid$="/components/0/props/label"]'), 'From the editor')

  const frame = page.frameLocator('[data-custom-component="Counter"] iframe')
  await expect(frame.getByTestId('label')).toHaveText('From the editor')
  // A click on it selects it; a double-click lets it be used.
  await page.getByTestId('custom-editor-cover').dblclick()
  await frame.getByRole('button').click()
  await expect(frame.getByRole('button')).toHaveText('#001')

  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const app = await trpcQuery<{ id: string; draftRevision: number; diagnostics: unknown[] }>(
    page,
    'apps.get',
    {
      slug: 'custom-edit-app',
    },
  )
  expect(app.diagnostics).toEqual([])
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: app.draftRevision })
  await page.goto('/apps/custom-edit-app')
  await expect(frame.getByTestId('label')).toHaveText('From the editor')
})
