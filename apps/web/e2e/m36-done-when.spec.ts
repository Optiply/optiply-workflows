import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { appExport, plugin, workflowExport } from '../../../packages/retool-import/test/fixtures'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M36 done-when: Retool exports imported through the screen. A workflow (its Retool resource mapped to one of ours)
 * runs in the editor; an app reading the same Retool resource (remembered) and running that Retool workflow (mapped)
 * works in its editor; importing the app again saves a new draft of the same app. Synthetic exports, written as
 * Retool writes them.
 */

const RETOOL_DB = 'Retool DB'
const RETOOL_WORKFLOW = 'retool-wf-1'

function files(stamp: string) {
  const dir = join(tmpdir(), `m36-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const workflow = workflowExport(
    [
      {
        uuid: 'b0',
        pluginId: 'startTrigger',
        blockType: 'webhook',
        top: 0,
        left: 0,
        options: {},
        incomingOnSuccessEdges: [],
      },
      {
        uuid: 'b1',
        pluginId: 'getDouble',
        blockType: 'default',
        editorType: 'SqlQueryUnified',
        resourceName: RETOOL_DB,
        top: 0,
        left: 400,
        incomingOnSuccessEdges: ['b0'],
      },
      {
        uuid: 'b2',
        pluginId: 'reply',
        blockType: 'webhookReturn',
        editorType: 'JavascriptQuery',
        top: 0,
        left: 800,
        options: { body: 'getDouble.data[0]', status: '200' },
        incomingOnSuccessEdges: ['b1'],
      },
    ],
    [
      plugin('getDouble', {
        type: 'datasource',
        subtype: 'SqlQueryUnified',
        resourceName: RETOOL_DB,
        template: { query: 'select {{ (startTrigger.data || {}).n || 21 }}::int * 2 as doubled' },
      }),
    ],
    { name: `Doubler ${stamp}` },
  )
  const app = appExport([
    plugin('total', {
      subtype: 'TextWidget2',
      template: { value: 'Total: {{ getTotal.data.doubled[0] }}' },
      position: { container: '', row: 0, col: 0, width: 6, height: 1 },
    }),
    plugin('go', {
      subtype: 'ButtonWidget2',
      template: {
        text: 'Run flow',
        events: [{ event: 'click', type: 'datasource', method: 'trigger', pluginId: 'runFlow' }],
      },
      position: { container: '', row: 1, col: 0, width: 2, height: 1 },
    }),
    plugin('flowResult', {
      subtype: 'TextWidget2',
      template: { value: 'Flow: {{ runFlow.data?.doubled }}' },
      position: { container: '', row: 2, col: 0, width: 6, height: 1 },
    }),
    plugin('getTotal', {
      type: 'datasource',
      subtype: 'SqlQueryUnified',
      resourceName: RETOOL_DB,
      template: { query: 'select 21 * 2 as doubled', runWhenPageLoads: true },
    }),
    plugin('runFlow', {
      type: 'datasource',
      subtype: 'WorkflowRun',
      resourceName: 'WorkflowRun',
      template: { workflowId: RETOOL_WORKFLOW, workflowParams: '{"n": 5}', workflowRunExecutionType: 'sync' },
    }),
  ])
  ;(app as { uuid: string }).uuid = `00000000-0000-4000-8000-${stamp.padStart(12, '0').slice(-12)}`
  const workflowPath = join(dir, 'Doubler.json')
  const appPath = join(dir, `Order%20Desk%20${stamp}.json`)
  writeFileSync(workflowPath, JSON.stringify(workflow))
  writeFileSync(appPath, JSON.stringify(app))
  return { workflowPath, appPath }
}

async function openImport(page: Page, list: '/workflows' | '/apps', path: string) {
  await page.goto(list)
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await page.getByLabel('Retool exports').setInputFiles(path)
  await expect(page.getByTestId('retool-file').first()).toContainText('converted')
}

test('M36 done-when: import a Retool workflow and app, map, run, re-import', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const { workflowPath, appPath } = files(stamp)

  // The workflow: its Retool resource mapped to ours, then it runs in the editor.
  await openImport(page, '/workflows', workflowPath)
  await expect(page.getByTestId('retool-file')).toContainText('New')
  await page.getByLabel(`Resource for ${RETOOL_DB}`).selectOption('optiply_db')
  await page
    .getByRole('button', { name: /^Import/ })
    .last()
    .click()
  const imported = page.getByTestId('retool-imported')
  await expect(imported).toContainText(`Doubler ${stamp}`)
  await imported.getByRole('link').click()
  await page.waitForURL(/\/workflows\/[0-9a-f-]+/)
  const workflowId = page.url().split('/workflows/')[1]!.split(/[/?#]/)[0]!
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 60_000 })
  await panel.getByRole('button', { name: 'output' }).click()
  await expect(panel.getByTestId('run-output')).toContainText('42')
  await expect(
    page.getByTestId('status-bar').getByRole('button', { name: 'Imported from Retool' }),
  ).toBeVisible()
  const draft = await trpcQuery<{ draftRevision: number; slug: string }>(page, 'workflows.get', {
    id: workflowId,
  })
  await trpcMutate(page, 'releases.publish', { workflowId, draftRevision: draft.draftRevision })

  // The app: the Retool resource remembered, the Retool workflow mapped to the one just imported.
  await openImport(page, '/apps', appPath)
  await expect(page.getByLabel(`Resource for ${RETOOL_DB}`)).toHaveValue('optiply_db')
  await page.getByLabel(`Workflow for ${RETOOL_WORKFLOW}`).selectOption(draft.slug)
  await page
    .getByRole('button', { name: /^Import/ })
    .last()
    .click()
  await expect(imported).toContainText(`Order Desk ${stamp}`)
  await imported.getByRole('link').click()
  await page.waitForURL(/\/apps\/.+\/edit/)
  const appSlug = page.url().split('/apps/')[1]!.split('/')[0]!
  // Retool's SQL data is by column (`getTotal.data.doubled[0]`): it reads ours, by row.
  await expect(page.locator('[data-component="total"]')).toContainText('Total: 42', { timeout: 30_000 })
  await page.locator('[data-component="go"]').getByRole('button', { name: 'Run flow' }).click()
  await expect(page.locator('[data-component="flowResult"]')).toContainText('Flow: 10', { timeout: 60_000 })

  // Importing it again: a new draft of the same app.
  const before = await trpcQuery<{ id: string; draftRevision: number }>(page, 'apps.get', { slug: appSlug })
  await openImport(page, '/apps', appPath)
  await expect(page.getByTestId('retool-file')).toContainText(`Updates Order Desk ${stamp}`)
  await page
    .getByRole('button', { name: /^Import/ })
    .last()
    .click()
  await expect(imported).toContainText('New draft')
  const after = await trpcQuery<{ id: string; draftRevision: number }>(page, 'apps.get', { slug: appSlug })
  expect(after.id).toBe(before.id)
  expect(after.draftRevision).toBeGreaterThan(before.draftRevision)
})
