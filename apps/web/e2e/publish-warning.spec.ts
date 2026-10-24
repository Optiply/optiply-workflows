import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Publishing a library query that drops a parameter a workflow on `latest` still passes (M21 step 6b): the publish
 * dialog says which, and publishing still goes ahead.
 */
test('the publish dialog warns about a dropped parameter that a workflow passes', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const slug = `dropping_${stamp}`
  const { id } = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', {
    slug,
    name: `Dropping ${stamp}`,
  })
  const { revision } = await trpcMutate<{ revision: number }>(page, 'libraryQueries.saveDraft', {
    id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      resource: 'optiply_db',
      query: { sql: 'select {{ n }}::int as x' },
      params: [{ name: 'n', testValue: 1 }],
    },
  })
  await trpcMutate(page, 'libraryQueries.publish', { libraryQueryId: id, draftRevision: revision })

  const workflowName = `Passing ${stamp}`
  const workflow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `passing-${stamp}`,
    name: workflowName,
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: workflow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        {
          name: 'library1',
          type: 'libraryQuery',
          config: { library: slug, version: 'latest', params: { n: '2' } },
        },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'library1' }],
    },
  })

  await page.goto(`/library/${slug}`)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  // The parameter goes, and the SQL stops reading it.
  await page.getByTestId('library-params').getByTitle('Remove n').click()
  const sql = page.locator('[data-testid^="code-library:"]')
  await sql.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('select 1 as x')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const warning = page.getByTestId('publish-dropped')
  await expect(warning).toContainText('no longer has the parameter “n”')
  await expect(warning).toContainText(`workflow ${workflowName} passes “n”`)
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.1')
})
