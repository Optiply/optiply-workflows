import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * Containers folding, scrolling and styled (M24): a collapsible container folds to its header in the app and what's
 * below it moves up; the editor keeps it open, marked; components in its header and footer; its content scrolls
 * inside it; a theme background and a color.
 */
test('folds, scrolls and styles containers, with header and footer areas', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `folding-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Folding' })
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        {
          name: 'box',
          type: 'container',
          props: { title: 'Filters', collapsible: true, background: 'accent', padding: 'small' },
          events: [{ id: 'c', event: 'collapse', action: { type: 'notify', message: 'folded' } }],
        },
        { name: 'inside', type: 'text', parent: 'box', props: { value: 'Inside the box' } },
        { name: 'refresh', type: 'button', parent: 'box', slot: 'header', props: { text: 'Refresh' } },
        { name: 'apply', type: 'button', parent: 'box', slot: 'footer', props: { text: 'Apply' } },
        { name: 'after', type: 'text', props: { value: 'Below the box' } },
        { name: 'tall', type: 'container', props: { background: '#fef3c7' } },
        { name: 'long', type: 'text', parent: 'tall', props: { value: lines } },
      ],
      queries: [],
      transformers: [],
      variables: [],
      layout: {
        box: { x: 0, y: 0, w: 6, h: 14 },
        inside: { x: 0, y: 0, w: 6, h: 2 },
        refresh: { x: 0, y: 0, w: 4, h: 2 },
        apply: { x: 0, y: 0, w: 3, h: 2 },
        after: { x: 0, y: 14, w: 6, h: 2 },
        tall: { x: 6, y: 0, w: 6, h: 8 },
        long: { x: 0, y: 0, w: 12, h: 40 },
      },
    },
  })
  const box = page.locator('[data-component="box"]')
  const top = async (name: string) => (await page.locator(`[data-component="${name}"]`).boundingBox())!.y

  await test.step('in the editor: open, marked when folded, the Area moves a component', async () => {
    await page.goto(`/apps/${slug}/edit`)
    await expect(box.getByRole('button', { name: 'Refresh' })).toBeVisible()
    await expect(box.getByRole('button', { name: 'Apply' })).toBeVisible()
    await box.getByRole('button', { name: 'Fold Filters' }).click()
    await expect(box).toContainText('folded in the app')
    await expect(box).toContainText('Inside the box')
    await box.getByRole('button', { name: 'Unfold Filters' }).click()
    await page.getByTestId('frame-inside').click()
    await page.getByTestId('inspector-inside').getByLabel('Area').selectOption('footer')
    await expect(box.locator('[data-slot="footer"]')).toContainText('Inside the box')
    await page.getByTestId('inspector-inside').getByLabel('Area').selectOption('')
    await expect(box.locator('[data-slot="footer"]')).not.toContainText('Inside the box')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  })

  await test.step('in the app: folding hides all but the header, and what’s below moves up', async () => {
    const revision = (await trpcQuery<{ draftRevision: number }>(page, 'apps.get', { slug })).draftRevision
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: revision })
    await page.goto(`/apps/${slug}`)
    await expect(box).toContainText('Inside the box')
    const before = await top('after')
    await box.getByRole('button', { name: 'Fold Filters' }).click()
    await expect(page.getByText('folded', { exact: true })).toBeVisible()
    await expect(box).not.toContainText('Inside the box')
    await expect(box.getByRole('button', { name: 'Apply' })).toHaveCount(0)
    await expect.poll(() => top('after')).toBeLessThan(before - 100)
    await box.getByRole('button', { name: 'Unfold Filters' }).click()
    await expect(box).toContainText('Inside the box')
    await expect.poll(() => top('after')).toBe(before)
  })

  await test.step('scrolling content and backgrounds', async () => {
    const tall = page.locator('[data-component="tall"]')
    const scroller = tall.locator('.overflow-auto').first()
    expect(await scroller.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
    await scroller.evaluate((e) => {
      e.scrollTop = e.scrollHeight
    })
    await expect(tall.getByText('line 30')).toBeInViewport()
    expect(await tall.locator('> div').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
      'rgb(254, 243, 199)',
    )
    await expect(box.locator('> div')).toHaveClass(/bg-accent-soft/)
  })
  expect(errors).toEqual([])
})
