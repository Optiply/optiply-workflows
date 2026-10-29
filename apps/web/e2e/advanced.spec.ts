import { expect, test } from '@playwright/test'
import { acceptConfirms, block, field, signIn, trpcMutate, typeInto } from './helpers'

/**
 * M5 end to end: a workflow whose loop calls a function that doesn't exist yet. Create the function in the
 * Functions tab (a parameter, its code in Monaco), run the workflow, see the loop's result and its iterations, see
 * the run pause at a Wait, and cancel it from the run panel.
 */
test('functions, loops, a wait and cancel in the editor', async ({ page }) => {
  await acceptConfirms(page)
  const suffix = Date.now().toString(36)
  let workflowId = ''

  await test.step('a loop calling a function that is still missing', async () => {
    await signIn(page)
    workflowId = (
      await trpcMutate<{ id: string }>(page, 'workflows.create', {
        slug: `squares-${suffix}`,
        name: `Squares ${suffix}`,
      })
    ).id
    await trpcMutate(page, 'workflows.saveDraft', {
      id: workflowId,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger', config: { testInput: { n: 3 } } },
          {
            name: 'each',
            type: 'loop',
            config: {
              input: '{{ _.range(startTrigger.data.n) }}',
              runner: { kind: 'function', function: 'square', params: { x: '{{ value }}' } },
            },
          },
          { name: 'total', type: 'code', config: { code: 'return _.sum(each.data)' } },
          { name: 'pause', type: 'wait', config: { kind: 'duration', amount: '1', unit: 'minutes' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'each' },
          { from: 'each', port: 'out', to: 'total' },
          { from: 'total', port: 'out', to: 'pause' },
        ],
      },
    })
    await page.goto(`/workflows/${workflowId}`)
    await expect(page.getByTestId('problems')).toContainText('No function is named "square"')
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  })

  await test.step('create the function: a parameter and its code', async () => {
    await page.getByRole('button', { name: 'Functions' }).click()
    await page.getByLabel('New function name').fill('square')
    await page.getByRole('button', { name: 'New function' }).click()
    await expect(page.getByTestId('function-banner')).toContainText('square')
    await page.getByRole('button', { name: 'Add parameter' }).click()
    await page.getByLabel('Parameter name').fill('x')

    await block(page, 'result').click()
    await typeInto(page, field(page, 'result', 'code.js'), 'return params.x * params.x')
    await page.getByTestId('function-banner').getByRole('button', { name: 'Workflow' }).click()
    await expect(block(page, 'each')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
  })

  await test.step('run: the loop calls the function per item, then the run pauses', async () => {
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('waiting', { timeout: 30_000 })
    await expect(block(page, 'pause')).toHaveAttribute('data-status', 'waiting')

    // 0² + 1² + 2²
    await page.getByTestId('run-blocks').getByRole('button', { name: /total/ }).click()
    await expect(page.getByTestId('block-result').getByTestId('json')).toHaveText('5')
    await page.getByTestId('run-blocks').getByRole('button', { name: /each/ }).click()
    await expect(page.getByTestId('iterations')).toContainText('3 committed')
    await page.getByTestId('iterations').getByRole('button', { name: /\[2\]/ }).click()
    await expect(page.getByTestId('iterations').getByTestId('json')).toHaveText('4')
  })

  await test.step('cancel the paused run', async () => {
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('run-panel').getByTestId('run-status').first()).toHaveText('cancelled')
    await expect(block(page, 'pause')).toHaveAttribute('data-status', 'cancelled')
  })
})
