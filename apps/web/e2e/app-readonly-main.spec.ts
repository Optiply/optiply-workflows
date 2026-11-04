import { expect, test } from '@playwright/test'
import { e2eRepo, ensureBranch, useE2eRepo } from './git-helpers'
import { signIn, trpcMutate } from './helpers'

/**
 * M22: a protected app's editor on main shows what's deployed without letting it be edited (the inspector, code
 * fields, pages and the code panel disabled; nothing to add or delete), while queries still run. On a branch it's
 * editable again.
 */
test('a protected app is read-only on main and editable on a branch', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await useE2eRepo(page)
  ensureBranch(e2eRepo().dir, 'main')
  const stamp = Date.now()
  const slug = `readonly-${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: `Read-only ${stamp}` })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'email', type: 'text', props: { value: '{{ customer.data[0].email }}' } }],
      queries: [
        {
          name: 'customer',
          kind: 'resource',
          resource: 'shop_db',
          query: { sql: 'select email from customers where id = 1' },
          run: 'auto',
        },
      ],
      layout: { email: { x: 0, y: 0, w: 6, h: 1 } },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  await trpcMutate(page, 'git.protect', { kind: 'app', id: app.id })

  await page.goto(`/apps/${slug}/edit`)
  await expect(page.getByTestId('read-only-banner')).toBeVisible()
  // The code panel: nothing to add or delete, settings disabled, the SQL read-only; Run still works.
  await expect(page.getByTitle('Add a resource query')).toHaveCount(0)
  await page.getByRole('button', { name: 'customer', exact: true }).click()
  const query = page.getByTestId('query-customer')
  await expect(query.getByLabel('Resource')).toBeDisabled()
  await expect(query.getByTitle('Delete query')).toBeHidden()
  await expect(query.getByRole('textbox', { name: 'Name' })).toBeDisabled()
  const sql = query.locator('.monaco-editor .view-lines').first()
  await expect(sql).toContainText('select email')
  const before = await sql.innerText()
  await sql.click()
  await page.keyboard.type('zzz')
  await expect(sql).toHaveText(before)
  await expect(query.getByRole('button', { name: 'Run' })).toBeEnabled()
  // The inspector: disabled.
  await page.getByRole('button', { name: 'email Text', exact: true }).click()
  await expect(page.getByTestId('inspector')).toHaveAttribute('disabled', '')
  await expect(page.getByTestId('inspector').getByRole('textbox', { name: 'Name' })).toBeDisabled()

  // On a branch: editable.
  await page.goto(`/apps/${slug}/edit?branch=${encodeURIComponent(`edit/${stamp}`)}`)
  await expect(page.getByTestId('branch-details-open')).toBeVisible()
  await expect(page.getByTitle('Add a resource query')).toBeVisible()
  await page.getByRole('button', { name: 'customer', exact: true }).click()
  await expect(page.getByTestId('query-customer').getByLabel('Resource')).toBeEnabled()
  await page.getByRole('button', { name: 'email Text', exact: true }).click()
  await expect(page.getByTestId('inspector')).not.toHaveAttribute('disabled')
  await expect(page.getByTestId('inspector').getByRole('textbox', { name: 'Name' })).toBeEnabled()
  expect(errors).toEqual([])
})
