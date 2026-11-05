import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { block, field, openCode, signIn, trpcMutate, typeInto } from './helpers'

const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // No background gc or maintenance: a temporary clone must be done with once git returns (M22: a detached
  // auto-gc writing into one while it was removed failed m20-done-when with ENOTEMPTY).
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_AUTHOR_NAME: 'A developer',
  GIT_AUTHOR_EMAIL: 'dev@optiply.nl',
  GIT_COMMITTER_NAME: 'A developer',
  GIT_COMMITTER_EMAIL: 'dev@optiply.nl',
}

/** Someone working on the repo with git itself: clones a branch, writes files, commits and pushes. */
function pushFiles(repoDir: string, branch: string, files: Record<string, string>, message: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-m11-dev-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv }).toString().trim()
    git('clone', '--quiet', '--branch', branch, repoDir, '.')
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    git('add', '-A')
    git('commit', '--quiet', '-m', message)
    git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
    return git('rev-parse', 'HEAD')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** A file on a branch of the repo, read with git. */
function readRepoFile(repoDir: string, branch: string, path: string): string {
  return execFileSync('git', ['--git-dir', repoDir, 'show', `refs/heads/${branch}:${path}`], {
    env: gitEnv,
  }).toString()
}

const query = async <T>(page: Page, path: string, input: unknown): Promise<T> => {
  const res = await page.request.get(
    `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
  )
  return (await res.json()).result.data.json
}

/**
 * M11's done-when: protect a workflow and an app; edit both on a branch and run the branch drafts; commit (the repo
 * shows the code blocks as .js and the SQL as .sql) and open a pull request; merging it deploys a new live release
 * of each within seconds of the webhook, and a workflow added on the branch is created; main is read-only for
 * protected objects; a commit on main with an invalid definition deploys nothing and says why, picked up by
 * polling without the webhook.
 */
test('M11 done-when: protect, edit on a branch, commit, merge, deploy', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  // The repo as the instance reaches it, and as this test does (the same file:// repo, unless a check against
  // another stack says otherwise).
  const repoUrl = process.env.E2E_GIT_REPO_URL!
  const repoDir = process.env.E2E_GIT_REPO_DIR ?? new URL(repoUrl).pathname
  const github = process.env.E2E_FAKE_GITHUB!
  const stamp = Date.now()
  const branch = `m11/change-${stamp}`

  // Git sync, set up in the settings page; merges on the (fake) GitHub send a signed push webhook.
  await page.goto('/settings/git')
  await page.getByRole('textbox', { name: /^Repository/ }).fill(repoUrl)
  await page.getByRole('textbox', { name: /^GitHub token/ }).fill(E2E_GITHUB_TOKEN)
  await page.getByRole('button', { name: /^(Generate|Replace)$/ }).click()
  const secret = (await page.getByTestId('new-webhook-secret').textContent())!
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('new-webhook-secret')).toHaveCount(0)
  await fetch(`${github}/_test/webhook`, {
    method: 'POST',
    body: JSON.stringify({ url: `${baseURL}/api/git/webhook`, secret }),
  })

  // A published workflow (a SQL query and code) and a published app (a SQL query shown in a text).
  const flowSlug = `m11-flow-${stamp}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: flowSlug,
    name: `Orders ${stamp}`,
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        {
          name: 'customers',
          type: 'resourceQuery',
          config: { resource: 'shop_db', query: { sql: 'select * from customers order by id' } },
        },
        { name: 'emails', type: 'code', config: { code: 'return customers.data.map((c) => c.email)' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'customers' },
        { from: 'customers', port: 'out', to: 'emails' },
      ],
    },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  const appSlug = `m11-app-${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', {
    slug: appSlug,
    name: `Customer ${stamp}`,
  })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'email', type: 'text', props: { value: '{{ customer.data[0].email }}' } }],
      queries: [
        {
          name: 'customer',
          kind: 'resource',
          resource: 'shop_db',
          query: { sql: 'select email from customers where id = 1' },
          run: 'auto',
        },
      ],
      layout: { email: { x: 0, y: 0, w: 6, h: 1 } },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })

  // Protect both: the workflow from the list, the app from its settings.
  await page.goto('/workflows')
  await page
    .getByTestId(`workflow-${flowSlug}`)
    .getByRole('button', { name: /^Protect .* in Git$/ })
    .click()
  await page.getByTestId('protect-confirm').click()
  await expect(page.getByTestId('pull-request-link')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.goto(`/apps/${appSlug}/edit`)
  await page.getByRole('button', { name: 'App settings' }).click()
  await page.getByRole('button', { name: 'Protect in Git' }).click()
  await page.getByTestId('protect-confirm').click()
  await expect(page.getByTestId('protect-result')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  // Their protect pull requests merge (nothing new to deploy: it's what's live).
  const pulls = async () =>
    (await (await fetch(`${github}/_test/pulls`)).json()) as { number: number; head: string; state: string }[]
  for (const pull of (await pulls()).filter((p) => p.state === 'open')) {
    expect((await fetch(`${github}/_test/pulls/${pull.number}/merge`, { method: 'POST' })).ok).toBe(true)
  }

  // Main is read-only: no toolbar, no Publish.
  await page.goto(`/workflows/${flow.id}`)
  await expect(page.getByTestId('read-only-banner')).toBeVisible()
  await expect(page.getByTitle('Add a code block')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0)

  // Edit the workflow on a new branch, and run the branch draft.
  await page.getByRole('combobox', { name: 'Branch' }).selectOption({ label: 'New branch…' })
  await page.getByRole('textbox', { name: 'New branch name' }).fill(branch)
  await page.getByRole('button', { name: 'Start branch' }).click()
  await expect(page.getByText('New: the first commit makes it')).toBeVisible()
  await block(page, 'emails').click()
  await typeInto(
    page,
    field(page, 'emails', 'code.js'),
    'return customers.data.map((c) => c.email.toUpperCase())',
  )
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const panel = page.getByTestId('run-panel')
  await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
  await panel.getByText('emails', { exact: true }).first().click()
  await expect(panel).toContainText('ADA@EXAMPLE.COM')

  // Commit it, seeing the diff.
  await page.getByTestId('commit-open').click()
  await page.getByText(`workflows/${flowSlug}/blocks/emails.js`).click()
  await expect(page.getByTestId('file-diff')).toContainText('toUpperCase')
  await page.getByRole('textbox', { name: 'Message' }).fill('Upper-case the emails')
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toContainText(branch)
  await page.getByRole('button', { name: 'Done' }).click()

  // The app: main read-only (no palette), then the same branch; its branch draft runs its queries.
  await page.goto(`/apps/${appSlug}/edit`)
  await expect(page.getByTestId('read-only-banner')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('frame-email')).toContainText('ada@example.com')
  await page.getByRole('combobox', { name: 'Branch' }).selectOption({ label: branch })
  await expect(page.getByTestId('commit-open')).toBeVisible()
  await openCode(page, 'customer')
  await typeInto(
    page,
    page.locator('[data-testid$="/queries/0/query/sql"]'),
    'select email from customers where id = 2',
  )
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('frame-email')).toContainText('grace@example.com')
  await page.getByTestId('commit-open').click()
  await expect(page.getByTestId('commit-files')).toContainText(`apps/${appSlug}/queries/customer.sql`)
  await page.getByRole('textbox', { name: 'Message' }).fill('Show the second customer')
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toContainText(branch)

  // The repo has the code as .js and the SQL as .sql.
  expect(readRepoFile(repoDir, branch, `workflows/${flowSlug}/blocks/emails.js`)).toBe(
    'return customers.data.map((c) => c.email.toUpperCase())\n',
  )
  expect(readRepoFile(repoDir, branch, `workflows/${flowSlug}/blocks/customers.sql`)).toBe(
    'select * from customers order by id\n',
  )
  expect(readRepoFile(repoDir, branch, `apps/${appSlug}/queries/customer.sql`)).toBe(
    'select email from customers where id = 2\n',
  )
  expect(readRepoFile(repoDir, branch, `workflows/${flowSlug}/workflow.json`)).not.toContain('toUpperCase')

  // A developer adds a new workflow on the same branch, with git itself.
  const newSlug = `m11-new-${stamp}`
  pushFiles(
    repoDir,
    branch,
    {
      [`workflows/${newSlug}/workflow.json`]: `${JSON.stringify(
        {
          name: `Added in Git ${stamp}`,
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            { name: 'hello', type: 'code', config: {} },
          ],
          edges: [{ from: 'startTrigger', port: 'out', to: 'hello' }],
        },
        null,
        2,
      )}\n`,
      [`workflows/${newSlug}/blocks/hello.js`]: "return 'hello from git'\n",
    },
    `Add ${newSlug}`,
  )

  // Open the pull request from the editor, then merge it: the webhook deploys within seconds.
  await page.getByTestId('open-pull-request').click()
  await expect(page.getByTestId('commit-result').getByTestId('pull-request-link')).toContainText('Open')
  await page.getByRole('button', { name: 'Done' }).click()
  const pr = (await pulls()).find((p) => p.head === branch && p.state === 'open')!
  const mergedAt = Date.now()
  const merged = await fetch(`${github}/_test/pulls/${pr.number}/merge`, { method: 'POST' })
  const { commit: mergeCommit } = (await merged.json()) as { commit: string }
  // The whole deploy is done once the merge commit is the deployed one (workflows go first, then apps).
  await expect
    .poll(
      async () =>
        (await query<{ settings: { deployedCommit: string } }>(page, 'git.status', undefined)).settings
          .deployedCommit,
      { timeout: 15_000 },
    )
    .toBe(mergeCommit)
  expect(
    (await query<{ liveRelease: { version: string } | null }>(page, 'workflows.get', { id: flow.id }))
      .liveRelease?.version,
  ).toBe('1.0.1')
  const deploySeconds = (Date.now() - mergedAt) / 1000
  expect(deploySeconds).toBeLessThan(10)
  const appReleases = await query<{ version: string; live: boolean; gitCommit: string | null }[]>(
    page,
    'apps.releases',
    {
      appId: app.id,
    },
  )
  expect(appReleases.find((r) => r.live)).toMatchObject({ version: '1.0.1', gitCommit: expect.any(String) })
  const workflowsList = await query<{ slug: string; gitProtected: boolean; liveReleaseId: string | null }[]>(
    page,
    'workflows.list',
    undefined,
  )
  expect(workflowsList.find((w) => w.slug === newSlug)).toMatchObject({
    gitProtected: true,
    liveReleaseId: expect.any(String),
  })

  // Main shows what merged; the app's live release shows the second customer.
  await page.goto(`/workflows/${flow.id}`)
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.1')
  await expect(block(page, 'emails')).toContainText('toUpperCase')
  await page.goto(`/apps/${appSlug}`)
  await expect(page.getByText('v1.0.1', { exact: true })).toBeVisible()
  await expect(page.getByText('grace@example.com', { exact: true })).toBeVisible()

  // Without the webhook, polling picks up the next commit: an invalid one pushed straight to main deploys nothing
  // and says why, and the live release stays.
  await fetch(`${github}/_test/webhook`, { method: 'POST', body: JSON.stringify({}) })
  const broken = pushFiles(
    repoDir,
    'main',
    {
      [`workflows/${flowSlug}/workflow.json`]: readRepoFile(
        repoDir,
        'main',
        `workflows/${flowSlug}/workflow.json`,
      ).replace('"type": "code"', '"type": "teleport"'),
    },
    'Break the workflow',
  )
  // Polling (every 2 s in these tests) picks it up.
  await expect
    .poll(
      async () =>
        (await query<{ settings: { deployedCommit: string } }>(page, 'git.status', undefined)).settings
          .deployedCommit,
      {
        timeout: 15_000,
      },
    )
    .toBe(broken)
  await page.goto('/settings/git')
  await expect(page.getByTestId(`git-object-workflow-${flowSlug}`)).toContainText('Problems', {
    timeout: 15_000,
  })
  await expect(page.getByTestId(`git-object-workflow-${flowSlug}`)).toContainText(
    `workflows/${flowSlug}/workflow.json`,
  )
  await expect(page.getByTestId('git-deploys')).toContainText('Break the workflow')
  const status = await query<{
    settings: { deployedCommit: string }
    deploys: { commit: string; trigger: string; status: string }[]
  }>(page, 'git.status', undefined)
  expect(status.settings.deployedCommit).toBe(broken)
  expect(status.deploys[0]).toMatchObject({ commit: broken, trigger: 'poll', status: 'problems' })
  expect(
    (await query<{ liveRelease: { version: string } }>(page, 'workflows.get', { id: flow.id })).liveRelease
      .version,
  ).toBe('1.0.1')

  expect(errors).toEqual([])
})
