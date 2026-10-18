import { expect, type Page, test } from '@playwright/test'
import { editorText, signIn, trpcMutate, typeInto } from './helpers'

/** The saved draft of an app, from the API. */
async function draftOf(page: Page, slug: string): Promise<unknown> {
  const res = await page.request.get(
    `/api/trpc/apps.get?input=${encodeURIComponent(JSON.stringify({ json: { slug } }))}`,
  )
  return (await res.json()).result.data.json.draftDefinition
}

const saved = (page: Page) => expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })

/** M13 step 3: undo and redo in the app editor, back to each saved draft exactly, layout included. */
test('undo and redo components, props and moves in the app editor', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `undo-${Date.now()}`
  await trpcMutate(page, 'apps.create', { slug, name: 'Undo check' })
  await page.goto(`/apps/${slug}/edit`)
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const redo = page.getByRole('button', { name: 'Redo', exact: true })
  await expect(undo).toBeDisabled()
  const drafts = [await draftOf(page, slug)]

  await test.step('add two components, bind one to the other, move the first', async () => {
    await page.getByRole('button', { name: 'Text input', exact: true }).click()
    await expect(page.getByTestId('inspector-textInput1')).toBeVisible()
    await saved(page)
    drafts.push(await draftOf(page, slug))
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await expect(page.getByTestId('inspector-text1')).toBeVisible()
    await saved(page)
    drafts.push(await draftOf(page, slug))
    await typeInto(
      page,
      page.locator('[data-testid$="/components/1/props/value"]'),
      'Hello {{ textInput1.value }}',
    )
    await expect(page.getByTestId('frame-text1')).toContainText('Hello ')
    await saved(page)
    drafts.push(await draftOf(page, slug))
    await page.getByTestId('frame-textInput1').click()
    const handle = page.getByTestId('frame-textInput1').getByTitle('Drag to move')
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 5)
    await page.mouse.down()
    await page.mouse.move(box.x + 300, box.y + 200, { steps: 12 })
    await page.mouse.up()
    await saved(page)
    drafts.push(await draftOf(page, slug))
    expect(drafts[4]).not.toEqual(drafts[3])
  })

  await test.step('undo each edit: the saved draft is each earlier one, exactly', async () => {
    for (let i = 3; i >= 0; i--) {
      await undo.click()
      await saved(page)
      await expect.poll(() => draftOf(page, slug)).toEqual(drafts[i])
    }
    await expect(undo).toBeDisabled()
    await expect(page.getByTestId('frame-textInput1')).toHaveCount(0)
  })

  await test.step('redo them with the keyboard, back to the last', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    for (let i = 0; i < 4; i++) await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect(redo).toBeDisabled()
    await saved(page)
    await expect.poll(() => draftOf(page, slug)).toEqual(drafts[4])
    await expect(page.getByTestId('frame-text1')).toContainText('Hello ')
  })

  await test.step("⌘Z in a field is the field's own undo", async () => {
    await page.getByTestId('frame-text1').click()
    const value = page.locator('[data-testid$="/components/1/props/value"]')
    await value.locator('.view-lines').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('End')
    await page.keyboard.type('zz')
    await expect.poll(() => editorText(value)).toBe('Hello {{ textInput1.value }}zz')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => editorText(value)).toBe('Hello {{ textInput1.value }}')
    await expect(page.getByTestId('frame-textInput1')).toBeVisible()
  })

  await test.step('Preview has no undo (its keys are the app’s)', async () => {
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(undo).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+Z')
    await page.waitForTimeout(1500) // longer than autosave takes
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(await draftOf(page, slug)).toEqual(drafts[4])
  })
  expect(errors).toEqual([])
})
