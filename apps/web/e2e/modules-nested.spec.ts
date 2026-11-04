import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Modules inside modules (M21 step 4c): a picker inside a shell inside a top module, three levels below an app;
 * the module editor places modules (leaving out what would nest too deep) and runs the nested instances' queries;
 * a published app runs two instances of the top module apart, an output coming up all three levels.
 */

/** The customers on a plan (`inputs.plan`), the first one's email shown and out. */
const picker = {
  schemaVersion: 1,
  components: [{ name: 'first', type: 'text', props: { value: 'First: {{ find.data?.[0]?.email }}' } }],
  queries: [
    {
      name: 'find',
      kind: 'resource',
      resource: 'shop_db',
      query: { sql: 'select email from customers where plan = {{ inputs.plan }} order by id' },
      run: 'auto',
    },
  ],
  layout: { first: { x: 0, y: 0, w: 12, h: 2 } },
  module: {
    inputs: [{ name: 'plan', default: 'pro' }],
    outputs: [{ name: 'firstEmail', value: '{{ find.data?.[0]?.email ?? null }}' }],
    events: [],
  },
}

/** A module holding `inner`, passing its `plan` in and the inner instance's `firstEmail` out. */
const holding = (inner: string) => ({
  schemaVersion: 1,
  components: [{ name: 'inner1', type: 'module', props: { module: inner, plan: '{{ inputs.plan }}' } }],
  queries: [],
  layout: { inner1: { x: 0, y: 0, w: 12, h: 8 } },
  module: {
    inputs: [{ name: 'plan', default: 'pro' }],
    outputs: [{ name: 'firstEmail', value: '{{ inner1.firstEmail }}' }],
    events: [],
  },
})

async function publishModule(page: Page, slug: string, definition: object) {
  const created = await trpcMutate<{ id: string }>(page, 'modules.create', { slug, name: slug })
  const { revision } = await trpcMutate<{ revision: number }>(page, 'modules.saveDraft', {
    id: created.id,
    revision: 1,
    definition,
  })
  await trpcMutate(page, 'modules.publish', { moduleId: created.id, draftRevision: revision })
  return created.id
}

test('modules three levels deep, in the module editor and a published app', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const pickerSlug = `n_picker_${stamp}`
  const shellSlug = `n_shell_${stamp}`
  const topSlug = `n_top_${stamp}`
  await publishModule(page, pickerSlug, picker)
  await publishModule(page, shellSlug, holding(pickerSlug))
  await publishModule(page, topSlug, holding(shellSlug))

  await test.step('the module editor places a module, and offers only what nests deep enough', async () => {
    const deepSlug = `n_deep_${stamp}`
    await trpcMutate(page, 'modules.create', { slug: deepSlug, name: deepSlug })
    await page.goto(`/modules/${deepSlug}`)
    await page.getByRole('button', { name: 'Add a module' }).click()
    const list = page.getByTestId('module-picker')
    await expect(list).toContainText(shellSlug)
    await expect(list).toContainText(pickerSlug)
    // The top module is three deep: inside this one it would be four.
    await expect(list).not.toContainText(topSlug)
    await expect(list).not.toContainText(deepSlug)
    await expect(page.getByTestId('module-picker-left')).toBeVisible()
    await list.getByRole('button', { name: new RegExp(shellSlug) }).click()

    // The draft runs: the picker inside the shell queries through its path, with the defaults passed down.
    const shell = page.locator(`[data-module="${shellSlug}"]`)
    await expect(shell.locator(`[data-module="${pickerSlug}"] [data-component="first"]`)).toHaveText(
      'First: ada@example.com',
    )
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })
  })

  await test.step('a published app runs two instances of the top module apart', async () => {
    const appSlug = `n_app_${stamp}`
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
      slug: appSlug,
      name: `Nested ${stamp}`,
    })
    const { revision } = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [
          { name: 'topA', type: 'module', props: { module: topSlug, plan: 'free' } },
          { name: 'topB', type: 'module', props: { module: topSlug, plan: 'pro' } },
          { name: 'shown', type: 'text', props: { value: 'Out: {{ topA.firstEmail }}' } },
        ],
        queries: [],
        layout: {
          topA: { x: 0, y: 0, w: 6, h: 12 },
          topB: { x: 6, y: 0, w: 6, h: 12 },
          shown: { x: 0, y: 12, w: 12, h: 2 },
        },
      },
    })
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: revision })
    await page.goto(`/apps/${appSlug}`)

    const first = (instance: string) =>
      page.locator(`[data-component="${instance}"] [data-module="${pickerSlug}"] [data-component="first"]`)
    await expect(first('topA')).toHaveText('First: grace@example.com')
    await expect(first('topB')).toHaveText('First: ada@example.com')
    await expect(page.locator('[data-component="shown"]')).toHaveText('Out: grace@example.com')
  })
})
