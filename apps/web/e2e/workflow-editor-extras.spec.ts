import { expect, type Page, test } from '@playwright/test'
import { acceptConfirms, block, canvasSettled, field, signIn, trpcMutate } from './helpers'

/**
 * M28 step 9, what §2.31 planned beyond the done-when: the canvas toolbar's zoom and Collapse/Expand all; Switch block
 * type and Add global error handler in a block's ⋯ menu; the Publish menu (compare with live, history, roll back); a
 * result panel's height kept; others' carets in a block's code preview.
 */

const code = (name: string, text: string) => ({ name, type: 'code', config: { code: text } })

async function workflow(page: Page, name: string, blocks: object[], edges: object[]) {
  const slug = `${name}-${Date.now().toString(36)}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges,
    },
  })
  return flow.id
}

const menu = async (page: Page, name: string, item: string) => {
  await block(page, name)
    .getByRole('button', { name: `More actions for ${name}` })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('the canvas toolbar, the block menu and a kept result height', async ({ page }) => {
  await signIn(page)
  const id = await workflow(
    page,
    'extras',
    [code('a', 'return [{ id: 1 }, { id: 2 }]'), code('b', 'return a.data.length')],
    [
      { from: 'startTrigger', port: 'out', to: 'a' },
      { from: 'a', port: 'out', to: 'b' },
    ],
  )
  await page.goto(`/workflows/${id}`)
  await expect(block(page, 'b')).toBeVisible()
  await canvasSettled(page)

  await test.step('the zoom shows as a percentage; a click goes back to 100%', async () => {
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await expect(page.getByTestId('zoom-level')).not.toHaveText('100%')
    await page.getByTestId('zoom-level').click()
    await expect(page.getByTestId('zoom-level')).toHaveText('100%')
  })

  await test.step('Collapse all leaves the headers; Expand all brings the forms back', async () => {
    await page.getByRole('button', { name: 'Collapse all blocks' }).click()
    await expect(field(page, 'a', 'code.js')).toHaveCount(0)
    await expect(block(page, 'b').getByRole('button', { name: 'Expand block' })).toBeVisible()
    await page.getByRole('button', { name: 'Expand all blocks' }).click()
    await expect(field(page, 'a', 'code.js')).toBeVisible()
  })

  await test.step('a code block switched to a loop and back keeps its code and connections', async () => {
    await menu(page, 'b', 'Switch to a loop')
    await expect(block(page, 'b')).toContainText('For each item, run')
    await expect(block(page, 'b')).toContainText('return a.data.length')
    await menu(page, 'b', 'Switch to a code block')
    await expect(block(page, 'b')).not.toContainText('For each item, run')
    await expect(block(page, 'b')).toContainText('return a.data.length')
    await expect(page.getByTestId('rf__edge-a|out|b')).toHaveCount(1)
  })

  await test.step('the global error handler is added once, from any block', async () => {
    await menu(page, 'a', 'Add global error handler')
    await expect(block(page, 'errorHandler1')).toBeVisible()
    await block(page, 'a').getByRole('button', { name: 'More actions for a' }).click()
    await expect(page.getByRole('menuitem', { name: 'Add global error handler' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  await test.step('a result panel resized under its block keeps that height', async () => {
    await block(page, 'a').getByTitle('Run this block (earlier results are reused)').click()
    const panel = page.getByTestId('node-panel-a')
    await expect(panel.getByTestId('data-table')).toBeVisible()
    // The run panel opened with the run: closed, so the canvas has the room.
    await page.getByRole('button', { name: 'Close run panel' }).click()
    await page.getByRole('button', { name: 'Fit View' }).click()
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await canvasSettled(page)
    // The handle is in view, nothing over it.
    await expect
      .poll(async () => {
        const at = (await page.getByTestId('node-panel-resize-a').boundingBox())!
        return page.evaluate(
          ([x, y]) => document.elementFromPoint(x!, y!)?.getAttribute('data-testid'),
          [at.x + at.width / 2, at.y + 2],
        )
      })
      .toBe('node-panel-resize-a')
    const box = (await panel.boundingBox())!
    const edge = (await page.getByTestId('node-panel-resize-a').boundingBox())!
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 2)
    await page.mouse.down()
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 102, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(box.height + 60)
    await expect(page.getByTestId('save-status')).toHaveText('Saved')
    const resized = Math.round((await panel.boundingBox())!.height)
    await page.reload()
    await page.getByTestId('node-tab-a-data').click()
    await expect
      .poll(async () => Math.round((await page.getByTestId('node-panel-a').boundingBox())!.height))
      .toBeGreaterThan(resized - 4)
  })
})

test('the Publish menu: compare the draft with live, the history, a rollback', async ({ page }) => {
  await signIn(page)
  await acceptConfirms(page)
  const id = await workflow(
    page,
    'releases-menu',
    [code('a', 'return 1')],
    [{ from: 'startTrigger', port: 'out', to: 'a' }],
  )
  await trpcMutate(page, 'releases.publish', { workflowId: id, draftRevision: 2 })
  await trpcMutate(page, 'workflows.saveDraft', {
    id,
    revision: 2,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, code('a', 'return 2')],
      edges: [{ from: 'startTrigger', port: 'out', to: 'a' }],
    },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: id, draftRevision: 3 })
  await page.goto(`/workflows/${id}`)
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.1')

  await page.getByRole('button', { name: 'Release actions' }).click()
  await page.getByRole('menuitem', { name: /Compare draft with live/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Draft')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Release actions' }).click()
  await page.getByRole('menuitem', { name: 'Release history' }).click()
  await expect(page.getByTestId('releases')).toContainText('v1.0.0')

  await page.getByRole('button', { name: 'Release actions' }).click()
  await page.getByRole('menuitem', { name: 'Roll back to v1.0.0' }).click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
})

test("others' carets show in a block's code preview", async ({ page, browser }) => {
  await signIn(page)
  const id = await workflow(
    page,
    'carets',
    [code('a', 'return 1 + 2')],
    [{ from: 'startTrigger', port: 'out', to: 'a' }],
  )
  await page.goto(`/workflows/${id}`)
  await expect(block(page, 'a')).toBeVisible()

  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other)
  await other.goto(`/workflows/${id}`)
  // The other editor clicks into a's code (an editor once a is inspected) and puts the caret after "return".
  await block(other, 'a').click()
  const monaco = field(other, 'a', 'code.js').locator('.monaco-editor')
  await monaco.click({ position: { x: 20, y: 8 } })
  await other.keyboard.press('Home')
  for (let i = 0; i < 6; i++) await other.keyboard.press('ArrowRight')

  // On this side a isn't inspected: its code is a preview, with the other's caret in it.
  const preview = block(page, 'a').locator('[data-testid^="code-preview-"]')
  const caret = preview.getByTestId('preview-caret')
  await expect(caret).toHaveCount(1)
  await expect(preview).toContainText('return 1 + 2')
  await otherContext.close()
  await expect(caret).toHaveCount(0)
})
