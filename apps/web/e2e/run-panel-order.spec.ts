import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * The run panel lists blocks in the order they ran, not the order the definition stores them in (an imported
 * workflow keeps Retool's, e.g. alphabetical), so a reply stored before the query it waits for isn't shown as if it
 * ran first.
 */
test('the run panel lists blocks in the order they ran', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await signIn(page)
  const { id } = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `run-order-${suffix}`,
    name: `Run order ${suffix}`,
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      // Stored out of run order on purpose.
      blocks: [
        { name: 'reply', type: 'code', config: { code: 'return query.data + 1' } },
        { name: 'startTrigger', type: 'startTrigger', config: { testInput: {} } },
        { name: 'query', type: 'code', config: { code: 'return 1' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'query' },
        { from: 'query', port: 'out', to: 'reply' },
      ],
    },
  })
  await page.goto(`/workflows/${id}`)
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 30_000 })
  const names = page.getByTestId('run-blocks').locator('li .font-mono')
  await expect(names).toHaveText(['startTrigger', 'query', 'reply'])
})
