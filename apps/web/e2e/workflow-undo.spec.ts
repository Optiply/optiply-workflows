import { expect, type Page, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { addBlock, block, clickEmptyCanvas, editorText, field, signIn, trpcMutate, typeInto } from './helpers'

/** A new workflow through the UI, open in the editor; returns its id. */
async function newWorkflow(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(name)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await expect(block(page, 'startTrigger')).toBeVisible()
  return page.url().split('/').at(-1)!
}

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')

/** M13 step 1: undo and redo in the workflow editor, from the toolbar and the keyboard, saved like any edit. */
test('undo and redo blocks and edits in the workflow editor', async ({ page }) => {
  await signIn(page)
  await newWorkflow(page, `Undo ${Date.now().toString(36)}`)
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const redo = page.getByRole('button', { name: 'Redo', exact: true })
  await expect(undo).toBeDisabled()

  await test.step('make three edits', async () => {
    await block(page, 'startTrigger').click()
    await addBlock(page, 'code')
    await expect(block(page, 'code1')).toBeVisible()
    await typeInto(page, field(page, 'code1', 'code.js'), 'return 41 + 1')
    // Typing is one step once it pauses; the next block is another.
    await page.waitForTimeout(1100)
    await addBlock(page, 'response')
    await expect(block(page, 'response1')).toBeVisible()
    await saved(page)
  })

  await test.step('undo them from the toolbar: the code comes back as it was', async () => {
    await undo.click()
    await expect(block(page, 'response1')).toHaveCount(0)
    // Undo shows what it undid: the block the edit was made on.
    await expect(page.getByTestId('block-name')).toHaveValue('code1')
    await undo.click()
    await expect.poll(() => editorText(field(page, 'code1', 'code.js'))).toBe('return null')
    await undo.click()
    await expect(block(page, 'code1')).toHaveCount(0)
    await expect(undo).toBeDisabled()
    await saved(page)
  })

  await test.step('redo with the keyboard, then undo once with it', async () => {
    await clickEmptyCanvas(page)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect(block(page, 'code1')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect(block(page, 'response1')).toBeVisible()
    await expect(redo).toBeDisabled()
    await clickEmptyCanvas(page)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(block(page, 'response1')).toHaveCount(0)
    await expect(block(page, 'code1')).toBeVisible()
  })

  await test.step("⌘Z in a code field is the field's own undo", async () => {
    await block(page, 'code1').click()
    const code = field(page, 'code1', 'code.js')
    await expect.poll(() => editorText(code)).toBe('return 41 + 1')
    await code.locator('.view-lines').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('End')
    await page.keyboard.type('00')
    await expect.poll(() => editorText(code)).toBe('return 41 + 100')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => editorText(code)).toBe('return 41 + 1')
    // The editor's undo didn't run: the block is still there.
    await expect(block(page, 'code1')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  await test.step('what undo left is what was saved', async () => {
    await saved(page)
    await page.reload()
    await expect(block(page, 'code1')).toBeVisible()
    await expect(block(page, 'response1')).toHaveCount(0)
    await block(page, 'code1').click()
    await expect.poll(() => editorText(field(page, 'code1', 'code.js'))).toBe('return 41 + 1')
    // A loaded draft starts with nothing to undo.
    await expect(undo).toBeDisabled()
  })
})

/** Found while planning M13: with Use, the canvas moved and deleted blocks it never saved. Now it's read-only. */
test('people with Use see the draft read-only', async ({ page, browser }) => {
  await signIn(page)
  const id = await newWorkflow(page, `Read only ${Date.now().toString(36)}`)
  await addBlock(page, 'code')
  await expect(block(page, 'code1')).toBeVisible()
  await saved(page)
  const groups = await (await page.request.get('/api/trpc/groups.list')).json()
  const everyone = (groups.result.data.json as { id: string; systemKind: string | null }[]).find(
    (g) => g.systemKind === 'all_users',
  )!
  await trpcMutate(page, 'permissions.set', {
    objectType: 'workflow',
    objectId: id,
    groupId: everyone.id,
    environmentId: null,
    level: 'use',
  })

  const member = await (await browser.newContext()).newPage()
  await signIn(member, E2E_MEMBER_EMAIL)
  await member.goto(`/workflows/${id}`)
  await expect(member.getByText('Read only', { exact: true })).toBeVisible()
  await expect(member.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)

  // Dragging doesn't move the block (at most the view pans), and Delete doesn't remove it.
  const node = member.locator('.react-flow__node[data-id="code1"]')
  const position = () => node.evaluate((el) => (el as HTMLElement).style.transform)
  const before = await position()
  const box = (await block(member, 'code1').boundingBox())!
  await member.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await member.mouse.down()
  await member.mouse.move(box.x + 200, box.y + 150, { steps: 10 })
  await member.mouse.up()
  expect(await position()).toBe(before)
  await block(member, 'code1').click()
  await member.keyboard.press('Delete')
  await member.keyboard.press('ControlOrMeta+Z')
  await expect(block(member, 'code1')).toBeVisible()
  await expect(member.getByTestId('save-status')).toHaveText('Saved')
  await member.context().close()
})
