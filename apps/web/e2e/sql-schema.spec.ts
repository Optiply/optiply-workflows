import { expect, test } from '@playwright/test'
import { block, editorText, signIn, trpcMutate, trpcQuery, typeInto } from './helpers'

/**
 * SQL schema loading (session 57): a database resource's tables and columns beside the SQL editor, a name clicked
 * going into the SQL, and the editor completing a table's columns. Against the built-in Database.
 */
test('the tables panel and SQL completions, in a workflow block and the playground', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  const table = `stock_${stamp}`
  const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
  await trpcMutate(page, 'database.createTable', {
    environmentId: envs.find((e) => e.isDefault)!.id,
    name: table,
    columns: [
      { name: 'sku', type: 'text', nullable: false },
      { name: 'qty_on_hand', type: 'integer' },
    ],
  })

  await test.step('a workflow block: the panel lists the table; a column clicked goes into the SQL', async () => {
    const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
      slug: `sql-${stamp}`,
      name: 'SQL',
    })
    await trpcMutate(page, 'workflows.saveDraft', {
      id: flow.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          {
            name: 'find',
            type: 'resourceQuery',
            config: { resource: 'optiply_db', query: { sql: 'select ' } },
          },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'find' }],
      },
    })
    await page.goto(`/workflows/${flow.id}`)
    await block(page, 'find').click()
    const panel = page.getByTestId('sql-schema')
    await expect(panel.getByTestId('sql-schema-summary')).toHaveText(/^\d+/)
    await panel.getByTestId('sql-schema-toggle').click()
    await panel.getByLabel('Search tables and columns').fill(table)
    await expect(panel.getByRole('button', { name: table, exact: true })).toBeVisible()
    // A table found by its name stays closed until opened; one found by a column opens.
    await expect(panel.getByText('integer')).toHaveCount(0)
    await panel.getByRole('button', { name: `Show owdb_production.${table}’s columns` }).click()
    await expect(panel.getByText('integer')).toBeVisible()

    const editor = page.locator('[data-testid$="/find/query.sql"]')
    // The block's SQL is "select ": the cursor at its end, then a column clicked.
    await editor.locator('.view-line').first().click()
    await page.keyboard.press('ControlOrMeta+End')
    await panel.getByRole('button', { name: 'qty_on_hand', exact: true }).click()
    await expect.poll(() => editorText(editor)).toBe('select qty_on_hand')

    await test.step('completions: a table’s columns after its alias', async () => {
      await typeInto(page, editor, `select s. from ${table} s`)
      await editor.locator('.view-line').first().click()
      await page.keyboard.press('Home')
      for (let i = 0; i < 'select s.'.length; i++) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Control+Space')
      await expect(page.locator('.suggest-widget').getByText('qty_on_hand')).toBeVisible()
    })
  })

  await test.step('the playground: the same panel, a table name clicked into the SQL', async () => {
    const { resources } = await trpcQuery<{ resources: { id: string; slug: string }[] }>(
      page,
      'resources.list',
      undefined,
    )
    await page.goto(`/resources/${resources.find((r) => r.slug === 'optiply_db')!.id}`)
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    const sql = page.locator('#playground-sql')
    await sql.fill('select * from ')
    const panel = page.getByTestId('sql-schema')
    await panel.getByTestId('sql-schema-toggle').click()
    await panel.getByLabel('Search tables and columns').fill(table)
    await panel.getByRole('button', { name: table, exact: true }).click()
    await expect(sql).toHaveValue(`select * from ${table}`)
  })
})
