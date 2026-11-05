import { expect, test } from '@playwright/test'
import { openEditorPanel, signIn, trpcMutate } from './helpers'

/**
 * Getting around the editor (session 41): the Search panel over every field (jumping to the field), the graph of
 * what the selection reads and is read by, and the ⌘K palette (jump to anything, run an action).
 */
test('search, the dependency graph and the command palette', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `navigate-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Navigate' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      pages: [{ name: 'orders' }, { name: 'detail', title: 'Details' }],
      components: [
        { name: 'textInput1', type: 'textInput', page: 'orders' },
        { name: 'button1', type: 'button', page: 'orders', props: { text: 'Save {{ textInput1.value }}' } },
        { name: 'who', type: 'text', page: 'detail', props: { value: 'Hi' } },
      ],
      queries: [{ name: 'query1', kind: 'js', page: 'orders', code: 'return textInput1.value' }],
      layout: {
        textInput1: { x: 0, y: 0, w: 4, h: 4 },
        button1: { x: 4, y: 0, w: 2, h: 3 },
        who: { x: 0, y: 0, w: 4, h: 2 },
      },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  await expect(page.getByTestId('frame-button1')).toBeVisible()

  await test.step('search finds names and fields; a hit selects and focuses the field', async () => {
    await openEditorPanel(page, 'Search')
    const panel = page.getByTestId('search-panel')
    await panel.getByRole('searchbox', { name: 'Search the app' }).fill('textInput1')
    await expect(panel).toContainText('3 results in 3 places')
    await expect(panel.getByRole('button', { name: /button1 → Text/ })).toBeVisible()
    await panel.getByRole('button', { name: 'Match case' }).click()
    await panel.getByRole('searchbox', { name: 'Search the app' }).fill('TEXTINPUT1')
    await expect(panel).toContainText('No results')
    await panel.getByRole('button', { name: 'Match case' }).click()
    await panel.getByRole('searchbox', { name: 'Search the app' }).fill('textInput1')
    await panel.getByRole('button', { name: /button1 → Text/ }).click()
    await expect(page.getByTestId('inspector-button1')).toBeVisible()
    await expect(page.locator('[data-testid$="/props/text"] .monaco-editor')).toHaveClass(/focused/)
  })

  await test.step('the graph shows what the selection uses and what uses it', async () => {
    await openEditorPanel(page, 'Component tree')
    const graph = page.getByTestId('dependency-graph')
    await expect(graph.getByRole('list', { name: 'button1 uses' })).toContainText('textInput1')
    await graph
      .getByRole('list', { name: 'button1 uses' })
      .getByRole('button', { name: 'textInput1' })
      .click()
    await expect(page.getByTestId('inspector-textInput1')).toBeVisible()
    await expect(graph.getByRole('list', { name: 'textInput1 is used by' })).toContainText('button1')
    await expect(graph.getByRole('list', { name: 'textInput1 is used by' })).toContainText('query1')
  })

  await test.step('⌘K jumps to anything and runs actions', async () => {
    await page.locator('header h1').click()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const input = palette.getByRole('combobox')
    await input.fill('who')
    await expect(palette.getByRole('option').first()).toContainText('who')
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    // On another page: it opens, and the component is selected.
    await expect(page.getByTestId('inspector-who')).toBeVisible()

    await page.keyboard.press('ControlOrMeta+k')
    await input.fill('add js query')
    await expect(palette.getByRole('option', { selected: true })).toContainText('Add a JS query')
    await input.press('Enter')
    await expect(page.getByTestId('query-query2')).toBeVisible()

    await page.keyboard.press('ControlOrMeta+k')
    await input.press('Escape')
    await expect(palette).toHaveCount(0)
  })
  expect(errors).toEqual([])
})
