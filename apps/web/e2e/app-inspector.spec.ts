import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

interface Draft {
  draftDefinition: {
    components: { name: string; type: string; note?: string; props?: Record<string, unknown> }[]
  }
}

/**
 * The inspector (session 41): Content / Interaction / Appearance / Layout sections that fold, the live value under a
 * focused {{ }} field, a note for editors, and the ··· menu's Switch to and Reset state.
 */
test('the inspector: sections, live value, note, switch type, reset state', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `inspector-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Inspector' })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'qty', type: 'textInput', props: { label: 'Quantity', defaultValue: '2' } },
        { name: 'label', type: 'text', props: { value: 'Ordering {{ qty.value }}' } },
      ],
      queries: [],
      layout: { qty: { x: 0, y: 0, w: 4, h: 4 }, label: { x: 4, y: 0, w: 4, h: 2 } },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  const draft = async () => (await trpcQuery<Draft>(page, 'apps.get', { slug })).draftDefinition
  const saved = () => expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })

  await test.step('sections, folded and unfolded', async () => {
    await page.getByTestId('frame-label').click()
    const inspector = page.getByTestId('inspector-label')
    for (const section of ['Content', 'Interaction', 'Appearance', 'Layout'])
      await expect(inspector.getByRole('region', { name: section })).toBeVisible()
    const appearance = inspector.getByRole('button', { name: 'Appearance' })
    await appearance.click()
    await expect(appearance).toHaveAttribute('aria-expanded', 'false')
    await expect(inspector.getByRole('region', { name: 'Appearance' }).getByText('Hidden')).toHaveCount(0)
    await appearance.click()
    await expect(inspector.getByRole('region', { name: 'Appearance' }).getByText('Hidden')).toBeVisible()
  })

  await test.step('the live value under a focused {{ }} field', async () => {
    const inspector = page.getByTestId('inspector-label')
    await expect(inspector.getByTestId('evaluated-value')).toHaveCount(0)
    await inspector.locator('[data-testid$="/props/value"] .view-lines').click()
    await expect(inspector.getByTestId('evaluated-value')).toContainText('String')
    await expect(inspector.getByTestId('evaluated-value')).toContainText('Ordering 2')
  })

  await test.step('a note for editors', async () => {
    const inspector = page.getByTestId('inspector-label')
    await inspector.getByRole('button', { name: 'Add a note' }).click()
    await inspector.getByLabel('Note').fill('Shows what will be ordered')
    await saved()
    await expect.poll(async () => (await draft()).components[1]!.note).toBe('Shows what will be ordered')
  })

  await test.step('Reset state starts the input afresh', async () => {
    await page.getByTestId('frame-qty').getByRole('textbox').fill('9')
    await expect(page.getByTestId('frame-label')).toContainText('Ordering 9')
    await page.getByTestId('frame-qty').click()
    await page.getByTestId('inspector-qty').getByTitle('More actions').click()
    await page.getByRole('menuitem', { name: 'Reset state' }).click()
    await expect(page.getByTestId('frame-label')).toContainText('Ordering 2')
  })

  await test.step('Switch to a number input keeps what fits', async () => {
    await page.getByTestId('inspector-qty').getByTitle('More actions').click()
    await page.getByRole('menuitem', { name: 'Number input' }).click()
    await expect(page.getByTestId('inspector-qty')).toContainText('Number input')
    await saved()
    const qty = (await draft()).components[0]!
    expect(qty.type).toBe('numberInput')
    // The label fits; the text default '2' isn't a number, so it goes.
    expect(qty.props).toEqual({ label: 'Quantity' })
  })
  expect(errors).toEqual([])
})
