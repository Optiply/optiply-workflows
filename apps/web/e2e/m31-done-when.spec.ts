import { expect, type Page, test } from '@playwright/test'
import { git, pushFiles } from './git-helpers'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'

// M31's done-when (architecture.md, the M31 row): Git sync through GitLab and through a GitHub App. Each is set up in
// Settings → Git and tested there; a published workflow is protected (its merge or pull request opened by the
// instance and merged on the fake host); then a change pushed to a branch gets its request from the instance, is
// merged on the host, and the host's push webhook deploys it: the live workflow answers with the new code.

const gitlab = JSON.parse(process.env.E2E_GITLAB!) as {
  url: string
  repoUrl: string
  repoDir: string
  project: string
  token: string
}
const app = JSON.parse(process.env.E2E_GITHUB_APP!) as { id: string; privateKey: string }
const github = process.env.E2E_FAKE_GITHUB!
const githubRepoUrl = process.env.E2E_GIT_REPO_URL!
const githubRepoDir = process.env.E2E_GIT_REPO_DIR ?? new URL(githubRepoUrl).pathname

/** Other specs expect the e2e repo with GitHub's token: put it back. */
test.afterEach(async ({ page }) => {
  await trpcMutate(page, 'git.saveSettings', {
    repoUrl: githubRepoUrl,
    host: 'github',
    githubAuth: 'token',
    token: E2E_GITHUB_TOKEN,
  })
})

interface Host {
  name: 'gitlab' | 'github'
  repoDir: string
  /** The open requests on the fake host, and merging one there (its merge commit). */
  open(): Promise<{ id: number; head: string }[]>
  merge(id: number): Promise<string>
  webhook(url: string, secret: string): Promise<void>
}

const gitlabHost: Host = {
  name: 'gitlab',
  repoDir: gitlab.repoDir,
  async open() {
    const all = (await (await fetch(`${gitlab.url}/_test/merge_requests`)).json()) as {
      iid: number
      state: string
      source: string
    }[]
    return all.filter((m) => m.state === 'opened').map((m) => ({ id: m.iid, head: m.source }))
  },
  async merge(id) {
    const res = await fetch(`${gitlab.url}/_test/merge_requests/${id}/merge`, { method: 'POST' })
    expect(res.ok).toBe(true)
    return ((await res.json()) as { commit: string }).commit
  },
  async webhook(url, secret) {
    await fetch(`${gitlab.url}/_test/webhook`, { method: 'POST', body: JSON.stringify({ url, secret }) })
  },
}

const githubHost: Host = {
  name: 'github',
  repoDir: githubRepoDir,
  async open() {
    const all = (await (await fetch(`${github}/_test/pulls`)).json()) as {
      number: number
      state: string
      head: string
    }[]
    return all.filter((p) => p.state === 'open').map((p) => ({ id: p.number, head: p.head }))
  },
  async merge(id) {
    const res = await fetch(`${github}/_test/pulls/${id}/merge`, { method: 'POST' })
    expect(res.ok).toBe(true)
    return ((await res.json()) as { commit: string }).commit
  },
  async webhook(url, secret) {
    await fetch(`${github}/_test/webhook`, { method: 'POST', body: JSON.stringify({ url, secret }) })
  },
}

/** Generates the webhook secret, saves, and points the fake host's push webhook at this instance. */
async function saveWithWebhook(page: Page, host: Host, baseURL: string) {
  await page.getByRole('button', { name: /^(Generate|Replace)$/ }).click()
  const secret = (await page.getByTestId('new-webhook-secret').textContent())!
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('new-webhook-secret')).toHaveCount(0)
  await host.webhook(`${baseURL}/api/git/webhook`, secret)
}

const deployedCommit = async (page: Page) =>
  (await trpcQuery<{ settings: { deployedCommit: string | null } }>(page, 'git.status', undefined)).settings
    .deployedCommit

/** The rest of the done-when, the same on both hosts: protect, merge, change on a branch, merge, deployed. */
async function protectChangeDeploy(page: Page, host: Host, words: { noun: string; mark: string }) {
  const stamp = Date.now().toString(36)
  const slug = `m31-${host.name}-${stamp}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug,
    name: `M31 ${host.name} ${stamp}`,
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'step', type: 'code', config: { code: "return 'v1'" } },
        { name: 'reply', type: 'response', config: { status: '200', body: '{{ step.data }}' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'step' },
        { from: 'step', port: 'out', to: 'reply' },
      ],
    },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })

  await test.step(`protected from the list: the instance opens its ${words.noun}, merged on the host`, async () => {
    await page.goto('/workflows')
    const protectRow = page.getByTestId(`workflow-${slug}`)
    await protectRow.getByRole('button', { name: /^Actions for / }).click()
    await protectRow.getByRole('menuitem', { name: 'Protect in Git…' }).click()
    await page.getByTestId('protect-confirm').click()
    await expect(page.getByTestId('protect-result')).toContainText(`Review and merge the ${words.noun}`)
    await expect(page.getByTestId('pull-request-link')).toContainText(words.mark)
    await page.getByRole('button', { name: 'Done' }).click()
    const request = (await host.open()).find((r) => r.head === `protect/workflow-${slug}`)!
    const merged = await host.merge(request.id)
    await expect.poll(() => deployedCommit(page), { timeout: 30_000 }).toBe(merged)
  })

  await test.step(`a change on a branch: its ${words.noun} merged, the push webhook deploys it`, async () => {
    const branch = `m31/${host.name}-${stamp}`
    git(host.repoDir, 'branch', branch, 'main')
    pushFiles(host.repoDir, branch, { [`workflows/${slug}/blocks/step.js`]: "return 'v2'\n" })
    const opened = await trpcMutate<{
      pullRequest: { kind: string; number: number } | null
      pullRequestError: string | null
    }>(page, 'git.openPullRequest', { branch, title: `Answer v2 (${host.name})` })
    expect(opened.pullRequestError).toBeNull()
    expect(opened.pullRequest?.kind).toBe(host.name === 'gitlab' ? 'merge' : 'pull')
    const merged = await host.merge(opened.pullRequest!.number)
    await expect.poll(() => deployedCommit(page), { timeout: 30_000 }).toBe(merged)
    // The live workflow answers with the merged code.
    await expect
      .poll(
        async () => {
          const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, {
            data: { input: {}, version: 'live' },
          })
          const runId = (await started.json()).run.id as string
          for (let i = 0; i < 50; i++) {
            const run = (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).run
            if (run.status === 'succeeded') return run.response?.body
            if (run.status === 'failed') return `failed: ${JSON.stringify(run.error)}`
            await new Promise((r) => setTimeout(r, 200))
          }
          return 'still running'
        },
        { timeout: 30_000 },
      )
      .toBe('v2')
  })
}

test('GitLab: set up and tested in Settings, merge requests, deployed by its push webhook', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.goto('/settings/git')
  await page.getByTestId('git-repo-url').fill(gitlab.repoUrl)
  // A file:// repo says nothing of its host: the admin picks GitLab.
  await page.getByTestId('git-host').selectOption('gitlab')
  await page.getByRole('textbox', { name: /^GitLab access token/ }).fill(gitlab.token)
  await saveWithWebhook(page, gitlabHost, baseURL!)
  await expect(page.getByTestId('git-webhook-help')).toContainText('GitLab webhook')
  await expect(page.getByTestId('git-webhook-help')).toContainText('Secret token')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByTestId('git-test-host')).toContainText(`GitLab: ${gitlab.project} (Developer)`)
  await protectChangeDeploy(page, gitlabHost, { noun: 'merge request', mark: '!' })
})

test('GitHub App: set up and tested in Settings, pull requests with its tokens, deployed by the webhook', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.goto('/settings/git')
  await page.getByTestId('git-repo-url').fill(githubRepoUrl)
  await page.getByTestId('git-host').selectOption('github')
  await page.getByTestId('git-signin').selectOption('app')
  await page.getByTestId('git-app-id').fill(app.id)
  await page.getByTestId('git-app-key').fill(app.privateKey)
  await saveWithWebhook(page, githubHost, baseURL!)
  await expect(page.getByTestId('git-webhook-help')).toContainText('GitHub webhook')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByTestId('git-test-host')).toContainText(
    'GitHub App optiply-sync, installed on optiply (optiply/flows)',
  )
  await protectChangeDeploy(page, githubHost, { noun: 'pull request', mark: '#' })
})
