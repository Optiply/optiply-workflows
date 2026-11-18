import { expect, type Page, test } from '@playwright/test'
import {
  addBlock,
  block,
  clickEmptyCanvas,
  field,
  openRail,
  signIn,
  trpcMutate,
  trpcQuery,
  typeInto,
} from './helpers'

/**
 * M32's done-when (docs/architecture.md §2.35): an admin adds a private package index whose password is a secret
 * config var, and tests it; a workflow picks it and requires a package only that index has and one with only an
 * sdist (built offline in the builder's jail); a draft run imports both, and the next one runs warm (the env's
 * packages already imported while its jail waited); published, live runs import them, warm too; a workflow without
 * the index can't import the private package. Against the e2e setup's private index (`owtest-private`, needing the
 * default index's `owtest-b`, and `owtest-psrc`, an sdist).
 */
test.skip(
  !process.env.E2E_PRIVATE_INDEX_URL,
  'needs the code executor, the package builder and the private index',
)

const CODE = [
  'import sys',
  'warm = "owtest_private" in sys.modules',
  'import owtest_private, owtest_psrc',
  'return {"sauce": owtest_private.SAUCE, "p": owtest_psrc.P, "warm": warm}',
].join('; ')

test("M32's done-when", async ({ page }) => {
  test.setTimeout(300_000)
  const stamp = Date.now().toString(36)
  const secretName = `PYPI_PASSWORD_${stamp.toUpperCase()}`
  const indexName = `Private ${stamp}`
  await signIn(page)

  await test.step('an admin adds a private index, its password a secret config var, and tests it', async () => {
    const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
    const secret = await trpcMutate<{ id: string }>(page, 'configVars.create', {
      name: secretName,
      isSecret: true,
    })
    await trpcMutate(page, 'configVars.setValue', {
      configVarId: secret.id,
      environmentId: envs.find((e) => e.isDefault)!.id,
      value: process.env.E2E_PRIVATE_INDEX_PASSWORD,
    })

    await page.goto('/settings/python')
    await page.getByRole('button', { name: 'New index' }).click()
    await page.getByPlaceholder('Private PyPI').fill(indexName)
    await page.getByPlaceholder('https://pypi.example.com/simple').fill(process.env.E2E_PRIVATE_INDEX_URL!)
    await page.getByLabel('Username').fill('ci')
    // Without the password first: the index wants it.
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    await expect(page.getByTestId('python-index-test')).toContainText('refused the sign-in')
    await page.getByLabel('Password config var').selectOption(secretName)
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    await expect(page.getByTestId('python-index-test')).toHaveText('The index answered and took the sign-in.')
    // A package to test with (for indexes that list nothing at their root, as Artifact Registry): its page; saved.
    await page.getByLabel('Package to test with').fill('owtest-private')
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    await expect(page.getByTestId('python-index-test')).toHaveText(
      'The index answered, took the sign-in and has owtest-private.',
    )
    await page.getByRole('button', { name: 'Add index' }).click()
    const row = page.getByTestId(`python-index-private-${stamp}`)
    await expect(row).toContainText(indexName)
    await expect(row).toContainText(secretName)
    // The package to test with is saved with the index: editing it again, it's there, and Test uses it.
    await row.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByLabel('Package to test with')).toHaveValue('owtest-private')
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    await expect(page.getByTestId('python-index-test')).toHaveText(
      'The index answered, took the sign-in and has owtest-private.',
    )
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  let slug = ''
  await test.step('a workflow picks it; its packages install, one built from source; a draft run imports them', async () => {
    slug = await newWorkflow(page, `Private packages ${stamp}`)
    await clickEmptyCanvas(page)
    const side = await openRail(page, 'settings')
    await side.getByLabel('Python packages').fill('owtest-private\nowtest-psrc')
    await side.getByLabel('Package index').selectOption({ label: `${indexName} (with the default)` })
    const state = side.getByTestId('packages-state')
    await state.getByRole('button', { name: 'Install now' }).click()
    await expect(state).toContainText('owtest-private==1.0.0 (private-', { timeout: 120_000 })
    await expect(state).toContainText('owtest-psrc==2.0.0 (private-')
    await expect(state).toContainText('built from source')
    await block(page, 'startTrigger').click()
    await addBlock(page, 'Python code')
    await typeInto(page, field(page, 'python1', 'code.py'), CODE)
    await addBlock(page, 'response')
    await typeInto(page, field(page, 'response1', 'body.txt'), '{{ python1.data }}')
    await saved(page)
    const panel = await run(page, 60_000)
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText('"sauce": 42')
    await expect(panel.getByTestId('run-output')).toContainText('"p": 2')
  })

  await test.step('the next draft run is warm', async () => {
    // The env's warm jail starts after its first run: a run or two may still come before it's ready.
    await expect
      .poll(
        async () => {
          const panel = await run(page, 60_000)
          await panel.getByRole('button', { name: 'output' }).click()
          return panel.getByTestId('run-output').textContent()
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toContain('"warm": true')
  })

  await test.step('published, live runs import them, warm', async () => {
    await page.locator('header').getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByTestId('publish-confirm').click()
    await expect(page.getByTestId('publish-confirm')).toHaveCount(0, { timeout: 120_000 })
    await expect
      .poll(async () => liveRun(page, slug), { timeout: 90_000, intervals: [1000] })
      .toEqual({ sauce: 42, p: 2, warm: true })
  })

  await test.step("a workflow without the index can't import the private package", async () => {
    await newWorkflow(page, `No index ${stamp}`)
    await addBlock(page, 'Python code')
    await typeInto(page, field(page, 'python1', 'code.py'), 'import owtest_private; return 1')
    await saved(page)
    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('failed', { timeout: 30_000 })
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText(
      "ModuleNotFoundError: No module named 'owtest_private'",
    )
  })
})

/** A live run's response body, once it has succeeded. */
async function liveRun(page: Page, slug: string): Promise<unknown> {
  const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, { data: { version: 'live' } })
  expect(started.status()).toBe(202)
  const { run } = (await started.json()) as { run: { id: string } }
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    const res = await page.request.get(`/api/v1/runs/${run.id}`)
    const body = (await res.json()) as { run: { status: string; response?: { body: unknown } } }
    if (body.run.status === 'succeeded') return body.run.response?.body
    if (body.run.status === 'failed') return body.run
    await new Promise((r) => setTimeout(r, 250))
  }
  return 'still running'
}

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
  const picker = page.getByTestId('run-panel')
  const previous = (await picker.count()) ? await picker.getAttribute('data-run-id') : ''
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(picker).not.toHaveAttribute('data-run-id', previous ?? '')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout })
  return panel
}
