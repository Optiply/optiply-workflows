import { expect, type Locator, type Page } from '@playwright/test'
import { E2E_EMAIL, E2E_PASSWORD } from './global-setup'

export async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(E2E_EMAIL)
  await page.getByLabel('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/workflows$/)
}

/** A tRPC mutation as the signed-in user (the page's cookies), returning its data. */
export async function trpcMutate<T = Record<string, unknown>>(
  page: Page,
  path: string,
  input: unknown,
): Promise<T> {
  const res = await page.request.post(`/api/trpc/${path}`, { data: { json: input } })
  const body = await res.json()
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${JSON.stringify(body)}`)
  return body.result.data.json
}

export const block = (page: Page, name: string) => page.getByTestId(`block-${name}`)

/** A block's Monaco field, by the end of its model path (`<workflow>/<block>/<file>`). */
export const field = (page: Page, blockName: string, file: string) =>
  page.locator(`[data-testid$="/${blockName}/${file}"]`)

export async function addBlock(page: Page, kind: string) {
  await page.getByTitle(`Add a ${kind} block`).click()
}

/**
 * Replaces a Monaco field's text. The text is inserted in one go, like a paste: typed key by key, Monaco's
 * auto-closing of brackets and quotes races the keystrokes on a slow machine (`{"id": 1}` became `{"id"}: 1}` in CI).
 * The whole replacement is retried until the field shows the text.
 */
export async function typeInto(page: Page, editor: Locator, text: string) {
  const monaco = editor.locator('.monaco-editor')
  await expect(async () => {
    // Near the top-left corner: with more lines than fit, the lines' middle is below the field, over the next one.
    await monaco.locator('.view-lines').click({ position: { x: 4, y: 4 } })
    await expect(monaco).toHaveClass(/focused/, { timeout: 1000 })
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(text)
    await page.keyboard.press('Escape')
    await expect.poll(() => editorText(editor), { timeout: 2000 }).toBe(text)
  }).toPass()
}

/**
 * The text a Monaco field shows. Monaco renders spaces as non-breaking spaces, and long lines wrap onto several
 * rendered lines; the fields this test types are single lines, so line breaks are dropped.
 */
export async function editorText(editor: Locator): Promise<string> {
  const text = await editor.locator('.view-lines').innerText()
  return text.replace(/ /g, ' ').replace(/\n/g, '').trim()
}

/** Drags from one handle to another in small steps, as React Flow expects. */
export async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
  await page.mouse.up()
}

/** Clicks an empty part of the canvas (the toolbar floats top left, controls and minimap sit at the bottom). */
export async function clickEmptyCanvas(page: Page) {
  const box = (await page.locator('.react-flow__pane').boundingBox())!
  await page.mouse.click(box.x + box.width - 40, box.y + 80)
}
