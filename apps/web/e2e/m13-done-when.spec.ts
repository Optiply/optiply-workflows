import { expect, type Page, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, editorText, field, signIn, trpcMutate, typeInto } from './helpers'

/**
 * M13's done-when, in both editors: about 50 mixed edits (several kinds, cycled) undone one by one return the exact
 * starting definition, layout included, and the server's draft hash after autosave matches the start; redoing returns
 * the final one. Blocks (with the function they call) and a component (with what's inside it) copied into another
 * workflow and app keep their connections and references under fresh names. Monaco keeps its own undo.
 */

const input = (x: object) => encodeURIComponent(JSON.stringify({ json: x }))
type Saved = { draftDefinition: unknown; draftHash: string }

async function workflowDraft(page: Page, id: string): Promise<Saved> {
  return (await (await page.request.get(`/api/trpc/workflows.get?input=${input({ id })}`)).json()).result.data
    .json
}
async function appDraft(page: Page, slug: string): Promise<Saved> {
  return (await (await page.request.get(`/api/trpc/apps.get?input=${input({ slug })}`)).json()).result.data
    .json
}
const saved = (page: Page) =>
  expect(
    page
      .getByTestId('save-status')
      .or(page.getByText('Saved', { exact: true }))
      .first(),
  ).toHaveText('Saved', {
    timeout: 15000,
  })

/** Presses a key `times` times, waiting for each to be handled (the editor re-renders between them). */
async function press(page: Page, key: string, times: number) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key)
    await page.waitForTimeout(30)
  }
}

const stamp = () => Date.now().toString(36)

test('the workflow editor: 50 edits undone to the exact start and redone to the end', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  const slug = `m13-check-flow-${stamp()}`
  const { id } = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  await page.goto(`/workflows/${id}`)
  await expect(block(page, 'startTrigger')).toBeVisible()
  const start = await workflowDraft(page, id)
  const CYCLES = 10
  let edits = 0

  await test.step('ten cycles of five kinds of edit: add, type, rename, move, arrange', async () => {
    let previous = 'startTrigger'
    for (let i = 1; i <= CYCLES; i++) {
      await block(page, previous).click()
      await addBlock(page, 'code')
      await expect(block(page, 'code1')).toBeVisible()
      await typeInto(page, field(page, 'code1', 'code.js'), `return ${i}`)
      await page.getByTestId('block-name').fill(`step${i}`)
      await page.getByTestId('block-name').press('Enter')
      await expect(block(page, `step${i}`)).toBeVisible()
      const box = (await block(page, `step${i}`).boundingBox())!
      await page.mouse.move(box.x + 40, box.y + 12)
      await page.mouse.down()
      await page.mouse.move(box.x + 100, box.y + 70, { steps: 8 })
      await page.mouse.up()
      await page.getByTitle('Arrange blocks automatically').click()
      edits += 5
      previous = `step${i}`
    }
    await saved(page)
  })
  const end = await workflowDraft(page, id)
  expect(end.draftDefinition).not.toEqual(start.draftDefinition)

  await test.step(`undo all ${edits}: the saved draft is the start, layout and hash included`, async () => {
    await clickEmptyCanvas(page)
    await press(page, 'ControlOrMeta+Z', edits)
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
    await saved(page)
    const back = await workflowDraft(page, id)
    expect(back.draftDefinition).toEqual(start.draftDefinition)
    expect(back.draftHash).toBe(start.draftHash)
  })

  await test.step('redo all of them: the saved draft is the end again', async () => {
    await press(page, 'ControlOrMeta+Shift+Z', edits)
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled()
    await saved(page)
    const again = await workflowDraft(page, id)
    expect(again.draftDefinition).toEqual(end.draftDefinition)
    expect(again.draftHash).toBe(end.draftHash)
  })

  await test.step("⌘Z in a code field is the field's own undo", async () => {
    await block(page, `step${CYCLES}`).click()
    const code = field(page, `step${CYCLES}`, 'code.js')
    await code.locator('.view-lines').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('End')
    await page.keyboard.type('00')
    await expect.poll(() => editorText(code)).toBe(`return ${CYCLES}00`)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => editorText(code)).toBe(`return ${CYCLES}`)
    await expect(block(page, `step${CYCLES}`)).toBeVisible()
  })

  await test.step('copy two blocks and the function they call into another workflow', async () => {
    await trpcMutate(page, 'workflows.saveDraft', {
      id,
      revision: (await (await page.request.get(`/api/trpc/workflows.get?input=${input({ id })}`)).json())
        .result.data.json.draftRevision,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'rows', type: 'code', config: { code: 'return [1, 2, 3]' } },
          { name: 'total', type: 'code', config: { code: 'return await sum(rows.data)' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'rows' },
          { from: 'rows', port: 'out', to: 'total' },
        ],
        functions: [
          {
            name: 'sum',
            params: [{ name: 'values' }],
            blocks: [
              {
                name: 'add',
                type: 'code',
                config: { code: 'return params.values.reduce((a, b) => a + b, 0)' },
              },
            ],
            edges: [],
          },
        ],
      },
    })
    await page.reload()
    await block(page, 'rows').click()
    await block(page, 'total').click({ modifiers: ['ControlOrMeta'] })
    await page.keyboard.press('ControlOrMeta+C')

    const other = `m13-check-flow-b-${stamp()}`
    const target = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug: other, name: other })
    await trpcMutate(page, 'workflows.saveDraft', {
      id: target.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'rows', type: 'code', config: { code: 'return "theirs"' } },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'rows' }],
      },
    })
    await page.goto(`/workflows/${target.id}`)
    await block(page, 'rows').click()
    await page.keyboard.press('ControlOrMeta+V')
    await expect(block(page, 'rows1')).toBeVisible()
    await saved(page)
    const pasted = (await workflowDraft(page, target.id)).draftDefinition as {
      blocks: { name: string; config?: { code?: string } }[]
      edges: unknown[]
      functions?: { name: string }[]
    }
    expect(pasted.blocks.map((b) => b.name)).toEqual(['startTrigger', 'rows', 'rows1', 'total'])
    expect(pasted.blocks.find((b) => b.name === 'total')!.config!.code).toBe('return await sum(rows1.data)')
    expect(pasted.edges).toContainEqual({ from: 'rows1', port: 'out', to: 'total' })
    expect(pasted.functions!.map((f) => f.name)).toEqual(['sum'])
    // It runs: the copy calls the function that came with it.
    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 30000 })
  })
})

test('the app editor: 48 edits undone to the exact start and redone to the end', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  const slug = `m13-check-app-${stamp()}`
  await trpcMutate(page, 'apps.create', { slug, name: slug })
  await page.goto(`/apps/${slug}/edit`)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  const start = await appDraft(page, slug)
  const CYCLES = 8
  let edits = 0

  await test.step('eight cycles of six kinds of edit: add, type a prop, rename, move, add a query, type its code', async () => {
    for (let i = 1; i <= CYCLES; i++) {
      await page.getByRole('button', { name: 'Text', exact: true }).click()
      await expect(page.getByTestId('inspector-text1')).toBeVisible()
      await typeInto(page, page.locator(`[data-testid$="/components/${i - 1}/props/value"]`), `Line ${i}`)
      const name = page.getByTestId('inspector-text1').getByLabel('Name')
      await name.fill(`label${i}`)
      await name.press('Enter')
      await expect(page.getByTestId(`inspector-label${i}`)).toBeVisible()
      const handle = page.getByTestId(`frame-label${i}`).getByTitle('Drag to move')
      const box = (await handle.boundingBox())!
      await page.mouse.move(box.x + 10, box.y + 5)
      await page.mouse.down()
      await page.mouse.move(box.x + 200, box.y + 5, { steps: 10 })
      await page.mouse.up()
      await page.getByTitle('Add a JS query').click()
      await expect(page.getByTestId(`query-query${i}`)).toBeVisible()
      await typeInto(page, page.locator(`[data-testid$="/queries/${i - 1}/code"]`), `return ${i}`)
      edits += 6
    }
    await saved(page)
  })
  const end = await appDraft(page, slug)

  await test.step(`undo all ${edits}: the saved draft is the start, layout and hash included`, async () => {
    await page.locator('header h1').click()
    await press(page, 'ControlOrMeta+Z', edits)
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
    await saved(page)
    const back = await appDraft(page, slug)
    expect(back.draftDefinition).toEqual(start.draftDefinition)
    expect(back.draftHash).toBe(start.draftHash)
  })

  await test.step('redo all of them: the saved draft is the end again', async () => {
    await press(page, 'ControlOrMeta+Shift+Z', edits)
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled()
    await saved(page)
    const again = await appDraft(page, slug)
    expect(again.draftDefinition).toEqual(end.draftDefinition)
    expect(again.draftHash).toBe(end.draftHash)
  })

  await test.step('copy a container with what is inside it into another app', async () => {
    const source = `m13-check-app-a-${stamp()}`
    const a = await trpcMutate<{ id: string }>(page, 'apps.create', { slug: source, name: source })
    await trpcMutate(page, 'apps.saveDraft', {
      id: a.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [
          { name: 'form1', type: 'container' },
          { name: 'email', type: 'textInput', parent: 'form1' },
          { name: 'echo', type: 'text', parent: 'form1', props: { value: 'You typed {{ email.value }}' } },
        ],
        queries: [],
        layout: {
          form1: { x: 0, y: 0, w: 12, h: 6 },
          email: { x: 0, y: 0, w: 6, h: 2 },
          echo: { x: 6, y: 0, w: 6, h: 2 },
        },
      },
    })
    await page.goto(`/apps/${source}/edit`)
    await page
      .locator('aside li button')
      .filter({ has: page.getByText('form1', { exact: true }) })
      .click()
    await page.keyboard.press('ControlOrMeta+C')
    await page.goto(`/apps/${slug}/edit`)
    await page.locator('header h1').click()
    await page.keyboard.press('ControlOrMeta+V')
    await expect(page.getByTestId('frame-email')).toBeVisible()
    await saved(page)
    const pasted = (await appDraft(page, slug)).draftDefinition as {
      components: { name: string; parent?: string; props?: { value?: string } }[]
    }
    expect(pasted.components.slice(-3).map((c) => [c.name, c.parent ?? null])).toEqual([
      ['form1', null],
      ['email', 'form1'],
      ['echo', 'form1'],
    ])
    // The copy works in the running draft: typing in the pasted input shows in the pasted text.
    await page.getByTestId('frame-email').locator('input').fill('ada@example.com')
    await expect(page.getByTestId('frame-echo')).toContainText('You typed ada@example.com')
  })
})
