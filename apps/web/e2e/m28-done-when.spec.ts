import { expect, type Page, test } from '@playwright/test'
import {
  addBlock,
  block,
  canvasSettled,
  drag,
  field,
  openRail,
  signIn,
  trpcMutate,
  typeInto,
} from './helpers'

/**
 * M28's done-when (architecture §2.31): a workflow like the user's example (JS and Python code, a query, a REST call,
 * a filter, a branch, a loop, a wait, a function call) with the forms in the blocks; each block runs alone, including
 * one that isn't connected and one whose sibling has an error, and its result opens under it as a table and as a
 * JSON tree; a connection removed with one click on its ×, another reattached by dragging its end; the run panel
 * dragged taller, then maximized; the Outline, Functions and side editor panels open and close with one click each; a
 * full run's logs filtered by text and by level. The Python block needs the code executor (Docker): without it, the
 * rest runs.
 */

const RUN_ALONE = 'Run this block (earlier results are reused)'
const BLOCKED = 'Fix the problems in this block or the blocks before it first'

/** Centres a block on the canvas through the Outline (blocks can be outside the view). */
async function show(page: Page, name: string) {
  const outline = await openRail(page, 'outline')
  await outline.getByTestId('outline').getByRole('button', { name, exact: true }).click()
  await canvasSettled(page)
}

/** Runs a block on its own; its Data opens under it when the run ends. */
async function runAlone(page: Page, name: string) {
  await show(page, name)
  await block(page, name).getByTitle(RUN_ALONE).click()
  await expect(page.getByTestId(`node-tab-${name}-data`)).toHaveAttribute('aria-pressed', 'true')
  return page.getByTestId(`node-panel-${name}`)
}

test("M28's done-when", async ({ page }) => {
  test.setTimeout(150_000)
  const python = Boolean(process.env.E2E_PYTHON)
  const services = process.env.E2E_SERVICES!
  await signIn(page)
  const slug = `m28-${Date.now().toString(36)}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: `M28 ${slug}` })

  await test.step('a workflow like the example, each block with its form on the canvas', async () => {
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
            name: 'js1',
            type: 'code',
            config: { code: "console.log('hello from js')\nreturn [{ id: 1, n: 2 }, { id: 2, n: 3 }]" },
          },
          ...(python
            ? [
                {
                  name: 'py1',
                  type: 'code',
                  config: {
                    code: 'print("py rows", len(js1.data))\nreturn [r["n"] * 10 for r in js1.data]',
                    language: 'python',
                  },
                },
              ]
            : []),
          {
            name: 'query1',
            type: 'resourceQuery',
            config: { resource: 'shop_db', query: { sql: 'select email, plan from customers order by id' } },
          },
          // A sibling of query1 with a syntax error: it stops full runs, not query1's.
          { name: 'bad1', type: 'code', config: { code: 'return (' } },
          {
            name: 'rest1',
            type: 'resourceQuery',
            config: { resource: 'rest_api', query: { method: 'GET', url: `${services}/_fake/echo/m28` } },
          },
          {
            name: 'filter1',
            type: 'filter',
            config: { input: '{{ query1.data }}', condition: "value.plan == 'pro'" },
          },
          {
            name: 'branch1',
            type: 'branch',
            config: { conditions: [{ id: 'c1', expression: 'filter1.data.length > 0' }] },
          },
          {
            name: 'loop1',
            type: 'loop',
            config: {
              input: '{{ js1.data }}',
              runner: { kind: 'function', function: 'double', params: { n: '{{ value.n }}' } },
            },
          },
          { name: 'wait1', type: 'wait', config: { kind: 'duration', amount: '1', unit: 'seconds' } },
          { name: 'call1', type: 'function', config: { function: 'double', params: { n: '{{ 21 }}' } } },
          { name: 'loose1', type: 'code', config: { code: 'return { notConnected: true }' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'js1' },
          ...(python ? [{ from: 'js1', port: 'out', to: 'py1' }] : []),
          { from: 'js1', port: 'out', to: 'query1' },
          { from: 'js1', port: 'out', to: 'bad1' },
          { from: 'startTrigger', port: 'out', to: 'rest1' },
          { from: 'query1', port: 'out', to: 'filter1' },
          { from: 'filter1', port: 'out', to: 'branch1' },
          { from: 'branch1', port: 'cond:c1', to: 'loop1' },
          { from: 'loop1', port: 'out', to: 'wait1' },
          { from: 'wait1', port: 'out', to: 'call1' },
        ],
      },
    })
    await page.goto(`/workflows/${flow.id}`)
    await expect(block(page, 'call1')).toBeVisible()
    await page.getByTitle('Arrange blocks automatically').click()
    await canvasSettled(page)

    // The forms are in the blocks.
    await expect(block(page, 'query1')).toContainText('select email, plan from customers')
    await expect(block(page, 'filter1')).toContainText("value.plan == 'pro'")
    await expect(block(page, 'branch1')).toContainText('filter1.data.length > 0')
    await expect(block(page, 'loop1')).toContainText('js1.data')
    await expect
      .poll(() =>
        block(page, 'rest1')
          .locator('input')
          .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value).join(' ')),
      )
      .toContain('/_fake/echo/m28')
    await expect(block(page, 'call1').getByRole('combobox').first()).toHaveValue('double')

    // A block added on the canvas, after the selected one, and its code typed in the block.
    await show(page, 'call1')
    await addBlock(page, 'code')
    await expect(block(page, 'code1')).toBeVisible()
    await typeInto(page, field(page, 'code1', 'code.js'), 'return call1.data + 1')
    await expect(page.getByTestId('rf__edge-call1|out|code1')).toHaveCount(1)
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    // bad1's syntax error stops a full run.
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  })

  await test.step('each block runs alone; its result opens under it as a table and a JSON tree', async () => {
    const js = await runAlone(page, 'js1')
    await expect(js.getByTestId('data-table')).toContainText('id')
    await page.getByTestId('node-tab-js1-json').click()
    await expect(js.getByTestId('json-tree')).toBeVisible()

    // Its sibling bad1 has an error: query1 runs anyway; bad1 can't.
    const query = await runAlone(page, 'query1')
    await expect(query.getByTestId('data-table')).toContainText('@')
    await page.getByTestId('node-tab-query1-json').click()
    await expect(query.getByTestId('json-tree')).toContainText('items')
    await show(page, 'bad1')
    await expect(block(page, 'bad1').getByTitle(BLOCKED)).toBeDisabled()

    // A block nothing connects to.
    await expect(await runAlone(page, 'loose1')).toContainText('notConnected')
    await expect(await runAlone(page, 'rest1')).toContainText('/_fake/echo/m28')
    if (python) await expect(await runAlone(page, 'py1')).toContainText('20')
  })

  await test.step('a connection removed with one click on its ×, another reattached by dragging its end', async () => {
    await show(page, 'bad1')
    const toBad = page.getByTestId('rf__edge-js1|out|bad1')
    await toBad.hover()
    await page.getByTestId('edge-remove-js1|out|bad1').click()
    await expect(toBad).toHaveCount(0)
    // The broken block goes too (its menu), so the whole workflow can run.
    await page.getByRole('button', { name: 'More actions for bad1' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(block(page, 'bad1')).toHaveCount(0)

    // startTrigger → rest1's end dragged onto loose1 (both in view).
    await page.getByRole('button', { name: 'Fit View' }).click()
    await canvasSettled(page)
    const end = page.getByTestId('rf__edge-startTrigger|out|rest1').locator('.react-flow__edgeupdater-target')
    await drag(page, end, block(page, 'loose1').locator('.react-flow__handle-left'))
    await expect(page.getByTestId('rf__edge-startTrigger|out|loose1')).toHaveCount(1)
    await expect(page.getByTestId('rf__edge-startTrigger|out|rest1')).toHaveCount(0)
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
  })

  await test.step('a full run; the run panel dragged taller, maximized; its logs filtered by text and level', async () => {
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel).toBeVisible()
    // The last block's footer shows the run's status; its Data the result.
    await expect(block(page, 'code1').getByLabel('succeeded')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('node-tab-code1-data').click()
    await expect(page.getByTestId('node-panel-code1')).toContainText('43')

    const before = (await panel.boundingBox())!.height
    const handle = (await page.getByTestId('run-panel-resize').boundingBox())!
    await page.mouse.move(handle.x + 200, handle.y + 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 200, handle.y - 200, { steps: 8 })
    await page.mouse.up()
    const taller = (await panel.boundingBox())!.height
    expect(taller).toBeGreaterThan(before + 150)
    await page.getByRole('button', { name: 'Maximize the panel' }).click()
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(taller + 50)
    await page.getByRole('button', { name: 'Restore the panel' }).click()

    await page
      .getByTestId('run-blocks')
      .getByRole('button', { name: /Global/ })
      .click()
    await panel.getByRole('button', { name: 'logs', exact: true }).click()
    const logs = page.getByTestId('run-logs')
    await expect(logs).toContainText('hello from js')
    await expect(logs).toContainText('Successfully finished running query: call1')
    await page.getByLabel('Filter entries').fill('hello')
    await expect(logs.locator('li')).toHaveCount(1)
    await page.getByLabel('Filter entries').fill('')
    await page.getByTitle('Show only succeeded').click()
    await expect(logs).toContainText('Successfully finished running query: call1')
    await expect(logs).not.toContainText('hello from js')
    await page.getByTitle('Show only info').click()
    await expect(logs).toContainText('hello from js')
    await expect(logs).not.toContainText('Successfully finished')
    await page.getByRole('button', { name: 'Close run panel' }).click()
  })

  await test.step('the Outline, Functions and side editor panels open and close with one click each', async () => {
    const rail = page.getByTestId('rail-panel')
    for (const panel of ['outline', 'functions']) {
      // From closed (the Outline was left open by show()).
      if ((await page.getByTestId(`rail-${panel}`).getAttribute('aria-pressed')) === 'true') {
        await page.getByTestId(`rail-${panel}`).click()
      }
      await expect(rail).toBeHidden()
      await page.getByTestId(`rail-${panel}`).click()
      await expect(page.getByTestId(`rail-${panel}`)).toHaveAttribute('aria-pressed', 'true')
      await expect(rail).toBeVisible()
      await page.getByTestId(`rail-${panel}`).click()
      await expect(rail).toBeHidden()
    }
    await show(page, 'query1')
    await page.getByTestId('rail-outline').click()
    await block(page, 'query1').getByRole('button', { name: 'Open in the side panel' }).click()
    const side = page.getByTestId('side-panel')
    await expect(side).toContainText('select email, plan from customers')
    await page.getByRole('button', { name: 'Close the side panel' }).first().click()
    await expect(side).toBeHidden()
  })
})
