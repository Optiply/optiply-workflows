import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

// Session 33: duplicating a workflow from the list (opened, its triggers off) and deleting one.

test('duplicate a workflow from the list, then delete the copy', async ({ page }) => {
  await signIn(page)
  const slug = `dup-${Date.now().toString(36)}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: `Nightly ${slug}` })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'hello', type: 'code', config: { code: 'return 1' } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'hello' }],
      triggers: { schedules: [{ name: 'night', enabled: true, cron: '0 2 * * *' }] },
    },
  })

  await page.goto('/workflows')
  await page.getByTestId(`duplicate-${slug}`).click()
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(`Nightly ${slug} (copy)`)
  await expect(page.getByRole('textbox', { name: 'Slug' })).toHaveValue(`${slug}-copy`)
  await page.getByTestId('duplicate-confirm').click()
  // The copy opens, with the original's blocks.
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  expect(page.url()).not.toContain(flow.id)
  await expect(page.getByTestId('block-hello')).toBeVisible()

  await page.goto('/workflows')
  await page.getByTestId(`actions-${slug}-copy`).click()
  await page.getByTestId(`delete-${slug}-copy`).click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId(`workflow-${slug}-copy`)).toHaveCount(0)
  await expect(page.getByTestId(`workflow-${slug}`)).toBeVisible()
})
