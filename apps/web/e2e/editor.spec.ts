import { expect, type Page, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, drag, editorText, field, signIn, typeInto } from './helpers'

/**
 * M3's done-when: build "query → branch → code → response" in the editor, run it, rename a block, and see its
 * references update (and the workflow still run).
 */
test('build, run and refactor a workflow in the editor', async ({ page }) => {
  await test.step('sign in and create a workflow', async () => {
    await signIn(page)

    // Retries and repeats share the database, so each attempt needs its own slug.
    const suffix = Date.now().toString(36)
    await page.getByRole('button', { name: 'New workflow' }).click()
    await page.getByPlaceholder('Sync orders').fill(`Pro customers ${suffix}`)
    await expect(page.getByPlaceholder('sync-orders')).toHaveValue(`pro-customers-${suffix}`)
    await page.getByRole('button', { name: 'Create workflow' }).click()
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
    await expect(block(page, 'startTrigger')).toBeVisible()
  })

  await test.step('build query → branch → code → response', async () => {
    await block(page, 'startTrigger').click()
    await typeInto(page, field(page, 'startTrigger', 'testInput.json'), '{"id": 1}')

    // Added blocks follow the selected one.
    await addBlock(page, 'resource query')
    await expect(block(page, 'query1')).toBeVisible()
    await typeInto(
      page,
      field(page, 'query1', 'query.sql'),
      'select email, plan from customers where id = {{ startTrigger.data.id }}',
    )

    await addBlock(page, 'branch')
    await expect(block(page, 'branch1')).toBeVisible()
    await typeInto(page, field(page, 'branch1', 'condition-c1.js'), "query1.data[0].plan === 'pro'")

    // Blocks added after a branch aren't connected automatically: connect the condition's output by dragging.
    await addBlock(page, 'code')
    await expect(block(page, 'code1')).toBeVisible()
    await typeInto(page, field(page, 'code1', 'code.js'), 'return query1.data[0].email.toUpperCase()')
    await drag(
      page,
      block(page, 'branch1').locator('[data-handleid="cond:c1"]'),
      block(page, 'code1').locator('.react-flow__handle.target'),
    )
    await expect(page.locator('.react-flow__edge')).toHaveCount(3)

    await block(page, 'code1').click()
    await addBlock(page, 'response')
    await expect(block(page, 'response1')).toBeVisible()
    await typeInto(page, field(page, 'response1', 'body.txt'), '{"email": {{ code1.data }}}')
    await expect(page.locator('.react-flow__edge')).toHaveCount(4)

    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await clickEmptyCanvas(page)
    await expect(page.getByTestId('side-panel')).toContainText('No problems found.')
  })

  await test.step('run it', async () => {
    await runAndExpectEmail(page)
    for (const name of ['startTrigger', 'query1', 'branch1', 'code1', 'response1']) {
      await expect(block(page, name)).toHaveAttribute('data-status', 'succeeded')
    }
  })

  await test.step('rename query1 → customer: every reference follows', async () => {
    await block(page, 'query1').click()
    const name = page.getByTestId('block-name')
    await name.fill('customer')
    await name.press('Enter')
    await expect(block(page, 'customer')).toBeVisible()
    await expect(block(page, 'query1')).toHaveCount(0)

    await block(page, 'branch1').click()
    await expect
      .poll(() => editorText(field(page, 'branch1', 'condition-c1.js')))
      .toBe("customer.data[0].plan === 'pro'")
    await block(page, 'code1').click()
    await expect
      .poll(() => editorText(field(page, 'code1', 'code.js')))
      .toBe('return customer.data[0].email.toUpperCase()')
    await clickEmptyCanvas(page)
    await expect(page.getByTestId('side-panel')).toContainText('No problems found.')
  })

  await test.step('the renamed workflow still runs', async () => {
    await runAndExpectEmail(page)
    await expect(block(page, 'customer')).toHaveAttribute('data-status', 'succeeded')
  })
})

/** Runs the workflow and waits for this run (not an earlier one still on screen) to reply with Ada's email. */
async function runAndExpectEmail(page: Page) {
  const picker = page.getByLabel('Run', { exact: true })
  const previous = (await picker.count()) ? await picker.inputValue() : ''
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(picker).not.toHaveValue(previous)
  await expect(picker).not.toHaveValue('')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
  await panel.getByRole('button', { name: 'output' }).click()
  await expect(panel.getByTestId('run-output')).toContainText('ADA@EXAMPLE.COM')
  await panel.getByRole('button', { name: 'blocks' }).click()
}
