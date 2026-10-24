import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { signIn, trpcMutate, trpcQuery, typeInto } from './helpers'

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

/** The module editor (M14 step 6a): made from the Modules page, its draft run with test inputs, published. */
test('create, run and publish a module', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await signIn(page)
  const name = `Plan badge ${Date.now()}`
  await page.getByRole('link', { name: 'Modules' }).click()
  await expect(page.getByRole('heading', { name: 'Modules', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New module' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create module' }).click()
  await expect(page).toHaveURL(/\/modules\/plan_badge_\d+$/)
  const slug = page.url().split('/modules/')[1]!

  // A component from the palette, saved as the module's draft.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  // No pages in a module.
  await expect(page.getByRole('heading', { name: 'Pages' })).toHaveCount(0)

  // Its draft runs on its own: `inputs.*` are the test values, its queries run through the module.
  const saved = await trpcQuery<{ id: string; draftRevision: number }>(page, 'modules.get', { slug })
  await trpcMutate(page, 'modules.saveDraft', {
    id: saved.id,
    revision: saved.draftRevision,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'badge', type: 'text', props: { value: 'Plan {{ inputs.plan }}: {{ count.data[0].n }}' } },
      ],
      queries: [
        {
          name: 'count',
          kind: 'resource',
          resource: 'shop_db',
          query: { sql: 'select count(*)::int as n from customers where plan = {{ inputs.plan }}' },
          run: 'auto',
        },
      ],
      layout: { badge: { x: 0, y: 0, w: 6, h: 2 } },
      module: { inputs: [{ name: 'plan', default: 'pro', testValue: 'free' }], outputs: [], events: [] },
    },
  })
  await page.reload()
  await expect(page.locator('[data-component="badge"]')).toHaveText('Plan free: 1')

  // Published from its editor; the list shows it live.
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('apps get when they follow its latest version')
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
  await page.getByRole('link', { name: 'Modules' }).click()
  await expect(page.getByTestId(`module-${slug}`)).toContainText('Live v1.0.0')
})

/** A module's interface in its editor (M14 step 6b): inputs, outputs and events, a handler firing one, Used by. */
test('edit a module’s inputs, outputs and events', async ({ page }) => {
  await signIn(page)
  const slug = `counter_${Date.now()}`
  const created = await trpcMutate<{ id: string }>(page, 'modules.create', { slug, name: slug })
  await trpcMutate(page, 'modules.saveDraft', {
    id: created.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'badge', type: 'text', props: { value: 'Plan {{ inputs.plan }}: {{ count.data?.[0]?.n }}' } },
        { name: 'done', type: 'button', props: { text: 'Done' } },
      ],
      queries: [
        {
          name: 'count',
          kind: 'resource',
          resource: 'shop_db',
          query: { sql: 'select count(*)::int as n from customers where plan = {{ inputs.plan }}' },
          run: 'auto',
        },
      ],
      layout: { badge: { x: 0, y: 0, w: 6, h: 2 }, done: { x: 0, y: 2, w: 3, h: 3 } },
      module: { inputs: [], outputs: [], events: [] },
    },
  })
  await page.goto(`/modules/${slug}`)
  await expect(page.getByTestId('module-used-by')).toContainText('Nothing uses it yet')
  // A module has no pages: no Navigation to add.
  await expect(page.getByRole('button', { name: 'Navigation', exact: true })).toHaveCount(0)

  // An input, named and given a test value: the draft runs with it.
  await page.getByRole('button', { name: 'Add input' }).click()
  await page.getByLabel('Input name').fill('plan')
  await page.getByLabel('Input name').press('Enter')
  await page.getByLabel('plan test value').fill('free')
  await expect(page.locator('[data-component="badge"]')).toHaveText('Plan free: 1')

  // An output and an event; the button fires the event.
  await page.getByRole('button', { name: 'Add output' }).click()
  await typeInto(page, page.locator('[data-testid$="/module/outputs/0/value"]'), '{{ count.data?.[0]?.n }}')
  await page.getByRole('button', { name: 'Add event' }).click()
  await page.getByLabel('Event name').fill('finished')
  await page.getByLabel('Event name').press('Enter')
  await page.getByTestId('frame-done').click()
  const inspector = page.getByTestId('inspector-done')
  await inspector.getByRole('button', { name: 'Add handler' }).click()
  await inspector.getByLabel('Action', { exact: true }).selectOption('moduleEvent')
  await expect(inspector.getByTestId('handler-click-0')).toContainText('fire finished')

  // Renaming the event (its settings still open) re-points the handler.
  await page.getByLabel('Event name').fill('closed')
  await page.getByLabel('Event name').press('Enter')
  await expect(inspector.getByTestId('handler-click-0')).toContainText('fire closed')
  await expect(page.getByRole('tab', { name: 'Problems', exact: true })).toBeVisible()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const saved = await trpcQuery<{ draftDefinition: { module: unknown } }>(page, 'modules.get', { slug })
  expect(saved.draftDefinition.module).toEqual({
    inputs: [{ name: 'plan', testValue: 'free' }],
    outputs: [{ name: 'output1', value: '{{ count.data?.[0]?.n }}' }],
    events: [{ name: 'closed' }],
  })

  // An app placing it shows up under Used by.
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
    slug: `uses_${slug}`,
    name: `Uses ${slug}`,
  })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'counter1', type: 'module', props: { module: slug } }],
      queries: [],
    },
  })
  await page.reload()
  await expect(page.getByTestId('module-used-by')).toContainText(`Uses ${slug}`)
})

/** Placing a module in the app editor (M14 step 6c): picked, pinned, an input passed, its event handled. */
test('place a module in an app', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const moduleSlug = `placed_picker_${stamp}`
  await publishModule(page, moduleSlug)
  const appSlug = `placing_${stamp}`
  await trpcMutate(page, 'apps.create', { slug: appSlug, name: `Placing ${stamp}` })
  await page.goto(`/apps/${appSlug}/edit`)

  await page.getByRole('button', { name: 'Add a module' }).click()
  await page
    .getByTestId('module-picker')
    .getByRole('button', { name: new RegExp(moduleSlug) })
    .click()
  const name = `placed_picker_${stamp}1`
  const instance = page.locator(`[data-component="${name}"]`)
  // Its default input: the pro plan.
  await expect(instance.locator('[data-component="first"]')).toHaveText('First: ada@example.com')
  await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toContainText(moduleSlug)

  // The inspector: the module, its version, its input, its event.
  const inspector = page.getByTestId(`inspector-${name}`)
  await expect(inspector.getByLabel('Module', { exact: true })).toHaveValue(moduleSlug)
  await inspector.getByLabel('Version', { exact: true }).selectOption('1.0.0')
  await typeInto(page, page.locator(`[data-testid$="/components/0/props/plan"]`), 'free')
  await expect(instance.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
  await inspector.getByRole('button', { name: 'Add handler' }).click()
  await expect(inspector.getByLabel('Event', { exact: true })).toHaveValue('picked')
  // (Its default action controls a query this app doesn't have.)
  await inspector.getByRole('button', { name: 'Remove handler' }).click()

  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Problems', exact: true })).toBeVisible()
  const saved = await trpcQuery<{ draftDefinition: { components: unknown[] } }>(page, 'apps.get', {
    slug: appSlug,
  })
  expect(saved.draftDefinition.components[0]).toMatchObject({
    name,
    type: 'module',
    props: { module: moduleSlug, version: '1.0.0', plan: 'free' },
  })
})

/** Protected in Git (M14 step 7d): a module protected from its settings, edited and run on a branch, committed. */
test('protect a module and edit it on a branch', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await signIn(page)
  const repoUrl = process.env.E2E_GIT_REPO_URL!
  const repoDir = process.env.E2E_GIT_REPO_DIR ?? new URL(repoUrl).pathname
  const info = await trpcQuery<{ configured: boolean }>(page, 'git.info', {})
  if (!info.configured) await trpcMutate(page, 'git.saveSettings', { repoUrl, token: E2E_GITHUB_TOKEN })
  const stamp = Date.now()
  const slug = `git_picker_${stamp}`
  const branch = `m14/picker-${stamp}`
  await publishModule(page, slug)

  await page.goto(`/modules/${slug}`)
  await page.getByRole('button', { name: 'Module settings' }).click()
  await page.getByRole('button', { name: 'Protect in Git' }).click()
  await page.getByTestId('protect-confirm').click()
  await expect(page.getByTestId('protect-result')).toContainText('The module is protected')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('Escape')

  // Main is read-only; a branch draft is edited, and runs.
  await expect(page.getByTestId('read-only-banner')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Branch' }).selectOption({ label: 'New branch…' })
  await page.getByRole('textbox', { name: 'New branch name' }).fill(branch)
  await page.getByRole('button', { name: 'Start branch' }).click()
  await expect(page.getByText('New: the first commit makes it')).toBeVisible()
  await typeInto(
    page,
    page.locator('[data-testid$="/queries/0/query/sql"]'),
    'select upper(email) as email from customers where plan = {{ plan1.value }} order by id',
  )
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-component="first"]')).toHaveText('First: ADA@EXAMPLE.COM')

  // Committed: the repo has the module's SQL as a file.
  await page.getByTestId('commit-open').click()
  await expect(page.getByTestId('commit-files')).toContainText(`modules/${slug}/queries/find.sql`)
  await page.getByRole('textbox', { name: 'Message' }).fill('Upper-case the email')
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toContainText(branch)
  const sql = execFileSync('git', [
    '--git-dir',
    repoDir,
    'show',
    `refs/heads/${branch}:modules/${slug}/queries/find.sql`,
  ])
  expect(sql.toString()).toBe(
    'select upper(email) as email from customers where plan = {{ plan1.value }} order by id\n',
  )
})
