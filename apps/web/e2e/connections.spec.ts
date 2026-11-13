import { expect, test } from '@playwright/test'
import { block, drag, signIn, trpcMutate } from './helpers'

// M28 step 4: a connection is removed with one click on its ×, and reattached by dragging its end.

test('remove a connection with one click, reattach another by dragging its end', async ({ page }) => {
  await signIn(page)
  const slug = `edges-${Date.now().toString(36)}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  const code = (name: string) => ({ name, type: 'code', config: { code: 'return 1' } })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, code('a'), code('b'), code('c')],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'a' },
        { from: 'a', port: 'out', to: 'b' },
      ],
      layout: {
        blocks: {
          startTrigger: { x: 0, y: 0 },
          a: { x: 500, y: 0 },
          b: { x: 1100, y: 0 },
          c: { x: 1100, y: 420 },
        },
      },
    },
  })
  await page.goto(`/workflows/${flow.id}`)
  await expect(block(page, 'c')).toBeVisible()

  // Hovering the curve shows its ×; one click removes it.
  const ab = page.getByTestId('rf__edge-a|out|b')
  await ab.hover()
  await page.getByTestId('edge-remove-a|out|b').click()
  await expect(ab).toHaveCount(0)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  // Its target end dragged onto c moves startTrigger → a to startTrigger → c.
  const end = page.getByTestId('rf__edge-startTrigger|out|a').locator('.react-flow__edgeupdater-target')
  await drag(page, end, block(page, 'c').locator('.react-flow__handle-left'))
  await expect(page.getByTestId('rf__edge-startTrigger|out|c')).toHaveCount(1)
  await expect(page.getByTestId('rf__edge-startTrigger|out|a')).toHaveCount(0)

  // Undo brings the removed connection back in the editor.
  await page.getByTestId('canvas').click({ position: { x: 600, y: 600 } })
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByTestId('rf__edge-startTrigger|out|a')).toHaveCount(1)
})
