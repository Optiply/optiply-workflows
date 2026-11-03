import { expect, test } from '@playwright/test'
import { block, canvasSettled, signIn, trpcMutate } from './helpers'

// Temporary walkthrough (not committed): screenshots of the workflow editor for the user, light and dark.
const OUT = process.env.SHOTS ?? '/tmp/shots'

for (const scheme of ['light', 'dark'] as const) {
  test(`editor walkthrough (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    const shot = (name: string) => page.screenshot({ path: `${OUT}/${scheme}-${name}.png` })
    await signIn(page)
    const slug = `walk-${scheme}-${Date.now().toString(36)}`
    const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: 'Orders digest' })
    await trpcMutate(page, 'workflows.saveDraft', {
      id: flow.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        functions: [
          {
            name: 'double',
            params: [{ name: 'n' }],
            blocks: [{ name: 'times2', type: 'code', config: { code: 'return params.n * 2' } }],
            edges: [],
          },
        ],
        blocks: [
          { name: 'startTrigger', type: 'startTrigger', config: { testInput: { id: 1 } } },
          {
            name: 'orders',
            type: 'code',
            config: { code: "console.log('building orders')\nreturn [{ id: 1, n: 2 }, { id: 2, n: 3 }]" },
          },
          {
            name: 'customers',
            type: 'resourceQuery',
            config: { resource: 'shop_db', query: { sql: 'select email, plan from customers order by id' } },
          },
          {
            name: 'pro',
            type: 'filter',
            config: { input: '{{ customers.data }}', condition: "value.plan == 'pro'" },
          },
          {
            name: 'anyPro',
            type: 'branch',
            config: { conditions: [{ id: 'c1', expression: 'pro.data.length > 0' }] },
          },
          {
            name: 'doubled',
            type: 'loop',
            config: {
              input: '{{ orders.data }}',
              runner: { kind: 'function', function: 'double', params: { n: '{{ value.n }}' } },
            },
          },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'orders' },
          { from: 'orders', port: 'out', to: 'customers' },
          { from: 'customers', port: 'out', to: 'pro' },
          { from: 'pro', port: 'out', to: 'anyPro' },
          { from: 'anyPro', port: 'cond:c1', to: 'doubled' },
        ],
      },
    })
    await page.goto(`/workflows/${flow.id}`)
    await expect(block(page, 'doubled')).toBeVisible()
    await page.getByTitle('Arrange blocks automatically').click()
    await page.getByRole('button', { name: 'Fit View' }).click()
    await canvasSettled(page)
    await shot('01-canvas')

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(block(page, 'doubled').getByLabel('succeeded')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('rail-outline').click()
    await page.getByTestId('outline').getByRole('button', { name: 'customers', exact: true }).click()
    await canvasSettled(page)
    await page.getByTestId('node-tab-customers-data').click()
    await page.waitForTimeout(400)
    await shot('02-block-data-under-it')
    await page.getByTestId('node-tab-customers-json').click()
    await page.getByTestId('node-panel-customers').getByRole('button', { name: 'Expand 0' }).click()
    await page.waitForTimeout(300)
    await shot('03-block-json-tree')
    await page.getByTestId('node-tab-customers-json').click()

    await page
      .getByTestId('run-blocks')
      .getByRole('button', { name: /Global/ })
      .click()
    await page.getByTestId('run-panel').getByRole('button', { name: 'logs', exact: true }).click()
    await page.waitForTimeout(400)
    await shot('04-run-history-logs')
    await page.getByRole('button', { name: 'Close run panel' }).click()

    await page.getByTestId('rail-functions').click()
    await page.waitForTimeout(400)
    await shot('05-rail-functions')
    await page.getByTestId('rail-functions').click()
    await page.getByRole('button', { name: 'Fit View' }).click()
    await canvasSettled(page)
    await block(page, 'customers').getByRole('button', { name: 'Open in the side panel' }).click()
    await page.waitForTimeout(800)
    await shot('06-side-panel')
  })
}

test('step 9 walkthrough', async ({ page }) => {
  const shot = (name: string) => page.screenshot({ path: `${OUT}/step9-${name}.png` })
  await signIn(page)
  const slug = `walk9-${Date.now().toString(36)}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: 'Step 9' })
  const blocks = [
    { name: 'startTrigger', type: 'startTrigger' },
    { name: 'orders', type: 'code', config: { code: 'return [{ id: 1 }, { id: 2 }]' } },
    {
      name: 'customers',
      type: 'resourceQuery',
      config: { resource: 'shop_db', query: { sql: 'select email, plan from customers' } },
    },
  ]
  const edges = [
    { from: 'startTrigger', port: 'out', to: 'orders' },
    { from: 'orders', port: 'out', to: 'customers' },
  ]
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: { schemaVersion: 1, blocks, edges },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  await page.goto(`/workflows/${flow.id}`)
  await expect(block(page, 'customers')).toBeVisible()
  await canvasSettled(page)
  await page.getByRole('button', { name: 'Collapse all blocks' }).hover()
  await page.waitForTimeout(300)
  await shot('01-toolbar')
  await page.getByRole('button', { name: 'Collapse all blocks' }).click()
  await page.waitForTimeout(400)
  await shot('02-collapsed')
  await page.getByRole('button', { name: 'Expand all blocks' }).click()
  await block(page, 'orders').getByRole('button', { name: 'More actions for orders' }).click()
  await page.waitForTimeout(300)
  await shot('03-block-menu')
  await page.getByRole('menuitem', { name: 'Switch to a loop' }).click()
  await page.waitForTimeout(600)
  await shot('04-switched-to-loop')
  await page.getByRole('button', { name: 'Release actions' }).click()
  await page.waitForTimeout(300)
  await shot('05-publish-menu')
})
