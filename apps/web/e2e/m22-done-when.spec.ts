import { type Browser, expect, type Page, test } from '@playwright/test'
import { E2E_PORT } from '../playwright.config'
import { commitDraft, ensureBranch, type Json, mergeOpenPulls, pushFiles } from './git-helpers'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'
import { startInstances } from './instances'

/**
 * M22's done-when (architecture §2.7), on two instances of their own deploying main of one repo: what instance A
 * protects and commits reaches instance B, which keeps its own password and a host override, and runs it; a commit
 * naming a resource B lacks shows B's admins a banner and runs B's notify workflow, then deploys once it exists; a
 * block renamed on a branch and edited on main merges without a conflict. In order: each test builds on the last.
 */
test.describe.configure({ mode: 'serial' })

let instances: Awaited<ReturnType<typeof startInstances>>
/** The workflow the first test protects on A. */
let planFlowId: string
test.beforeAll(async () => {
  test.setTimeout(120_000)
  instances = await startInstances([E2E_PORT + 11, E2E_PORT + 12])
})
test.afterAll(async () => {
  await instances?.stop()
})

/** Signed-in pages on A and B, their errors collected. */
async function open(browser: Browser, errors: string[]) {
  return Promise.all(
    instances.instances.map(async ({ base }) => {
      const context = await browser.newContext({ baseURL: base, viewport: { width: 1600, height: 1000 } })
      const page = await context.newPage()
      page.on('pageerror', (e) => errors.push(`${base}: ${e.message}`))
      await signIn(page)
      return page
    }),
  ) as Promise<[Page, Page]>
}

const production = async (page: Page) =>
  (await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)).find(
    (e) => e.slug === 'production',
  )!

/** A run started through the API and waited for; a block's rows. */
async function runFlow(page: Page, slug: string, blockName = 'customers') {
  const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, { data: {} })
  expect(started.status()).toBe(202)
  const { run } = (await started.json()) as { run: { id: string } }
  let status = ''
  await expect
    .poll(
      async () => {
        status = ((await (await page.request.get(`/api/v1/runs/${run.id}`)).json()).run as { status: string })
          .status
        return status
      },
      { timeout: 30_000 },
    )
    .toMatch(/^(succeeded|failed)$/)
  const block = await (await page.request.get(`/api/v1/runs/${run.id}/blocks/${blockName}`)).json()
  return { status, block: block.block as { status: string; data: unknown; error?: unknown } }
}

test('two instances on one repo: settings in Git, kept per instance', async ({ browser }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  ensureBranch(instances.repoDir, 'main')
  const [a, b] = await open(browser, errors)
  for (const page of [a, b]) {
    await trpcMutate(page, 'git.saveSettings', { repoUrl: instances.repoUrl, token: E2E_GITHUB_TOKEN })
  }
  const db = new URL(process.env.E2E_PG_URL!)

  // On A: a Postgres resource (a host only A knows; A's password), a config var, and a workflow using both.
  const prodA = await production(a)
  const resource = await trpcMutate<{ id: string }>(a, 'resources.create', {
    type: 'postgres',
    name: 'Shop',
    slug: 'shop',
  })
  const config = {
    host: 'db.instance-a.internal',
    port: Number(db.port),
    database: db.pathname.slice(1),
    user: decodeURIComponent(db.username),
    ssl: 'disable',
  }
  await trpcMutate(a, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: prodA.id,
    config,
    secrets: { password: 'not-the-password' },
  })
  const plan = await trpcMutate<{ id: string }>(a, 'configVars.create', { name: 'PLAN', isSecret: false })
  await trpcMutate(a, 'configVars.setValue', { configVarId: plan.id, environmentId: prodA.id, value: 'pro' })
  const flow = await trpcMutate<{ id: string }>(a, 'workflows.create', {
    slug: 'plan-customers',
    name: 'Plan',
  })
  await trpcMutate(a, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        {
          name: 'customers',
          type: 'resourceQuery',
          config: {
            resource: 'shop',
            query: { sql: 'select email from customers where plan = {{ configVars.PLAN }} order by id' },
          },
        },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'customers' }],
    },
  })
  await trpcMutate(a, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  planFlowId = flow.id

  // A protects all three; their pull requests merged, B deploys them.
  await trpcMutate(a, 'git.protectSettings', { kind: 'resource', id: resource.id })
  await trpcMutate(a, 'git.protectSettings', { kind: 'config_var', id: plan.id })
  await trpcMutate(a, 'git.protect', { kind: 'workflow', id: flow.id })
  await mergeOpenPulls(instances.github)
  const prodB = await production(b)
  const resourceOnB = async () =>
    (
      await trpcQuery<{ resources: { id: string; slug: string }[] }>(b, 'resources.list', undefined)
    ).resources.find((r) => r.slug === 'shop')
  await expect.poll(resourceOnB, { timeout: 30_000 }).toBeTruthy()
  const shopB = (await resourceOnB())!

  // B fills in its own password and overrides the host, in the browser.
  await b.goto(`/resources/${shopB.id}`)
  await b.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(b.getByTestId('settings-from-git')).toContainText('come from Git')
  await b.getByLabel('Password', { exact: true }).first().fill(decodeURIComponent(db.password))
  await b.getByRole('button', { name: 'Save secrets' }).click()
  await expect(b.getByRole('button', { name: 'Save secrets' })).toBeDisabled()
  const overrides = b.getByTestId('overrides')
  await overrides.getByLabel('Setting to override').fill('host')
  await overrides.getByRole('button', { name: 'Override', exact: true }).click()
  await overrides.getByLabel('Override of host').fill('127.0.0.1')
  await overrides.getByRole('button', { name: 'Save overrides' }).click()
  await expect(overrides).toContainText('Saved.')

  // A commits a change through Save to branch: the plan becomes free.
  await a.goto('/settings/config-vars')
  const row = a.getByRole('row').filter({ hasText: 'PLAN' })
  await expect(row.getByText('In Git', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Edit' }).click()
  await row.getByRole('textbox').fill('free')
  await row.getByRole('button', { name: 'Save to branch…' }).click()
  await a.getByTestId('save-to-branch-confirm').click()
  await expect(a.getByTestId('save-to-branch-result')).toContainText('settings/config-var-plan')
  await a.getByTestId('open-pull-request').click()
  await expect(a.getByTestId('pull-request-link')).toContainText('Open')
  await a.getByRole('button', { name: 'Done' }).click()
  await mergeOpenPulls(instances.github)

  // B deploys it, keeping its password and override; the workflow runs there with the new plan.
  const planOnB = async () =>
    (
      await trpcQuery<{ name: string; values: Record<string, { value?: string }> }[]>(
        b,
        'configVars.list',
        undefined,
      )
    ).find((v) => v.name === 'PLAN')?.values[prodB.id]?.value
  await expect.poll(planOnB, { timeout: 30_000 }).toBe('free')
  const view = await trpcQuery<{
    environments: {
      environmentId: string
      config: { host: string }
      secretsSet: boolean
      overrides: unknown
    }[]
  }>(b, 'resources.get', { id: shopB.id })
  expect(view.environments.find((e) => e.environmentId === prodB.id)).toMatchObject({
    config: { host: 'db.instance-a.internal' },
    secretsSet: true,
    overrides: { host: '127.0.0.1' },
  })
  const ran = await runFlow(b, 'plan-customers')
  expect(ran.status).toBe('succeeded')
  expect(JSON.stringify(ran.block.data)).toContain('grace@example.com')
  expect(JSON.stringify(ran.block.data)).not.toContain('ada@example.com')

  expect(errors).toEqual([])
})

test('a resource B lacks: the banner and the notify workflow, then deployed once it exists; a rename merged', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  const [a, b] = await open(browser, errors)
  /** How B's last deploy left the workflow: deployed, problem or missing. */
  const statusOnB = async (slug: string) =>
    (
      await trpcQuery<{ objects: { kind: string; slug: string; status: string }[] }>(
        b,
        'git.status',
        undefined,
      )
    ).objects.find((o) => o.kind === 'workflow' && o.slug === slug)?.status
  const problemsOnB = async () =>
    (await trpcQuery<{ problems: { slug: string | null; message: string }[] }>(b, 'git.health', undefined))
      .problems
  const minimal = { schemaVersion: 1, blocks: [{ name: 'startTrigger', type: 'startTrigger' }], edges: [] }

  // B's admins pick a workflow to tell about deploy problems.
  const tell = await trpcMutate<{ id: string }>(b, 'workflows.create', { slug: 'tell-ops', name: 'Tell ops' })
  await trpcMutate(b, 'workflows.saveDraft', { id: tell.id, revision: 1, definition: minimal })
  await trpcMutate(b, 'releases.publish', { workflowId: tell.id, draftRevision: 2 })
  await trpcMutate(b, 'git.setNotifyWorkflow', { workflowId: tell.id })

  // A commits a workflow naming `ledger`, a resource only A has.
  await trpcMutate(a, 'resources.create', { type: 'postgres', name: 'Ledger', slug: 'ledger' })
  const report = await trpcMutate<{ id: string }>(a, 'workflows.create', {
    slug: 'ledger-report',
    name: 'Ledger',
  })
  await trpcMutate(a, 'workflows.saveDraft', {
    id: report.id,
    revision: 1,
    definition: {
      ...minimal,
      blocks: [
        ...minimal.blocks,
        { name: 'totals', type: 'resourceQuery', config: { resource: 'ledger', query: { sql: 'select 1' } } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'totals' }],
    },
  })
  await trpcMutate(a, 'releases.publish', { workflowId: report.id, draftRevision: 2 })
  await trpcMutate(a, 'git.protect', { kind: 'workflow', id: report.id })
  await mergeOpenPulls(instances.github)

  // B can't deploy it: its admins see the banner, and the notify workflow ran.
  await expect
    .poll(async () => (await problemsOnB()).filter((p) => p.slug === 'ledger-report').length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  expect(await problemsOnB()).toEqual([
    {
      kind: 'workflow',
      slug: 'ledger-report',
      path: 'workflows/ledger-report',
      message: 'The workflow isn\'t valid: No resource has the slug "ledger"',
    },
  ])
  expect(await statusOnB('ledger-report')).toBe('problem')
  await b.goto('/workflows')
  await expect(b.getByTestId('git-health-banner')).toContainText('Git sync:')
  await expect
    .poll(
      async () =>
        (
          (await (await b.request.get('/api/v1/workflows/tell-ops/runs?limit=20')).json()).runs as {
            triggerType: string
          }[]
        ).map((r) => r.triggerType),
      { timeout: 30_000 },
    )
    .toContain('git')

  // Once B has its own `ledger`, the next poll deploys the workflow and the banner goes.
  await trpcMutate(b, 'resources.create', { type: 'postgres', name: 'Ledger', slug: 'ledger' })
  await expect.poll(() => statusOnB('ledger-report'), { timeout: 30_000 }).toBe('deployed')
  expect(await problemsOnB()).toEqual([])
  await b.reload()
  await expect(b.getByTestId('git-health-banner')).toHaveCount(0)

  // On A, a branch renames the block `customers` to `buyers` while main changes its SQL: Update from main merges
  // them without a conflict, and the merged pull request deploys the renamed block with main's SQL to B.
  const draft = await trpcMutate<{ id: string }>(a, 'branchDrafts.open', {
    kind: 'workflow',
    id: planFlowId,
    branch: 'buyers',
    create: true,
  })
  const renamed = (definition: Json) =>
    JSON.parse(JSON.stringify(definition).replaceAll('"customers"', '"buyers"'))
  await commitDraft(a, draft.id, renamed, 'Customers are buyers')
  pushFiles(instances.repoDir, 'main', {
    'workflows/plan-customers/blocks/customers.sql':
      'select email, plan from customers where plan = {{ configVars.PLAN }} order by id\n',
  })
  const merged = await trpcMutate<{ status: string }>(a, 'branchDrafts.updateFromMain', { id: draft.id })
  expect(merged.status).toBe('merged')
  await trpcMutate(a, 'git.openPullRequest', { branch: 'buyers', title: 'Customers are buyers' })
  await mergeOpenPulls(instances.github)
  await expect
    .poll(async () => (await runFlow(b, 'plan-customers', 'buyers')).block?.data ?? null, { timeout: 30_000 })
    .toEqual([{ email: 'grace@example.com', plan: 'free' }])

  expect(errors).toEqual([])
})
