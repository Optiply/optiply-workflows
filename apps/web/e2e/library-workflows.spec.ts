import { expect, test } from '@playwright/test'
import { E2E_EMAIL } from './global-setup'
import { addBlock, block, clickEmptyCanvas, field, signIn, trpcMutate, typeInto } from './helpers'

/**
 * Library queries in the workflow editor (M21 step 3): a Library query block and a loop whose runner is a library
 * query, picked and filled in the inspector, run with their parameters and the person running as `current_user`;
 * the library query lists the workflow as using it.
 */
test('use a library query in a block and a loop', async ({ page }) => {
  await signIn(page)
  const suffix = Date.now().toString(36)
  const slug = `times_ten_${suffix}`

  const created = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', {
    slug,
    name: `Times ten ${suffix}`,
  })
  const saved = await trpcMutate<{ revision: number }>(page, 'libraryQueries.saveDraft', {
    id: created.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      resource: 'optiply_db',
      query: {
        sql: 'select {{ n }}::int * 10 as x, {{ current_user ? current_user.email : null }}::text as who',
      },
      params: [{ name: 'n', description: 'The number to multiply' }],
    },
  })
  await trpcMutate(page, 'libraryQueries.publish', {
    libraryQueryId: created.id,
    draftRevision: saved.revision,
  })

  await test.step('a Library query block, picked and given its parameter', async () => {
    await page.getByRole('button', { name: 'New workflow' }).click()
    await page.getByPlaceholder('Sync orders').fill(`Tens ${suffix}`)
    await page.getByRole('button', { name: 'Create workflow' }).click()
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
    await block(page, 'startTrigger').click()
    await typeInto(page, field(page, 'startTrigger', 'testInput.json'), '{"n": 4}')

    await addBlock(page, 'library query')
    await expect(block(page, 'library1')).toBeVisible()
    await expect(block(page, 'library1')).toContainText('No library query chosen')
    await page.getByTestId('library-call').getByLabel('Library query').selectOption(slug)
    await expect(block(page, 'library1')).toContainText(`${slug}@latest`)
    await expect(page.getByTestId('library-call').getByLabel('Version')).toHaveValue('latest')
    await page.getByTestId('library-call-query').locator('summary').click()
    await expect(page.getByTestId('library-call-query')).toContainText('select {{ n }}::int * 10')
    await expect(page.getByTestId('library-call')).toContainText('The number to multiply')
    await typeInto(page, field(page, 'library1', 'config.params.n.txt'), '{{ startTrigger.data.n }}')
    // Pinning the version works too.
    await page.getByTestId('library-call').getByLabel('Version').selectOption('1.0.0')
    await expect(block(page, 'library1')).toContainText(`${slug}@1.0.0`)
  })

  await test.step('a loop whose runner is the library query', async () => {
    await addBlock(page, 'loop')
    await expect(block(page, 'loop1')).toBeVisible()
    await typeInto(page, field(page, 'loop1', 'input.txt'), '{{ [1, 2] }}')
    await page.getByLabel('For each item, run').selectOption('library')
    await page.getByTestId('library-call').getByLabel('Library query').selectOption(slug)
    await typeInto(
      page,
      field(page, 'loop1', 'config.runner.params.n.txt'),
      '{{ value + library1.data[0].x }}',
    )

    await addBlock(page, 'response')
    await typeInto(
      page,
      field(page, 'response1', 'body.txt'),
      '{"one": {{ library1.data }}, "many": {{ loop1.data }}}',
    )
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await clickEmptyCanvas(page)
    await expect(page.getByTestId('side-panel')).toContainText('No problems found.')
  })

  await test.step('it runs with the parameters and the person running it as current_user', async () => {
    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
    await panel.getByRole('button', { name: 'output' }).click()
    const output = panel.getByTestId('run-output')
    await expect(output).toContainText('40')
    await expect(output).toContainText('410')
    await expect(output).toContainText('420')
    await expect(output).toContainText(E2E_EMAIL)
  })

  await test.step('the library query lists the workflow as using it', async () => {
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await page.goto(`/library/${slug}`)
    await expect(page.getByTestId('library-used-by')).toContainText(`Tens ${suffix}`)
    await expect(page.getByTestId('library-used-by')).toContainText('workflow · draft')
  })
})
