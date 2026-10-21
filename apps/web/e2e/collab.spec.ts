import { expect, type Page, test } from '@playwright/test'
import { E2E_SECOND_EMAIL } from './global-setup'
import { addBlock, block, clickEmptyCanvas, editorText, field, signIn, trpcMutate, typeInto } from './helpers'

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

/**
 * M16 step 4: two people typing in one code field at once: both texts kept, each cursor where it was and shown to the
 * other, ⌘Z one's own.
 */
test('two people typing in one code field merge as they type', async ({ page, browser }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(`Typing ${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await block(page, 'startTrigger').click()
  await addBlock(page, 'code')
  await saved(page)

  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other)
  await other.goto(page.url())
  await block(other, 'code1').click()
  const mine = field(page, 'code1', 'code.js')
  const theirs = field(other, 'code1', 'code.js')
  await expect.poll(() => editorText(theirs)).toBe('return null')

  // One types at the end of the line, the other at its start, keystrokes interleaved.
  await mine.click()
  await page.keyboard.press('End')
  await theirs.click()
  await other.keyboard.press('Home')
  await Promise.all([
    page.keyboard.type('// mine', { delay: 60 }),
    other.keyboard.type('/*theirs*/', { delay: 60 }),
  ])
  const merged = '/*theirs*/return null// mine'
  await expect.poll(() => editorText(mine)).toBe(merged)
  await expect.poll(() => editorText(theirs)).toBe(merged)
  await saved(page)
  await saved(other)

  // Each sees the other's caret in the field, in their colour; a selection too; gone when they leave the field.
  await expect(mine.locator('.ow-remote-caret')).toHaveCount(1)
  await expect(theirs.locator('.ow-remote-caret')).toHaveCount(1)
  await other.keyboard.press('Shift+End')
  await expect(mine.locator('.ow-remote-selection')).toHaveCount(1)
  await other.keyboard.press('End')
  await expect(mine.locator('.ow-remote-selection')).toHaveCount(0)
  await clickEmptyCanvas(other)
  await expect(mine.locator('.ow-remote-caret')).toHaveCount(0)
  // (Clicking the canvas closed their inspector: open it again.)
  await block(other, 'code1').click()
  await mine.click()
  await page.keyboard.press('End')

  // Undo in the field takes back this side's typing only.
  await page.keyboard.press('ControlOrMeta+Z')
  await expect.poll(() => editorText(mine)).toBe('/*theirs*/return null')
  await expect.poll(() => editorText(theirs)).toBe('/*theirs*/return null')
  await saved(page)

  await otherContext.close()
})

/** M16 step 5: who else is here (avatars), what they have selected (outlines with names) and where their pointer is. */
test('presence in the workflow editor: avatars, selections and pointers', async ({ page, browser }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(`Presence ${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await block(page, 'startTrigger').click()
  await addBlock(page, 'code')
  await saved(page)
  // Nobody else yet; oneself isn't shown.
  await expect(page.getByTestId('presence')).toHaveCount(0)

  const secondContext = await browser.newContext()
  const second = await secondContext.newPage()
  await signIn(second, E2E_SECOND_EMAIL)
  await second.goto(page.url())
  await saved(second)

  await test.step('each sees the other in the header', async () => {
    await expect(page.getByTestId('presence-Second')).toBeVisible()
    await expect(second.getByTestId('presence-E2E')).toBeVisible()
  })

  await test.step("a block selected there is outlined here with their name, and this one's there", async () => {
    await block(second, 'code1').click()
    await expect(page.getByTestId('peers-code1')).toHaveText('Second')
    await clickEmptyCanvas(page)
    await block(page, 'startTrigger').click()
    await expect(second.getByTestId('peers-startTrigger')).toHaveText('E2E')
    await clickEmptyCanvas(second)
    await expect(page.getByTestId('peers-code1')).toHaveCount(0)
  })

  await test.step('their pointer moves on the canvas here, and goes when it leaves', async () => {
    const box = (await second.getByTestId('canvas').boundingBox())!
    await second.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await second.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 5 })
    await expect(page.getByTestId('pointer-Second')).toBeVisible()
    await second.mouse.move(box.x + box.width / 2, box.y - 40)
    await expect(page.getByTestId('pointer-Second')).toHaveCount(0)
  })

  await test.step('closing their editor takes them away', async () => {
    await secondContext.close()
    await expect(page.getByTestId('presence')).toHaveCount(0)
  })
})

/** M16 step 6: the app editor on the shared document: edits both ways, live in the running draft, undo one's own. */
test('two editors of one app see each other’s edits', async ({ page, browser }) => {
  await signIn(page)
  const slug = `together-${Date.now()}`
  await trpcMutate(page, 'apps.create', { slug, name: 'Together' })
  await page.goto(`/apps/${slug}/edit`)
  const appSaved = (p: Page) => expect(p.getByText('Saved', { exact: true })).toBeVisible()
  await appSaved(page)

  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other)
  await other.goto(`/apps/${slug}/edit`)
  await appSaved(other)

  await test.step('a component added here appears there, and a prop typed there shows here', async () => {
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await expect(other.getByTestId('frame-text1')).toBeVisible()
    await other.getByTestId('frame-text1').click()
    await typeInto(other, other.locator('[data-testid$="/components/0/props/value"]'), 'From the other side')
    await expect(page.getByTestId('frame-text1')).toContainText('From the other side')
    await appSaved(page)
    await appSaved(other)
  })

  await test.step("undo takes back one's own edit, not the other's made after it", async () => {
    await page.getByRole('button', { name: 'Button', exact: true }).click()
    await expect(other.getByTestId('frame-button1')).toBeVisible()
    await other.getByRole('button', { name: 'Text input', exact: true }).click()
    await expect(page.getByTestId('frame-textInput1')).toBeVisible()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByTestId('frame-button1')).toHaveCount(0)
    await expect(other.getByTestId('frame-button1')).toHaveCount(0)
    await expect(page.getByTestId('frame-textInput1')).toBeVisible()
    await expect(page.getByTestId('frame-text1')).toContainText('From the other side')
    await appSaved(page)
  })

  await otherContext.close()
})

/** M16 step 6: an app query's code typed in by two people at once: merged, each cursor kept, ⌘Z one's own. */
test('two people typing in one app query merge as they type', async ({ page, browser }) => {
  await signIn(page)
  const slug = `typing-${Date.now()}`
  const { id } = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Typing' })
  await trpcMutate(page, 'apps.saveDraft', {
    id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [],
      queries: [{ name: 'query1', kind: 'js', code: 'return 1' }],
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await signIn(other)
  await other.goto(`/apps/${slug}/edit`)
  const mine = page.locator('[data-testid$="/queries/0/code"]')
  const theirs = other.locator('[data-testid$="/queries/0/code"]')
  await expect.poll(() => editorText(mine)).toBe('return 1')
  await expect.poll(() => editorText(theirs)).toBe('return 1')

  await mine.click()
  await page.keyboard.press('End')
  await theirs.click()
  await other.keyboard.press('Home')
  await Promise.all([
    page.keyboard.type(' + 2', { delay: 60 }),
    other.keyboard.type('/* x */ ', { delay: 60 }),
  ])
  const merged = '/* x */ return 1 + 2'
  await expect.poll(() => editorText(mine)).toBe(merged)
  await expect.poll(() => editorText(theirs)).toBe(merged)
  await expect(mine.locator('.ow-remote-caret')).toHaveCount(1)

  await page.keyboard.press('ControlOrMeta+Z')
  await expect.poll(() => editorText(theirs)).toBe('/* x */ return 1')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await otherContext.close()
})

/** M16 step 6: presence in the app editor: avatars, components selected elsewhere outlined, pointers on the page. */
test('presence in the app editor: avatars, selections and pointers', async ({ page, browser }) => {
  await signIn(page)
  const slug = `presence-${Date.now()}`
  await trpcMutate(page, 'apps.create', { slug, name: 'Presence' })
  await page.goto(`/apps/${slug}/edit`)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByTestId('presence')).toHaveCount(0)

  const secondContext = await browser.newContext()
  const second = await secondContext.newPage()
  await signIn(second, E2E_SECOND_EMAIL)
  await second.goto(`/apps/${slug}/edit`)
  await expect(page.getByTestId('presence-Second')).toBeVisible()
  await expect(second.getByTestId('presence-E2E')).toBeVisible()

  // text1 is selected here (just added): outlined there with this one's name, and the other way round.
  await expect(second.getByTestId('peers-text1')).toHaveText('E2E')
  await second.getByTestId('frame-text1').click()
  await expect(page.getByTestId('peers-text1')).toHaveText('Second')

  const box = (await second.getByTestId('grid-page').boundingBox())!
  await second.mouse.move(box.x + 200, box.y + 200, { steps: 5 })
  await expect(page.getByTestId('pointer-Second')).toBeVisible()
  await second.mouse.move(box.x + 200, 5)
  await expect(page.getByTestId('pointer-Second')).toHaveCount(0)

  await secondContext.close()
  await expect(page.getByTestId('presence')).toHaveCount(0)
  await expect(page.getByTestId('peers-text1')).toHaveCount(0)
})
