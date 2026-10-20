import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { signIn, trpcMutate, trpcQuery, typeInto } from './helpers'

/**
 * The Query Library through the UI (M14 step 3a): a library query created from the Library page, its SQL and a
 * parameter edited, run with the test value, published twice and rolled back.
 */
test('create, run, publish and roll back a library query', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await signIn(page)
  const name = `Plus one ${Date.now()}`

  await page.getByRole('link', { name: 'Library' }).click()
  await expect(page.getByRole('heading', { name: 'Query Library' })).toBeVisible()
  await page.getByRole('button', { name: 'New query' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create query' }).click()
  await expect(page).toHaveURL(/\/library\/plus_one_\d+$/)
  const slug = page.url().split('/library/')[1]!

  // A parameter with a test value, read by the SQL.
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Parameter 1 name').fill('n')
  await page.getByLabel('n test value').fill('41')
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int + 1 as x')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.getByTestId('library-run').getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('library-run')).toContainText('42')

  // A name the query doesn't declare is a problem, shown at once, and Publish waits for the fix.
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ m }}::int as x')
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int + 1 as x')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  // v1.0.0, then v1.1.0.
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0')
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int + 2 as x')
  await expect(page.getByTestId('release-status')).toContainText('Unpublished changes')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByLabel('Version').selectOption('minor')
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.1.0')

  // Roll back; the list shows what's live.
  await page.getByTestId('release-status').click()
  await page.getByTestId('releases').getByRole('button', { name: 'Make live' }).click()
  await expect(page.getByTestId('releases').locator('li').filter({ hasText: 'v1.0.0' })).toContainText('Live')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-used-by')).toContainText('No app or module uses it yet')
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await expect(page.getByTestId(`library-${slug}`)).toContainText('Live v1.0.0')
})

/** In the app editor (M14 step 3b): a library query added from the picker, its parameter filled, run and pinned. */
test('use a library query in an app', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const lib = await trpcMutate<{ id: string; slug: string }>(page, 'libraryQueries.create', {
    slug: `double_${stamp}`,
    name: `Double ${stamp}`,
  })
  const save = (revision: number, sql: string) =>
    trpcMutate<{ revision: number }>(page, 'libraryQueries.saveDraft', {
      id: lib.id,
      revision,
      definition: {
        schemaVersion: 1,
        resource: 'optiply_db',
        query: { sql },
        params: [{ name: 'n', description: 'A number' }],
      },
    })
  let { revision } = await save(1, 'select {{ n }}::int * 2 as x')
  await trpcMutate(page, 'libraryQueries.publish', { libraryQueryId: lib.id, draftRevision: revision })
  ;({ revision } = await save(revision, 'select {{ n }}::int * 3 as x'))
  await trpcMutate(page, 'libraryQueries.publish', { libraryQueryId: lib.id, draftRevision: revision })
  const app = await trpcMutate<{ slug: string }>(page, 'apps.create', {
    slug: `uses-lib-${stamp}`,
    name: 'Uses lib',
  })

  await page.goto(`/apps/${app.slug}/edit`)
  await page.getByTitle('Add a query from the library').click()
  await page.getByTestId('library-picker').getByText(`Double ${stamp}`).click()
  const body = page.getByTestId('library-query-query1')
  await expect(body).toContainText('A number')
  await typeInto(page, body.locator('[data-testid$="/queries/0/params/n"]'), '{{ 7 }}')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('query-query1')).toContainText('21')

  // Pinned to v1.0.0: the first release runs.
  await page.getByLabel('Version').selectOption('1.0.0')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('query-query1')).toContainText('14')
  await expect(body).toContainText('v1.0.0, on optiply_db')
})

/** In Git (M14 step 7d): a library query protected from its editor, edited and run on a branch, committed. */
test('protect a library query and edit it on a branch', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await signIn(page)
  const repoUrl = process.env.E2E_GIT_REPO_URL!
  const repoDir = process.env.E2E_GIT_REPO_DIR ?? new URL(repoUrl).pathname
  const info = await trpcQuery<{ configured: boolean }>(page, 'git.info', {})
  if (!info.configured) await trpcMutate(page, 'git.saveSettings', { repoUrl, token: E2E_GITHUB_TOKEN })
  const stamp = Date.now()
  const slug = `triple_${stamp}`
  const branch = `m14/triple-${stamp}`
  const lib = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', {
    slug,
    name: `Triple ${stamp}`,
  })
  const { revision } = await trpcMutate<{ revision: number }>(page, 'libraryQueries.saveDraft', {
    id: lib.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      resource: 'shop_db',
      query: { sql: 'select {{ n }}::int * 3 as x' },
      params: [{ name: 'n', testValue: 5 }],
    },
  })
  await trpcMutate(page, 'libraryQueries.publish', { libraryQueryId: lib.id, draftRevision: revision })

  await page.goto(`/library/${slug}`)
  await page.getByRole('button', { name: 'Protect in Git' }).click()
  await page.getByTestId('protect-confirm').click()
  await expect(page.getByTestId('protect-result')).toContainText('The library query is protected')
  await page.getByRole('button', { name: 'Done' }).click()

  // Main is read-only (no Publish); a branch draft is edited and runs.
  await expect(page.getByTestId('read-only-banner')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Branch' }).selectOption({ label: 'New branch…' })
  await page.getByRole('textbox', { name: 'New branch name' }).fill(branch)
  await page.getByRole('button', { name: 'Start branch' }).click()
  await expect(page.getByText('New: the first commit makes it')).toBeVisible()
  await typeInto(page, page.locator('[data-testid^="code-library:"]'), 'select {{ n }}::int * 4 as x')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.getByTestId('library-run').getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('library-run')).toContainText('20')

  // Committed: the repo has its SQL as query.sql.
  await page.getByTestId('commit-open').click()
  await expect(page.getByTestId('commit-files')).toContainText(`library/${slug}/query.sql`)
  await page.getByRole('textbox', { name: 'Message' }).fill('Four times')
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toContainText(branch)
  const sql = execFileSync('git', [
    '--git-dir',
    repoDir,
    'show',
    `refs/heads/${branch}:library/${slug}/query.sql`,
  ])
  expect(sql.toString()).toBe('select {{ n }}::int * 4 as x\n')
})
