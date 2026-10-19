import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Modules at run time (M14 step 5c): two instances of one module in a published app, each with its own state and
 * queries, inputs in, an output read by the app and an event handled by it; a new live release of the module
 * asks the page to reload.
 */

/** A customer picker: the customers on a plan (`inputs.plan`, editable), the first one's email out, `picked`. */
const picker = (order = 'id') => ({
  schemaVersion: 1,
  components: [
    { name: 'plan1', type: 'textInput', props: { label: 'Plan', defaultValue: '{{ inputs.plan }}' } },
    { name: 'first', type: 'text', props: { value: 'First: {{ find.data?.[0]?.email }}' } },
    {
      name: 'pick',
      type: 'button',
      props: { text: 'Pick' },
      events: [{ id: 'a', event: 'click', action: { type: 'moduleEvent', event: 'picked' } }],
    },
  ],
  queries: [
    {
      name: 'find',
      kind: 'resource',
      resource: 'shop_db',
      query: { sql: `select email from customers where plan = {{ plan1.value }} order by ${order}` },
      run: 'auto',
    },
  ],
  layout: {
    plan1: { x: 0, y: 0, w: 6, h: 4 },
    first: { x: 0, y: 4, w: 12, h: 2 },
    pick: { x: 0, y: 6, w: 3, h: 3 },
  },
  module: {
    inputs: [{ name: 'plan', default: 'pro' }],
    outputs: [{ name: 'firstEmail', value: '{{ find.data?.[0]?.email ?? null }}' }],
    events: [{ name: 'picked' }],
  },
})

async function publishModule(page: Page, slug: string) {
  const created = await trpcMutate<{ id: string }>(page, 'modules.create', { slug, name: slug })
  let revision = 1
  const release = async (def: object) => {
    ;({ revision } = await trpcMutate<{ revision: number }>(page, 'modules.saveDraft', {
      id: created.id,
      revision,
      definition: def,
    }))
    return trpcMutate<{ id: string; version: string }>(page, 'modules.publish', {
      moduleId: created.id,
      draftRevision: revision,
    })
  }
  await release(picker())
  return { release }
}

test('two instances of a module in a published app', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const moduleSlug = `customer_picker_${stamp}`
  const mod = await publishModule(page, moduleSlug)

  const appSlug = `picking_${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
    slug: appSlug,
    name: `Picking ${stamp}`,
  })
  const { revision } = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        {
          name: 'picker1',
          type: 'module',
          props: { module: moduleSlug, plan: 'free' },
          events: [
            {
              id: 'h',
              event: 'picked',
              action: { type: 'setVariable', variable: 'chosen', value: '{{ picker1.firstEmail }}' },
            },
          ],
        },
        { name: 'picker2', type: 'module', props: { module: moduleSlug, version: '1.0.0' } },
        { name: 'shown', type: 'text', props: { value: 'Picked: {{ chosen.value }}' } },
      ],
      queries: [],
      variables: [{ name: 'chosen', initialValue: '' }],
      layout: {
        picker1: { x: 0, y: 0, w: 6, h: 12 },
        picker2: { x: 6, y: 0, w: 6, h: 12 },
        shown: { x: 0, y: 12, w: 12, h: 2 },
      },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: revision })
  await page.goto(`/apps/${appSlug}`)

  // Each instance with its own input and query.
  const picker1 = page.locator('[data-component="picker1"]')
  const picker2 = page.locator('[data-component="picker2"]')
  await expect(picker1.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
  await expect(picker2.locator('[data-component="first"]')).toHaveText('First: ada@example.com')

  // Typing in one leaves the other alone.
  await picker2.getByRole('textbox').fill('free')
  await expect(picker2.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
  await picker2.getByRole('textbox').fill('pro')
  await expect(picker2.locator('[data-component="first"]')).toHaveText('First: ada@example.com')
  await expect(picker1.getByRole('textbox')).toHaveValue('free')

  // The module's event, handled by the app, reading the instance's output.
  await picker1.getByRole('button', { name: 'Pick' }).click()
  await expect(page.locator('[data-component="shown"]')).toHaveText('Picked: grace@example.com')

  // A new live release: picker1 (latest) is told to reload when its query runs; picker2 (pinned) still runs.
  await mod.release(picker('email'))
  await picker2.getByRole('textbox').fill('free')
  await expect(picker2.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
  await picker1.getByRole('textbox').fill('pro')
  await expect(page.getByText(`Module "${moduleSlug}" has a new version; reload to get it`)).toBeVisible()
  await page.reload()
  await expect(picker1.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
})

/** In the app editor (M14 step 5c-2): the draft's instances run, and are checked against their releases. */
test('module instances in the app editor', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const moduleSlug = `editor_picker_${stamp}`
  await publishModule(page, moduleSlug)
  const appSlug = `editing_${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
    slug: appSlug,
    name: `Editing ${stamp}`,
  })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'picker1', type: 'module', props: { module: moduleSlug, plan: 'free' } },
        { name: 'missing1', type: 'module', props: { module: `nope_${stamp}` } },
        { name: 'shown', type: 'text', props: { value: 'Out: {{ picker1.firstEmail }}' } },
      ],
      queries: [],
      layout: {
        picker1: { x: 0, y: 0, w: 6, h: 12 },
        missing1: { x: 6, y: 0, w: 6, h: 4 },
        shown: { x: 0, y: 12, w: 12, h: 2 },
      },
    },
  })
  await page.goto(`/apps/${appSlug}/edit`)

  // The running draft draws the instance and runs its query; the app reads its output.
  const picker1 = page.locator('[data-component="picker1"]')
  await expect(picker1.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
  await expect(page.locator('[data-component="shown"]')).toHaveText('Out: grace@example.com')
  // A module that doesn't exist: a placeholder, and one problem.
  await expect(page.locator('[data-component="missing1"]')).toContainText(
    `Module nope_${stamp} (latest) isn't available`,
  )
  await expect(page.getByRole('tab', { name: 'Problems (1)' })).toBeVisible()
})
