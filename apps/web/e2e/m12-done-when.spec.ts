import { expect, type Page, test } from '@playwright/test'
import { addBlock, block, clickEmptyCanvas, editorText, field, signIn, trpcMutate, typeInto } from './helpers'

/**
 * M12's done-when (docs/architecture.md §2.7): a workflow whose Python block uses pandas to aggregate a query's rows
 * returns the result, its print() lines in the run log; renaming the query rewrites the Python; a syntax error shows
 * in the editor before running; Python code can't read the worker's environment, reach the network or write outside
 * /tmp; an infinite loop stops at the block timeout and a 1 GB allocation fails as a memory error, the worker
 * unharmed. (The latency target is measured on Compose: handoff §10.)
 *
 * E2E_PYTHON_RESOURCE names a Postgres resource with the seeded `customers` table (default shop_db; the Compose check
 * uses its own).
 */
test.skip(!process.env.E2E_PYTHON, 'needs the code executor (Docker)')

const RESOURCE = process.env.E2E_PYTHON_RESOURCE ?? 'shop_db'

test("M12's done-when", async ({ page }) => {
  const stamp = Date.now().toString(36)
  const python = () => field(page, 'python1', 'code.py')

  await test.step('pandas aggregates a query in a Python block, its prints in the run log', async () => {
    await signIn(page, process.env.E2E_PYTHON_EMAIL)
    await page.getByRole('button', { name: 'New workflow' }).click()
    await page.getByPlaceholder('Sync orders').fill(`Plans ${stamp}`)
    await page.getByRole('button', { name: 'Create workflow' }).click()
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)

    await block(page, 'startTrigger').click()
    await addBlock(page, 'resource query')
    await page
      .getByTestId('side-panel')
      .getByRole('combobox', { name: /^Resource/ })
      .selectOption(RESOURCE)
    await typeInto(page, field(page, 'query1', 'query.sql'), 'select email, plan from customers order by id')

    await addBlock(page, 'Python code')
    // One line (statements joined by semicolons): the typing helper compares a field's text without line breaks.
    await typeInto(
      page,
      python(),
      'import pandas as pd; df = pd.DataFrame(query1.data); print("rows", len(df)); print("plans", sorted(df.plan.unique())); return {"perPlan": df.groupby("plan").size().to_dict(), "emails": sorted(df.email.str.upper())}',
    )
    await addBlock(page, 'response')
    await typeInto(page, field(page, 'response1', 'body.txt'), '{{ python1.data }}')
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await clickEmptyCanvas(page)
    await expect(page.getByTestId('side-panel')).toContainText('No problems found.')

    const panel = await run(page)
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText('"perPlan"')
    await expect(panel.getByTestId('run-output')).toContainText('"free": 1')
    await expect(panel.getByTestId('run-output')).toContainText('"pro": 1')
    await expect(panel.getByTestId('run-output')).toContainText('ADA@EXAMPLE.COM')
    await panel.getByRole('button', { name: 'logs' }).click()
    await expect(panel.getByTestId('run-logs')).toContainText('rows 2')
    await expect(panel.getByTestId('run-logs')).toContainText("plans ['free', 'pro']")
    await panel.getByRole('button', { name: 'blocks' }).click()
  })

  await test.step('renaming the query rewrites the Python', async () => {
    await block(page, 'query1').click()
    const name = page.getByTestId('block-name')
    await name.fill('customers')
    await name.press('Enter')
    await expect(block(page, 'customers')).toBeVisible()
    // With the run panel open the minimap can sit over python1: fit the canvas first.
    await page.getByRole('button', { name: 'fit view' }).click()
    await block(page, 'python1').click()
    await expect.poll(() => editorText(python())).toContain('df = pd.DataFrame(customers.data)')
    const panel = await run(page)
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText('ADA@EXAMPLE.COM')
    await panel.getByRole('button', { name: 'blocks' }).click()
  })

  await test.step('a syntax error shows in the editor before running', async () => {
    // Balanced brackets: Monaco's Python mode closes an open one itself.
    await typeInto(page, python(), 'return [r["email"] for r in customers.data if]')
    await expect(python().locator('.squiggly-error')).not.toHaveCount(0, { timeout: 10_000 })
  })

  await test.step("Python can't read the worker's environment, reach the network or write outside /tmp", async () => {
    const probe = await runPython(
      page,
      `probe-${stamp}`,
      [
        'import os, socket',
        'net = {}',
        'for host, port in [("1.1.1.1", 443), ("postgres", 5432), ("127.0.0.1", 5432), ("api", 3000)]:',
        '    try:',
        '        socket.create_connection((host, port), timeout=2)',
        '        net[host] = "connected"',
        '    except OSError as e:',
        '        net[host] = type(e).__name__',
        'written = []',
        'for path in ["/opt/py/x", "/usr/x", "/x", "/tmp/x"]:',
        '    try:',
        '        open(path, "w").write("x")',
        '        written.append(path)',
        '    except OSError:',
        '        pass',
        'return {"env": sorted(os.environ), "net": net, "written": written, "uid": os.getuid()}',
      ].join('\n'),
    )
    expect(probe.run.status).toBe('succeeded')
    const result = probe.data as {
      env: string[]
      net: Record<string, string>
      written: string[]
      uid: number
    }
    expect(result.env).toEqual([
      'HOME',
      'LANG',
      'PYTHONDONTWRITEBYTECODE',
      'PYTHONHASHSEED',
      'PYTHONUNBUFFERED',
      'TZ',
    ])
    expect(Object.values(result.net)).not.toContain('connected')
    expect(result.written).toEqual(['/tmp/x'])
    expect(result.uid).toBe(65534)
  })

  await test.step('an infinite loop stops at the timeout, 1 GB is a memory error, and the next run is fine', async () => {
    const started = Date.now()
    const spin = await runPython(page, `spin-${stamp}`, 'while True:\n    pass', { timeoutMs: 2000 })
    expect(spin.run.status).toBe('failed')
    expect(spin.run.error).toMatchObject({ block: 'python1', code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(15_000)

    const hog = await runPython(
      page,
      `hog-${stamp}`,
      'block = bytearray(1024 * 1024 * 1024)\nreturn len(block)',
    )
    expect(hog.run.status).toBe('failed')
    expect(hog.run.error).toMatchObject({ block: 'python1', code: 'memory' })

    const after = await runPython(page, `after-${stamp}`, 'return sum(range(10))')
    expect(after.run.status).toBe('succeeded')
    expect(after.data).toBe(45)
  })
})

/** Runs the open workflow and waits for this run (not an earlier one) to succeed; returns the run panel. */
async function run(page: Page) {
  const picker = page.getByLabel('Run', { exact: true })
  const previous = (await picker.count()) ? await picker.inputValue() : ''
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(picker).not.toHaveValue(previous)
  await expect(picker).not.toHaveValue('')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
  return panel
}

/** A workflow with one Python block, made and run (draft) through the API; its run and the block's data. */
async function runPython(page: Page, slug: string, code: string, settings?: object) {
  const workflow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: workflow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        {
          name: 'python1',
          type: 'code',
          config: { code, language: 'python' },
          ...(settings && { settings }),
        },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'python1' }],
    },
  })
  const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, { data: {} })
  expect(started.status()).toBe(202)
  const id = (await started.json()).run.id as string
  let run: { status: string; error: unknown } = { status: 'queued', error: null }
  await expect
    .poll(
      async () => {
        run = (await (await page.request.get(`/api/v1/runs/${id}`)).json()).run
        return run.status
      },
      { timeout: 30_000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/)
  const blockRes = await page.request.get(`/api/v1/runs/${id}/blocks/python1`)
  const data = blockRes.ok() ? (await blockRes.json()).block.data : undefined
  return { run, data }
}
