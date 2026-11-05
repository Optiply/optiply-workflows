import { expect, type Page, test } from '@playwright/test'
import { openEditorPanel, signIn, trpcMutate } from './helpers'

type Draft = {
  components: { name: string; parent?: string; props?: { value?: string } }[]
  queries: { name: string; code?: string }[]
}

async function appWith(page: Page, name: string, definition: object): Promise<string> {
  const slug = `${name}-${Date.now().toString(36)}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: { schemaVersion: 1, ...definition },
  })
  return slug
}

async function draftOf(page: Page, slug: string): Promise<Draft> {
  const res = await page.request.get(
    `/api/trpc/apps.get?input=${encodeURIComponent(JSON.stringify({ json: { slug } }))}`,
  )
  return (await res.json()).result.data.json.draftDefinition
}

const saved = (page: Page) => expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })
/** A component in the sidebar's tree. */
const inTree = (page: Page, name: string) =>
  page
    .getByTestId('component-tree')
    .locator('li button')
    .filter({ has: page.getByText(name, { exact: true }) })
const at = (x: number, y: number, w = 6, h = 2) => ({ x, y, w, h })

/** M13 step 4: copy components and code between apps, duplicate them, and refuse what wasn't copied here. */
test('copy, paste and duplicate components and code between apps', async ({ page }) => {
  await signIn(page)
  const source = await appWith(page, 'clip-a', {
    components: [
      { name: 'container1', type: 'container' },
      { name: 'textInput1', type: 'textInput', parent: 'container1' },
      { name: 'text1', type: 'text', parent: 'container1', props: { value: '{{ textInput1.value }}!' } },
    ],
    queries: [{ name: 'greet', kind: 'js', code: 'return "hi " + textInput1.value' }],
    layout: { container1: at(0, 0, 12, 6), textInput1: at(0, 0), text1: at(6, 0) },
  })
  const target = await appWith(page, 'clip-b', {
    components: [{ name: 'textInput1', type: 'textInput' }],
    queries: [],
    layout: { textInput1: at(0, 0) },
  })

  await test.step('copy a container with what is inside it', async () => {
    await page.goto(`/apps/${source}/edit`)
    await openEditorPanel(page, 'Component tree')
    await inTree(page, 'container1').click()
    await page.keyboard.press('ControlOrMeta+C')
  })

  await test.step('paste it into another app: fresh names, the reference follows', async () => {
    await page.goto(`/apps/${target}/edit`)
    await openEditorPanel(page, 'Component tree')
    await inTree(page, 'textInput1').click()
    await page.keyboard.press('ControlOrMeta+V')
    await expect(inTree(page, 'textInput2')).toBeVisible()
    await saved(page)
    const draft = await draftOf(page, target)
    expect(draft.components.map((c) => [c.name, c.parent ?? null])).toEqual([
      ['textInput1', null],
      ['container1', null],
      ['textInput2', 'container1'],
      ['text1', 'container1'],
    ])
    expect(draft.components.find((c) => c.name === 'text1')!.props!.value).toBe('{{ textInput2.value }}!')
  })

  await test.step('undo the paste, redo it', async () => {
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(inTree(page, 'textInput2')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect(inTree(page, 'textInput2')).toBeVisible()
  })

  await test.step('duplicate the container next to itself', async () => {
    await inTree(page, 'container1').click()
    await page.keyboard.press('ControlOrMeta+D')
    await expect(inTree(page, 'container2')).toBeVisible()
    await saved(page)
    const draft = await draftOf(page, target)
    const copy = draft.components.slice(4)
    expect(copy.map((c) => [c.name, c.parent ?? null])).toEqual([
      ['container2', null],
      ['textInput3', 'container2'],
      ['text2', 'container2'],
    ])
    expect(copy[2]!.props!.value).toBe('{{ textInput3.value }}!')
  })

  await test.step('copy a query into the other app: it reads what is there now, and says so', async () => {
    await page.goto(`/apps/${source}/edit`)
    await openEditorPanel(page, 'Code')
    await page.locator('nav').getByText('greet', { exact: true }).click()
    await page.keyboard.press('ControlOrMeta+C')
    await page.goto(`/apps/${target}/edit`)
    await openEditorPanel(page, 'Component tree')
    await expect(inTree(page, 'container2')).toBeVisible()
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('ControlOrMeta+V')
    await expect(page.getByTestId('query-greet')).toBeVisible()
    await expect(
      page.getByText("It reads what wasn't copied and now reads this app's: textInput1."),
    ).toBeVisible()
    await saved(page)
    expect((await draftOf(page, target)).queries.map((q) => q.name)).toEqual(['greet'])
  })

  await test.step("code this browser didn't copy asks first, naming what would run by itself", async () => {
    const crafted = JSON.stringify({
      ow: 'app-code',
      v: 1,
      queries: [
        { name: 'sneaky', kind: 'resource', resource: 'optiply_db', query: { sql: 'select 1' }, run: 'auto' },
      ],
      transformers: [],
      variables: [],
    })
    await page.evaluate((t) => {
      const data = new DataTransfer()
      data.setData('text/plain', t)
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    }, crafted)
    const asked = page.getByRole('dialog', { name: 'Paste from elsewhere?' })
    await expect(asked).toContainText('sneaky would run straight away')
    await asked.getByTestId('confirm-cancel').click()
    await page.waitForTimeout(1000)
    expect((await draftOf(page, target)).queries.map((q) => q.name)).toEqual(['greet'])
  })
})

/** PR #17 review: shortcuts on a modal being edited, and pasting into a container named like the copied one. */
test('shortcuts work inside a modal being edited; a copy from another app goes into a same-named container', async ({
  page,
}) => {
  await signIn(page)
  const source = await appWith(page, 'clip-c', {
    components: [
      { name: 'container1', type: 'container' },
      { name: 'textInput1', type: 'textInput', parent: 'container1' },
    ],
    queries: [],
    layout: { container1: at(0, 0, 12, 4), textInput1: at(0, 0) },
  })
  const target = await appWith(page, 'clip-d', {
    components: [
      { name: 'container1', type: 'container' },
      { name: 'modal1', type: 'modal' },
      { name: 'text1', type: 'text', parent: 'modal1', props: { value: 'In the modal' } },
    ],
    queries: [],
    layout: { container1: at(0, 0, 12, 6), text1: at(0, 0) },
  })

  await test.step("paste another app's container1 with the target's container1 selected: it goes inside", async () => {
    await page.goto(`/apps/${source}/edit`)
    await openEditorPanel(page, 'Component tree')
    await inTree(page, 'container1').click()
    await page.keyboard.press('ControlOrMeta+C')
    await page.goto(`/apps/${target}/edit`)
    await openEditorPanel(page, 'Component tree')
    await inTree(page, 'container1').click()
    await page.keyboard.press('ControlOrMeta+V')
    await expect(inTree(page, 'container2')).toBeVisible()
    await saved(page)
    const pasted = (await draftOf(page, target)).components.find((c) => c.name === 'container2')
    expect(pasted?.parent).toBe('container1')
  })

  await test.step('duplicate and undo inside the modal the editor shows', async () => {
    await inTree(page, 'text1').click()
    await expect(page.getByRole('dialog', { name: 'modal1' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+D')
    await expect(inTree(page, 'text2')).toBeVisible()
    await saved(page)
    expect((await draftOf(page, target)).components.find((c) => c.name === 'text2')?.parent).toBe('modal1')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(inTree(page, 'text2')).toHaveCount(0)
  })
})
