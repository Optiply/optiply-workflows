import { expect, type Page, test } from '@playwright/test'
import { block, clickEmptyCanvas, editorText, field, signIn, trpcMutate } from './helpers'

type Definition = {
  blocks: { name: string; config?: { code?: string } }[]
  edges: unknown[]
  functions?: { name: string }[]
}

/** A workflow made through the API with `definition` as its draft; returns its id. */
async function workflowWith(page: Page, name: string, definition: object): Promise<string> {
  const slug = `${name}-${Date.now().toString(36)}`
  const { id } = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  await trpcMutate(page, 'workflows.saveDraft', {
    id,
    revision: 1,
    definition: { schemaVersion: 1, ...definition },
  })
  return id
}

/** The saved draft, from the API. */
async function draftOf(page: Page, id: string): Promise<Definition> {
  const input = encodeURIComponent(JSON.stringify({ json: { id } }))
  const body = await (await page.request.get(`/api/trpc/workflows.get?input=${input}`)).json()
  return body.result.data.json.draftDefinition
}

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
const start = { name: 'startTrigger', type: 'startTrigger' }

/** M13 step 2: copy blocks from one workflow into another, duplicate them, and refuse what wasn't copied here. */
test('copy, paste and duplicate blocks between workflows', async ({ page }) => {
  await signIn(page)
  const source = await workflowWith(page, 'clip-source', {
    blocks: [
      start,
      { name: 'code1', type: 'code', config: { code: 'return 20' } },
      { name: 'code2', type: 'code', config: { code: 'return code1.data + await double({ n: 1 })' } },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'code1' },
      { from: 'code1', port: 'out', to: 'code2' },
    ],
    functions: [
      {
        name: 'double',
        params: [{ name: 'n' }],
        blocks: [{ name: 'result', type: 'code', config: { code: 'return params.n * 2' } }],
        edges: [],
      },
    ],
  })
  const target = await workflowWith(page, 'clip-target', {
    blocks: [start, { name: 'code1', type: 'code', config: { code: 'return "mine"' } }],
    edges: [{ from: 'startTrigger', port: 'out', to: 'code1' }],
  })

  await test.step('select two blocks and copy them', async () => {
    await page.goto(`/workflows/${source}`)
    await block(page, 'code1').click()
    await block(page, 'code2').click({ modifiers: ['ControlOrMeta'] })
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
    await page.keyboard.press('ControlOrMeta+C')
  })

  await test.step('paste them after a block of another workflow: fresh names, references and the function follow', async () => {
    await page.goto(`/workflows/${target}`)
    await block(page, 'code1').click()
    await page.keyboard.press('ControlOrMeta+V')
    // code1 is taken here: the copy is code3 (code2 is being pasted too), and code2 now reads it.
    await expect(block(page, 'code3')).toBeVisible()
    await expect(block(page, 'code2')).toBeVisible()
    await expect(page.getByTestId('paste-notice')).toContainText('Added the functions they call: double.')
    await saved(page)
    const draft = await draftOf(page, target)
    expect(draft.blocks.map((b) => b.name)).toEqual(['startTrigger', 'code1', 'code3', 'code2'])
    expect(draft.blocks.find((b) => b.name === 'code1')!.config!.code).toBe('return "mine"')
    expect(draft.blocks.find((b) => b.name === 'code2')!.config!.code).toBe(
      'return code3.data + await double({ n: 1 })',
    )
    expect(draft.functions!.map((f) => f.name)).toEqual(['double'])
    // Connected after the selected block, like Add; the copied connection kept.
    expect(draft.edges).toEqual([
      { from: 'startTrigger', port: 'out', to: 'code1' },
      { from: 'code3', port: 'out', to: 'code2' },
      { from: 'code1', port: 'out', to: 'code3' },
    ])
  })

  await test.step('undo the paste, redo it', async () => {
    await clickEmptyCanvas(page)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(block(page, 'code3')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect(block(page, 'code3')).toBeVisible()
  })

  await test.step('duplicate a block in place', async () => {
    await page.getByTestId('paste-notice').getByRole('button', { name: 'Dismiss' }).click()
    await block(page, 'code2').click()
    await page.keyboard.press('ControlOrMeta+D')
    await expect(block(page, 'code4')).toBeVisible()
    await expect
      .poll(() => editorText(field(page, 'code4', 'code.js')))
      .toBe('return code3.data + await double({ n: 1 })')
    // Nothing to report: the function is the one already here.
    await expect(page.getByTestId('paste-notice')).toHaveCount(0)
  })

  await test.step("blocks this browser didn't copy are pasted only once confirmed", async () => {
    const crafted = JSON.stringify({
      ow: 'workflow-blocks',
      v: 1,
      blocks: [{ name: 'planted', type: 'code', config: { code: 'return 1' } }],
      edges: [],
      positions: {},
      functions: [],
    })
    const pasteEvent = (text: string) =>
      page.evaluate((t) => {
        const data = new DataTransfer()
        data.setData('text/plain', t)
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
      }, text)
    let asked = ''
    page.once('dialog', (dialog) => {
      asked = dialog.message()
      void dialog.dismiss()
    })
    await clickEmptyCanvas(page)
    await pasteEvent(crafted)
    await expect.poll(() => asked).toContain("weren't copied in this browser")
    await expect(block(page, 'planted')).toHaveCount(0)

    page.once('dialog', (dialog) => void dialog.accept())
    await pasteEvent(crafted)
    await expect(block(page, 'planted')).toBeVisible()
    // Plain text isn't blocks: nothing happens, nothing is asked.
    await pasteEvent('select 1')
    await saved(page)
  })
})
