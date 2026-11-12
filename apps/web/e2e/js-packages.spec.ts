import { expect, type Page, test } from '@playwright/test'
import { block, clickEmptyCanvas, openRail, signIn, trpcMutate } from './helpers'

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

test('the npm registries page serves components, workflows and apps; its old address leads there', async ({ page }) => {
  await signIn(page)
  await page.goto('/settings/components')
  await expect(page).toHaveURL(/\/settings\/npm$/)
  await expect(page.getByRole('link', { name: 'npm registries' })).toBeVisible()
  await expect(page.getByText('workflows’ and apps’ JavaScript packages install from')).toBeVisible()
})
