import { expect, test } from '@playwright/test'
import { E2E_EMAIL } from './global-setup'
import { block, signIn, trpcMutate } from './helpers'

/**
 * M6 end to end: a workflow that waits for a person. Change the User Task in the editor, run it, follow the run
 * panel to the task, see it in the Inbox, answer it (a required field is checked first), and watch the run carry on
 * with the answer.
 */
test('a User Task in the inbox resumes its run', async ({ page }) => {
  const suffix = Date.now().toString(36)
  let workflowId = ''
  let runLink = ''

  await test.step('a workflow with a User Task, edited in the editor', async () => {
    await signIn(page)
    workflowId = (
      await trpcMutate<{ id: string }>(page, 'workflows.create', {
        slug: `refund-${suffix}`,
        name: `Refund ${suffix}`,
      })
    ).id
    await trpcMutate(page, 'workflows.saveDraft', {
      id: workflowId,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          {
            name: 'startTrigger',
            type: 'startTrigger',
            config: { testInput: { customer: 'Acme', amount: 120 } },
          },
          {
            name: 'approval',
            type: 'userTask',
            config: {
              title: 'Refund {{ startTrigger.data.amount }} to {{ startTrigger.data.customer }}?',
              assignees: { users: [E2E_EMAIL] },
              fields: [
                { name: 'reason', label: 'Reason', type: 'text', required: true },
                {
                  name: 'amount',
                  label: 'Amount',
                  type: 'number',
                  default: '{{ startTrigger.data.amount }}',
                },
              ],
              outcomes: [
                { id: 'approve', label: 'Approve' },
                { id: 'reject', label: 'Reject' },
              ],
            },
          },
          {
            name: 'decided',
            type: 'code',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the block's JavaScript, run in the sandbox
            config: { code: 'return `${approval.data.outcome}: ${approval.data.values.reason}`' },
          },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'approval' },
          { from: 'approval', port: 'out', to: 'decided' },
        ],
      },
    })
    await page.goto(`/workflows/${workflowId}`)
    await block(page, 'approval').click()
    await expect(page.getByText('Assigned to')).toBeVisible()
    // Rename the first field's label in the form; it autosaves.
    const label = page.getByTestId('task-field-0').getByRole('textbox', { name: 'Field label' })
    await label.fill('Why')
    await expect(page.getByText('Saved')).toBeVisible()
  })

  await test.step('run: the run waits for the task, and the run panel links to it', async () => {
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('waiting', { timeout: 30_000 })
    await expect(block(page, 'approval')).toHaveAttribute('data-status', 'waiting')
    await page
      .getByTestId('run-blocks')
      .getByRole('button', { name: /approval/ })
      .click()
    await expect(page.getByText('Waiting for someone to complete its task.')).toBeVisible()
    await page.getByRole('link', { name: 'Open the task' }).click()
  })

  await test.step('answer it from the inbox', async () => {
    await expect(page.getByTestId('task-title')).toHaveText('Refund 120 to Acme?')
    // It's in the inbox, and counted once the page loads afresh.
    await page.goto('/inbox')
    await expect(page.getByTestId('inbox-count')).toHaveText('1')
    await page.getByRole('link', { name: 'Refund 120 to Acme?' }).click()
    // The renamed label, and the evaluated starting value.
    await expect(page.getByRole('textbox', { name: /Why/ })).toBeVisible()
    await expect(page.getByRole('spinbutton', { name: 'Amount' })).toHaveValue('120')
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByText('Why is required')).toBeVisible()
    await page.getByRole('textbox', { name: /Why/ }).fill('Arrived damaged')
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByTestId('task-outcome')).toHaveText('Approve')
    // The task links to its run in the editor.
    runLink = (await page.getByRole('link', { name: `Refund ${suffix}` }).getAttribute('href'))!
    expect(runLink).toMatch(/\?run=/)
    await page.goto('/inbox')
    await expect(page.getByTestId('inbox-count')).toHaveCount(0)
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('inbox-table')).toContainText('Refund 120 to Acme?')
  })

  await test.step('the run carried on with the answer', async () => {
    await page.goto(runLink)
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 30_000 })
    await page
      .getByTestId('run-blocks')
      .getByRole('button', { name: /decided/ })
      .click()
    await expect(page.getByTestId('block-result').getByTestId('json')).toHaveText(
      '"approve: Arrived damaged"',
    )
  })
})
