import { expect, type Page, test } from '@playwright/test'
import { block, clickEmptyCanvas, openRail, signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * JavaScript packages, done when (session 46): a public package (`tiny-format`, the e2e's default registry) and a
 * private one (`@acme/greeting`, behind a token, from the @acme registry in Settings → npm registries) imported by
 * a workflow's code block (draft run, published, a live run) and by an app's JS query (the published app).
 */
test.skip(!process.env.E2E_NPM_PRIVATE_URL, 'needs the e2e setup’s private npm registry')

const PACKAGES = ['@acme/greeting', 'tiny-format']
const CODE = "import greet from '@acme/greeting'\nimport fmt from 'tiny-format'\n\nreturn greet(fmt(7))"
const EXPECTED = 'Hello from @acme, #007'

test('JavaScript packages, public and private, in a workflow and an app', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)

  await test.step('the @acme registry, with its token', async () => {
    const name = `ACME_JS_${stamp.toUpperCase()}`
    const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
    const secret = await trpcMutate<{ id: string }>(page, 'configVars.create', { name, isSecret: true })
    await trpcMutate(page, 'configVars.setValue', {
      configVarId: secret.id,
      environmentId: envs.find((e) => e.isDefault)!.id,
      value: process.env.E2E_NPM_PRIVATE_TOKEN,
    })
    const fields = { scope: '@acme', url: process.env.E2E_NPM_PRIVATE_URL!, tokenConfigVar: name }
    const registries = await trpcQuery<{ id: string; scope: string | null }[]>(
      page,
      'npmRegistries.list',
      undefined,
    )
    const acme = registries.find((r) => r.scope === '@acme')
    if (acme) await trpcMutate(page, 'npmRegistries.update', { ...fields, id: acme.id })
    else await trpcMutate(page, 'npmRegistries.create', fields)
  })

  const slug = `js-done-${stamp}`
  await test.step('a workflow: the packages in Settings, Install now, a draft run', async () => {
    const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
      slug,
      name: `JS done ${stamp}`,
    })
    await trpcMutate(page, 'workflows.saveDraft', {
      id: flow.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'hello', type: 'code', config: { code: CODE }, settings: { timeoutMs: 60_000 } },
          { name: 'reply', type: 'response', config: { body: '{{ hello.data }}' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'hello' },
          { from: 'hello', port: 'out', to: 'reply' },
        ],
      },
    })
    await page.goto(`/workflows/${flow.id}`)
    await expect(block(page, 'hello')).toBeVisible()
    await clickEmptyCanvas(page)
    const panel = await openRail(page, 'settings')
    await panel.getByLabel('JavaScript packages').fill(PACKAGES.join('\n'))
    const state = panel.getByTestId('js-packages-state')
    await expect(state).toContainText(/Not installed yet|Installed/, { timeout: 15_000 })
    if (await state.getByRole('button', { name: 'Install now' }).isVisible()) {
      await state.getByRole('button', { name: 'Install now' }).click()
    }
    await expect(state).toContainText('Installed: @acme/greeting@1.0.0, tiny-format@1.0.0', {
      timeout: 60_000,
    })
    await page.getByTestId('save-status').filter({ hasText: 'Saved' }).waitFor()
    await runInEditor(page, EXPECTED)
  })

  await test.step('published: a live run uses the release’s bundle', async () => {
    const wf = await trpcQuery<{ id: string; draftRevision: number }>(page, 'workflows.get', {
      id: await idOf(page, slug),
    })
    await trpcMutate(page, 'releases.publish', { workflowId: wf.id, draftRevision: wf.draftRevision })
    const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, {
      data: { input: {}, version: 'live' },
    })
    expect(started.status()).toBe(202)
    const { run } = (await started.json()) as { run: { id: string } }
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/v1/runs/${run.id}`)
          const body = (await res.json()) as { run: { status: string; response?: { body?: unknown } } }
          return body.run.status === 'succeeded' ? body.run.response?.body : body.run.status
        },
        { timeout: 60_000 },
      )
      .toBe(EXPECTED)
  })

  await test.step('an app: its JS query imports both, where the published app is used', async () => {
    const appSlug = `js-done-app-${stamp}`
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug: appSlug, name: 'Greeting' })
    await trpcMutate(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [{ name: 'shown', type: 'text', props: { value: '{{ hello.data }}' } }],
        queries: [{ name: 'hello', kind: 'js', runOnLoad: true, code: CODE }],
        layout: { shown: { x: 0, y: 0, w: 6, h: 4 } },
        javascript: { packages: PACKAGES },
      },
    })
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
    await page.goto(`/apps/${appSlug}`)
    await expect(page.locator('[data-component="shown"]')).toContainText(EXPECTED, { timeout: 60_000 })
  })
})

async function idOf(page: Page, slug: string): Promise<string> {
  const list = await trpcQuery<{ id: string; slug: string }[]>(page, 'workflows.list', undefined)
  return list.find((w) => w.slug === slug)!.id
}

/** Runs the workflow from the editor and waits for this run's output. */
async function runInEditor(page: Page, text: string) {
  await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 60_000 })
  await panel.getByRole('button', { name: 'output' }).click()
  await expect(panel.getByTestId('run-output')).toContainText(text)
}
