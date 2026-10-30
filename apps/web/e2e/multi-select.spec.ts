import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

type Def = {
  components: { name: string; parent?: string }[]
  layout: Record<string, { x: number; y: number; w: number; h: number }>
}

/**
 * Several components selected (M24): shift- and cmd-click on the canvas and in the tree, the arrow keys and a drag
 * moving them together, Delete with undo bringing them back selected, ⌘A and Escape, Duplicate and Move into from
 * the inspector.
 */
test('selects several components and moves, deletes, duplicates them together', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `multi-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Multi' })
  const text = (name: string) => ({ name, type: 'text', props: { value: `Text ${name}` } })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [text('a'), text('b'), text('c'), text('d'), { name: 'box', type: 'container', props: {} }],
      queries: [],
      transformers: [],
      variables: [],
      // Already compact: the grid moves things up into gaps, which would move them for it.
      layout: {
        a: { x: 0, y: 0, w: 3, h: 2 },
        b: { x: 3, y: 0, w: 3, h: 2 },
        c: { x: 6, y: 0, w: 3, h: 2 },
        d: { x: 0, y: 2, w: 3, h: 2 },
        box: { x: 0, y: 4, w: 12, h: 10 },
      },
    },
  })
  const draft = async () =>
    (await trpcQuery<{ draftDefinition: Def }>(page, 'apps.get', { slug })).draftDefinition
  const saved = () => expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const at = async (names: string[]) => {
    const def = await draft()
    return names.map((n) => [def.layout[n]!.x, def.layout[n]!.y])
  }
  await page.goto(`/apps/${slug}/edit`)

  await test.step('shift- and cmd-click select several; the tree shows them', async () => {
    await page.getByTestId('frame-a').click()
    await page.getByTestId('frame-b').click({ modifiers: ['Shift'] })
    await page.getByTestId('frame-c').click({ modifiers: ['ControlOrMeta'] })
    await expect(page.getByTestId('inspector-selection')).toContainText('3 components selected')
    const tree = page.getByRole('list').filter({ has: page.getByRole('button', { name: /^d\b/ }) })
    await expect(tree.getByRole('button', { pressed: true })).toHaveCount(3)
    // Shift-click in the tree takes one out.
    await tree.getByRole('button', { name: /^c\b/ }).click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('inspector-selection')).toContainText('2 components selected')
    await page.getByTestId('frame-c').click({ modifiers: ['Shift'] })
  })

  await test.step('the arrow keys move them together, and they stay where they are put', async () => {
    const before = await at(['a', 'b', 'c', 'd'])
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => at(['a', 'b', 'c', 'd']))
      .toEqual(before.map(([x, y], i) => (i < 3 ? [x! + 1, y!] : [x, y])))
    // Down a row: they stay there (session 33: nothing floats back up into the gap).
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => at(['a', 'b', 'c'])).toEqual(before.slice(0, 3).map(([x, y]) => [x! + 1, y! + 1]))
  })

  await test.step('dragging one drags the others by as much', async () => {
    const before = await at(['a', 'b', 'c'])
    await drag(page, 'a', -100, 0)
    await expect
      .poll(async () => {
        const now = await at(['a', 'b', 'c'])
        return now.map(([x], i) => x! - before[i]![0]!)
      })
      .toEqual([-1, -1, -1])
  })

  await test.step('Delete removes them; undo brings them back, selected', async () => {
    await page.keyboard.press('Delete')
    await expect(page.getByTestId('frame-a')).toHaveCount(0)
    await expect(page.getByTestId('frame-c')).toHaveCount(0)
    await expect(page.getByTestId('frame-d')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByTestId('frame-a')).toBeVisible()
    await expect(page.getByTestId('inspector-selection')).toContainText('3 components selected')
  })

  await test.step('⌘A selects everything on the page; Escape nothing', async () => {
    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.getByTestId('inspector-selection')).toContainText('5 components selected')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('inspector-selection')).toHaveCount(0)
    await expect(page.getByTestId('inspector')).toHaveCount(0)
  })

  await test.step('Duplicate and Move into, from the inspector', async () => {
    await page.getByTestId('frame-a').click()
    await page.getByTestId('frame-d').click({ modifiers: ['Shift'] })
    await page.getByTestId('inspector-selection').getByRole('button', { name: 'Duplicate' }).click()
    await expect(page.getByTestId('frame-a1')).toBeVisible()
    await expect(page.getByTestId('frame-d1')).toBeVisible()
    await page.getByTestId('frame-a').click()
    await page.getByTestId('frame-d').click({ modifiers: ['Shift'] })
    await page.getByTestId('inspector-selection').getByLabel('Move into').selectOption('box')
    await saved()
    await expect
      .poll(async () => (await draft()).components.filter((c) => c.parent === 'box').map((c) => c.name))
      .toEqual(['a', 'd'])
  })
  expect(errors).toEqual([])
})

/** Drags a component by its handle. */
async function drag(page: Page, name: string, dx: number, dy: number) {
  // The handle sits just above the component and shows on hover: the component in the canvas's middle, so the
  // handle isn't under the page header.
  await page.getByTestId(`frame-${name}`).evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await page.getByTestId(`frame-${name}`).hover()
  const handle = page.getByTestId(`frame-${name}`).getByTitle('Drag to move')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + box.height / 2 + dy / 2, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 })
  await page.mouse.up()
}
