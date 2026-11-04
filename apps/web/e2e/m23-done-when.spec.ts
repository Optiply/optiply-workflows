import { expect, type Page, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, field, signIn, typeInto } from './helpers'

/**
 * M23's done-when (docs/architecture.md §2.7, §2.26): two Python executions in a row share nothing (the warm pool's
 * jails are single-use); a block printing a line a second shows its lines in the run view while it runs; a workflow
 * declaring a package the image lacks imports it in a draft run and, published, in a live run, while another workflow
 * gets ModuleNotFoundError. Against the local package index the e2e setup serves (`owtest-a`, which needs
 * `owtest-b`). The latency target (pandas from the warm pool under 60 ms p50) is measured by the executor's tests and
 * on Compose (handoff §10).
 */
test.skip(!process.env.E2E_PYTHON_PACKAGES, 'needs the code executor and the package builder (Docker)')

test("M23's done-when", async ({ page }) => {
  test.setTimeout(180_000)
  const stamp = Date.now().toString(36)
  await signIn(page)

  await test.step('two executions in a row share nothing', async () => {
    await newWorkflow(page, `Fresh ${stamp}`)
    await addBlock(page, 'Python code')
    await typeInto(
      page,
      field(page, 'python1', 'code.py'),
      'import json, os; json.marker = 1; open("/tmp/left", "w").write("x"); os.environ["LEFT"] = "1"; return 1',
    )
    await addBlock(page, 'Python code')
    await typeInto(
      page,
      field(page, 'python2', 'code.py'),
      'import json, os, sys; return {"module": hasattr(json, "marker"), "file": os.path.exists("/tmp/left"), "env": "LEFT" in os.environ, "pandas": "pandas" in sys.modules}',
    )
    await addBlock(page, 'response')
    await typeInto(page, field(page, 'response1', 'body.txt'), '{{ python2.data }}')
    await saved(page)
    const panel = await run(page)
    await panel.getByRole('button', { name: 'output' }).click()
    const output = panel.getByTestId('run-output')
    await expect(output).toContainText('"module": false')
    await expect(output).toContainText('"file": false')
    await expect(output).toContainText('"env": false')
    // A warm jail: pandas already imported while it waited.
    await expect(output).toContainText('"pandas": true')
  })

  await test.step('a line a second, shown while the block runs', async () => {
    await newWorkflow(page, `Ticks ${stamp}`)
    await addBlock(page, 'Python code')
    await typeInto(
      page,
      field(page, 'python1', 'code.py'),
      'import time; [(print("tick", i), time.sleep(1)) for i in range(4)]; return 4',
    )
    await saved(page)
    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await panel.getByRole('button', { name: 'logs' }).click()
    const logs = panel.getByTestId('run-logs')
    await expect(logs).toContainText('tick 1', { timeout: 3500 })
    await expect(block(page, 'python1')).toHaveAttribute('data-status', 'running')
    await expect(logs).not.toContainText('tick 3')
    await expect(logs).toContainText('tick 3', { timeout: 10_000 })
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
  })

  const code = 'import owtest_a; return {"name": owtest_a.NAME, "b": owtest_a.B}'
  let slug = ''

  await test.step("a workflow's own package, in a draft run", async () => {
    slug = await newWorkflow(page, `Packaged ${stamp}`)
    await clickEmptyCanvas(page)
    const side = page.getByTestId('side-panel')
    await side.getByRole('button', { name: 'Settings', exact: true }).click()
    await side.getByLabel('Python packages').fill('owtest-a')
    await block(page, 'startTrigger').click()
    await addBlock(page, 'Python code')
    await typeInto(page, field(page, 'python1', 'code.py'), code)
    await addBlock(page, 'response')
    await typeInto(page, field(page, 'response1', 'body.txt'), '{{ python1.data }}')
    await saved(page)
    const panel = await run(page, 60_000) // the first run may install the packages
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText('"name": "owtest-a"')
    await expect(panel.getByTestId('run-output')).toContainText('"b": "1.0.0"')
  })

  await test.step('published, in a live run', async () => {
    await page.locator('header').getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByTestId('publish-confirm').click()
    await expect(page.getByTestId('publish-confirm')).toHaveCount(0, { timeout: 60_000 })
    const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, { data: { version: 'live' } })
    expect(started.status()).toBe(202)
    const { run: live } = (await started.json()) as { run: { id: string } }
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/v1/runs/${live.id}`)
          const body = (await res.json()) as { run: { status: string; response?: { body: unknown } } }
          return body.run.status === 'succeeded' ? body.run.response?.body : body.run.status
        },
        { timeout: 60_000 },
      )
      .toEqual({ name: 'owtest-a', b: '1.0.0' })
  })

  await test.step("another workflow doesn't have it", async () => {
    await newWorkflow(page, `Plain ${stamp}`)
    await addBlock(page, 'Python code')
    await typeInto(page, field(page, 'python1', 'code.py'), code)
    await saved(page)
    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('failed', { timeout: 30_000 })
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText(
      "ModuleNotFoundError: No module named 'owtest_a'",
    )
  })
})

/** A new workflow, its start block selected; its slug. */
async function newWorkflow(page: Page, name: string): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(name)
  const slug = await page.getByPlaceholder('sync-orders').inputValue()
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  await block(page, 'startTrigger').click()
  return slug
}

async function saved(page: Page) {
  await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
}

/** Runs the draft from the editor and waits for this run (not an earlier one) to succeed. */
async function run(page: Page, timeout = 30_000) {
  const picker = page.getByLabel('Run', { exact: true })
  const previous = (await picker.count()) ? await picker.inputValue() : ''
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(picker).not.toHaveValue(previous)
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout })
  return panel
}
