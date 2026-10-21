import { expect, type Page, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, editorText, field, signIn, typeInto } from './helpers'

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')

/**
 * M16 step 3a: two people in one workflow's editor see each other's edits as they're made, and everything is saved to
 * the draft (reloading shows it), and undo takes back only one's own edits. Code fields merging as people type and
 * presence come in later steps.
 */
test('two editors of one workflow see each other’s edits', async ({ page, browser }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(`Together ${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await saved(page)
  const url = page.url()

  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other)
  await other.goto(url)
  await saved(other)

  await test.step('a block added on one side appears on the other', async () => {
    await block(page, 'startTrigger').click()
    await addBlock(page, 'code')
    await expect(block(other, 'code1')).toBeVisible()
    await clickEmptyCanvas(page)
  })

  await test.step('code typed on the other side arrives here, and both are saved', async () => {
    await block(other, 'code1').click()
    await typeInto(other, field(other, 'code1', 'code.js'), 'return "together"')
    await saved(other)
    await block(page, 'code1').click()
    await expect.poll(() => editorText(field(page, 'code1', 'code.js'))).toBe('return "together"')
    await saved(page)
  })

  await test.step('a reload shows the draft as saved', async () => {
    await page.reload()
    await block(page, 'code1').click()
    await expect.poll(() => editorText(field(page, 'code1', 'code.js'))).toBe('return "together"')
  })

  await test.step("undo takes back one's own edit, not the other's made after it", async () => {
    await clickEmptyCanvas(page)
    await block(page, 'startTrigger').click()
    await addBlock(page, 'filter')
    await expect(block(other, 'filter1')).toBeVisible()
    await clickEmptyCanvas(other)
    await block(other, 'startTrigger').click()
    await addBlock(other, 'response')
    await expect(block(page, 'response1')).toBeVisible()
    await clickEmptyCanvas(page)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(block(page, 'filter1')).toHaveCount(0)
    await expect(block(other, 'filter1')).toHaveCount(0)
    await expect(block(page, 'response1')).toBeVisible()
    await expect(block(other, 'response1')).toBeVisible()
    await saved(page)
  })

  await otherContext.close()
})
