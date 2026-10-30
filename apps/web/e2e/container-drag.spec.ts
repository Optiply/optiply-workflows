import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

type Def = {
  components: { name: string; parent?: string; slot?: string }[]
  layout: Record<string, unknown>
}

/**
 * Dragging components between grids (M24): into a container's view, a selection into a form, back out to the page;
 * a drop that can't be (a container into itself) changes nothing; each drop is one undo step, and undoing them all
 * gives back the exact starting definition.
 */
test('drags components into, out of and between containers', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `drag-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Drag' })
  const start = {
    schemaVersion: 1,
    components: [
      { name: 'box', type: 'container', props: { views: [{ name: 'list' }, { name: 'details' }] } },
      { name: 'inBox', type: 'text', parent: 'box', slot: 'list', props: { value: 'In the box' } },
      { name: 'form1', type: 'form', props: {} },
      { name: 'a', type: 'text', props: { value: 'Text a' } },
      { name: 'b', type: 'text', props: { value: 'Text b' } },
    ],
    queries: [],
    transformers: [],
    variables: [],
    // Already compact, as the editor keeps it.
    layout: {
      box: { x: 0, y: 0, w: 6, h: 14 },
      inBox: { x: 0, y: 0, w: 6, h: 2 },
      form1: { x: 6, y: 0, w: 6, h: 14 },
      a: { x: 0, y: 14, w: 3, h: 2 },
      b: { x: 3, y: 14, w: 3, h: 2 },
    },
  }
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition: start })
  const draft = async () =>
    (await trpcQuery<{ draftDefinition: Def }>(page, 'apps.get', { slug })).draftDefinition
  const where = async (name: string) => {
    const c = (await draft()).components.find((x) => x.name === name)
    return c ? [c.parent ?? null, c.slot ?? null] : null
  }
  await page.goto(`/apps/${slug}/edit`)

  await test.step('into a container’s view', async () => {
    await move(page, 'a', 'grid-box-list')
    await expect.poll(() => where('a')).toEqual(['box', 'list'])
    await expect(page.getByTestId('grid-box-list')).toContainText('Text a')
  })

  await test.step('a selection into a form, from two grids at once', async () => {
    // Near the top: a dropped component stays where it lands (session 33), and the move handle of one pushed below
    // it covers its lower half.
    await page.getByTestId('frame-a').click({ position: { x: 8, y: 4 } })
    await page.getByTestId('frame-b').click({ modifiers: ['Shift'], position: { x: 8, y: 4 } })
    await move(page, 'b', 'grid-form1')
    await expect
      .poll(async () => [await where('a'), await where('b')])
      .toEqual([
        ['form1', null],
        ['form1', null],
      ])
    // b, the one grabbed (picked second), lands in the drop's column, the form's first (a, kept at its offset from
    // b, is held on the grid and may push b a row down); taken from a, b would have come in at a's offset, x 3.
    const layout = (await draft()).layout as Record<string, { x: number; y: number }>
    expect(layout.b!.x).toBe(0)
  })

  await test.step('back out to the page', async () => {
    // Near its top: b, just below a, has its handle bar over a's lower half.
    await page.getByTestId('frame-a').click({ position: { x: 8, y: 4 } })
    await move(page, 'a', 'grid-page')
    await expect.poll(() => where('a')).toEqual([null, null])
  })

  await test.step('a container can’t go inside itself', async () => {
    const before = JSON.stringify(await draft())
    await move(page, 'box', 'grid-box-list')
    await page.waitForTimeout(500)
    expect(JSON.stringify(await draft())).toBe(before)
  })

  await test.step('three undos: the exact starting definition', async () => {
    await page.locator('body').click({ position: { x: 5, y: 300 } })
    for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+z')
    // Compared with keys in order: the shared document keeps an object's keys sorted.
    await expect
      .poll(async () => {
        const def = await draft()
        return sorted({ components: def.components, layout: def.layout })
      })
      .toBe(sorted({ components: start.components, layout: start.layout }))
  })
  await test.step('the palette drops into a container’s view too', async () => {
    const data = await page.evaluateHandle(() => new DataTransfer())
    const text = page.getByRole('button', { name: 'Text', exact: true })
    await text.dispatchEvent('dragstart', { dataTransfer: data })
    const target = page.getByTestId('grid-box-list').locator('.react-grid-layout').first()
    const box = (await target.boundingBox())!
    const at = { dataTransfer: data, clientX: box.x + 20, clientY: box.y + 60 }
    for (const type of ['dragenter', 'dragover', 'dragover', 'drop']) await target.dispatchEvent(type, at)
    await text.dispatchEvent('dragend', { dataTransfer: data })
    await expect.poll(() => where('text1')).toEqual(['box', 'list'])
  })
  expect(errors).toEqual([])
})

/** JSON with every object's keys sorted. */
const sorted = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )

/**
 * Drags a component by its move grip onto a grid, as the browser would: dragstart on the grip, then dragenter,
 * dragover and drop on the grid's layout, 20px in from its corner (headless Chromium doesn't start a native drag
 * from Playwright's mouse here).
 */
async function move(page: Page, name: string, grid: string) {
  const frame = page.getByTestId(`frame-${name}`)
  await frame.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  // Near its top: the handle bar of a component just below can cover its lower half.
  await frame.hover({ position: { x: 8, y: 4 } })
  const data = await page.evaluateHandle(() => new DataTransfer())
  const grip = page.getByTestId(`move-${name}`)
  await grip.dispatchEvent('dragstart', { dataTransfer: data })
  const target = page.getByTestId(grid).locator('.react-grid-layout').first()
  const box = (await target.boundingBox())!
  const at = { dataTransfer: data, clientX: box.x + 20, clientY: box.y + 10 }
  await target.dispatchEvent('dragenter', at)
  await target.dispatchEvent('dragover', at)
  await target.dispatchEvent('dragover', at)
  await target.dispatchEvent('drop', at)
  await grip.dispatchEvent('dragend', { dataTransfer: data })
}
