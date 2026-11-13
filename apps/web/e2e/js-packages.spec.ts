import { expect, type Page, test } from '@playwright/test'
import { block, clickEmptyCanvas, openEditorPanel, openRail, signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * JavaScript packages: a code block imports a package the workflow doesn't list (a problem on the import), the
 * package goes in Settings (checked line by line), Install now bundles it from the e2e's npm registry, and a run's
 * code uses it. `tiny-format` is the registry's package (global-setup).
 */
test("a workflow's JavaScript packages: settings, Install now, and a run importing one", async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `js-${stamp}`,
    name: `JS ${stamp}`,
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'format', type: 'code', config: { code: "import fmt from 'tiny-format'\nreturn fmt(7)" } },
        { name: 'reply', type: 'response', config: { body: '{{ format.data }}' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'format' },
        { from: 'format', port: 'out', to: 'reply' },
      ],
    },
  })
  await page.goto(`/workflows/${flow.id}`)
  await expect(block(page, 'format')).toBeVisible()

  await test.step('an import of a package the workflow does not list is a problem', async () => {
    await expect(await openRail(page, 'problems')).toContainText(
      `The package "tiny-format" isn't one of the workflow's JavaScript packages`,
    )
  })

  await test.step('the packages in Settings: each line checked, then installed', async () => {
    await clickEmptyCanvas(page)
    const panel = await openRail(page, 'settings')
    const packages = panel.getByLabel('JavaScript packages')
    await packages.fill('tiny-format\n\nuser/repo')
    await expect(panel.getByTestId('js-package-problems')).toContainText(
      'user/repo: "user/repo" looks like a GitHub repository: only packages from the npm registries',
    )
    await packages.fill('tiny-format')
    await expect(panel.getByTestId('js-package-problems')).toHaveCount(0)
    const state = panel.getByTestId('js-packages-state')
    // Another workflow (or an earlier run of this spec) may have bundled it already.
    await expect(state).toContainText(/Not installed yet|Installed: tiny-format@1\.0\.0/, { timeout: 15_000 })
    if (await state.getByRole('button', { name: 'Install now' }).isVisible()) {
      await state.getByRole('button', { name: 'Install now' }).click()
    }
    await expect(state).toContainText('Installed: tiny-format@1.0.0', { timeout: 60_000 })
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await expect(await openRail(page, 'problems')).not.toContainText('tiny-format')
  })

  await test.step('a run imports it', async () => {
    await runAndExpect(page, '#007')
  })

  await test.step('the setting is saved with the draft', async () => {
    await page.reload()
    await clickEmptyCanvas(page)
    const panel = await openRail(page, 'settings')
    await expect(panel.getByLabel('JavaScript packages')).toHaveValue('tiny-format')
  })
})

/** Runs the workflow and waits for this run (not an earlier one) to reply with `text`. */
async function runAndExpect(page: Page, text: string) {
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 60_000 })
  await panel.getByRole('button', { name: 'output' }).click()
  await expect(panel.getByTestId('run-output')).toContainText(text)
}

test('the npm registries page serves components, workflows and apps; its old address leads there', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/settings/components')
  await expect(page).toHaveURL(/\/settings\/npm$/)
  await expect(page.getByRole('link', { name: 'npm registries' })).toBeVisible()
  await expect(page.getByText('workflows’ and apps’ JavaScript packages install from')).toBeVisible()
})

test("an app's JavaScript packages: its JS query imports one, in the editor's preview and where the app is used", async ({
  page,
}) => {
  await signIn(page)
  const slug = `js-app-${Date.now().toString(36)}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Formatted' })
  const definition = {
    schemaVersion: 1,
    components: [{ name: 'shown', type: 'text', props: { value: 'Order {{ formatted.data }}' } }],
    queries: [
      {
        name: 'formatted',
        kind: 'js',
        runOnLoad: true,
        code: "import fmt from 'tiny-format'\nreturn fmt(7)",
      },
    ],
    layout: { shown: { x: 0, y: 0, w: 6, h: 4 } },
  }
  // Without the package listed: the editor adds it.
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })

  await test.step('the editor: the package added in App settings, the preview imports it', async () => {
    await page.goto(`/apps/${slug}/edit`)
    await openEditorPanel(page, 'App settings')
    const settings = page.getByTestId('app-settings')
    await settings.getByLabel('JavaScript packages').fill('tiny-format')
    await expect(settings.getByTestId('js-packages-state')).toContainText('Installed: tiny-format@1.0.0', {
      timeout: 60_000,
    })
    // The query ran on load, before the package was listed; opened again, the preview has the packages first.
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await page.reload()
    await expect(page.locator('[data-component="shown"]').first()).toContainText('Order #007', {
      timeout: 30_000,
    })
  })

  await test.step('published: the app uses the release’s bundle', async () => {
    // The editor saved the package list with the draft.
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    const draft = await trpcQuery<{ draftRevision: number; draftDefinition: { javascript?: unknown } }>(
      page,
      'apps.get',
      { id: app.id },
    )
    expect(draft.draftDefinition.javascript).toEqual({ packages: ['tiny-format'] })
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: draft.draftRevision })
    await page.goto(`/apps/${slug}`)
    await expect(page.locator('[data-component="shown"]')).toContainText('Order #007', { timeout: 30_000 })
  })
})
