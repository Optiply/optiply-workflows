import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gitSettings } from '@ow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitCredentials, gitlabTarget } from '../src/services/git/hosts'
import { loadGitSettings } from '../src/services/git/settings'
import { fakeGitLab } from './fake-gitlab'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M31 step 2: GitLab as the Git host (merge requests on a fake GitLab, its push webhook, the settings).
const TOKEN = 'glpat-gitlab-tests'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let gitlab: Awaited<ReturnType<typeof fakeGitLab>>
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let remote: string
let project: string

const data = (res: { body: { result?: { data: unknown }; error?: unknown } }) => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data as never
}
const failure = (res: { body: { error?: { data?: { code: string }; message?: string } } }) => ({
  code: res.body.error?.data?.code,
  message: res.body.error?.message,
})

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply', 'data'), { recursive: true })
  remote = bareRepo(join(dir, 'optiply', 'data', 'flows.git'))
  // A file:// remote's project is its whole path: nested groups, as GitLab's.
  project = remote
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .join('/')
  gitlab = await fakeGitLab({ repoPath: remote, project, token: TOKEN })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITLAB_API_URL: gitlab.url,
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
})
afterAll(async () => {
  await env?.stop()
  await gitlab?.close()
  await cleanup?.()
})

describe('GitLab projects and settings', () => {
  it('works out the API and the project (nested groups, an instance under a path)', () => {
    expect(gitlabTarget('https://gitlab.com/optiply/data/flows.git')).toEqual({
      api: 'https://gitlab.com/api/v4',
      project: 'optiply/data/flows',
    })
    expect(
      gitlabTarget('https://code.optiply.nl/gitlab/optiply/flows', 'https://code.optiply.nl/gitlab/api/v4'),
    ).toEqual({ api: 'https://code.optiply.nl/gitlab/api/v4', project: 'optiply/flows' })
    // The API on another host is refused (the token would go there).
    expect(gitlabTarget('https://gitlab.com/optiply/flows', 'https://evil.example.com/api/v4')).toBeNull()
    expect(gitlabTarget('https://gitlab.com/flows')).toBeNull()
    expect(gitlabTarget('file:///tmp/optiply/flows.git')).toBeNull()
  })

  it('detects the host from the URL, and asks for the token again when the host changes', async () => {
    const saved = (input: object) => admin.mutate('git.saveSettings', input)
    expect(
      data(await saved({ repoUrl: 'https://gitlab.com/optiply/flows.git', token: TOKEN })),
    ).toMatchObject({
      host: 'gitlab',
      apiUrl: null,
    })
    expect(
      failure(await saved({ repoUrl: 'https://gitlab.com/optiply/flows.git', host: 'github' })).message,
    ).toMatch(/enter the token again/)
    expect(
      data(await saved({ repoUrl: 'https://github.com/optiply/flows.git', token: 'ghp_x' })),
    ).toMatchObject({ host: 'github' })
    // Another host: the admin says which; GitLab's API URL must be on it, over https.
    expect(
      data(
        await saved({
          repoUrl: 'https://code.optiply.nl/gitlab/optiply/flows.git',
          host: 'gitlab',
          apiUrl: 'https://code.optiply.nl/gitlab/api/v4/',
          token: TOKEN,
        }),
      ),
    ).toMatchObject({ host: 'gitlab', apiUrl: 'https://code.optiply.nl/gitlab/api/v4' })
    for (const apiUrl of ['https://elsewhere.example.com/api/v4', 'not a url'])
      expect(
        failure(
          await saved({
            repoUrl: 'https://code.optiply.nl/gitlab/optiply/flows.git',
            host: 'gitlab',
            apiUrl,
          }),
        ).code,
      ).toBe('BAD_REQUEST')
    // Git signs in as GitLab's `oauth2`.
    const loaded = await loadGitSettings(env.db, env.config.keyring)
    expect(await gitCredentials(loaded!)()).toEqual({ username: 'oauth2', token: TOKEN })
  })
})

describe('merge requests on GitLab', () => {
  beforeAll(async () => {
    await env.db.delete(gitSettings)
    data(
      await admin.mutate('git.saveSettings', {
        repoUrl: `file://${remote}`,
        host: 'gitlab',
        token: TOKEN,
        webhookSecret: 'gitlab-hook-secret',
      }),
    )
  })

  it('opens a merge request when an object is protected, and finds it again', async () => {
    const created: { id: string } = data(
      await admin.mutate('workflows.create', { slug: 'sync-stock', name: 'Sync stock' }),
    )
    const result = data(await admin.mutate('git.protect', { kind: 'workflow', id: created.id })) as {
      branch: string
      pullRequest: Record<string, unknown>
      pullRequestError: string | null
    }
    expect(result.pullRequestError).toBeNull()
    expect(result.pullRequest).toMatchObject({
      kind: 'merge',
      number: 1,
      state: 'open',
      head: 'protect/workflow-sync-stock',
      base: 'main',
      url: expect.stringContaining('/-/merge_requests/1'),
      created: true,
    })
    expect(gitlab.mergeRequests[0]).toMatchObject({ source: 'protect/workflow-sync-stock', target: 'main' })
    expect(
      data(await member.query('git.pullRequest', { branch: 'protect/workflow-sync-stock' })),
    ).toMatchObject({ pullRequest: { kind: 'merge', number: 1 }, error: null })
    // Opening it again answers the open one.
    const again = data(
      await admin.mutate('git.openPullRequest', { branch: 'protect/workflow-sync-stock', title: 'Again' }),
    ) as { pullRequest: { number: number; created: boolean } }
    expect(again.pullRequest).toMatchObject({ number: 1, created: false })
    // Merged on GitLab: closed and merged here.
    gitlab.merge(1)
    expect(
      data(await member.query('git.pullRequest', { branch: 'protect/workflow-sync-stock' })),
    ).toMatchObject({ pullRequest: { state: 'closed', merged: true } })
  })

  it('reports GitLab refusing the token, without the token', async () => {
    data(
      await admin.mutate('git.saveSettings', {
        repoUrl: `file://${remote}`,
        host: 'gitlab',
        token: 'glpat-wrong',
      }),
    )
    const res = data(
      await admin.mutate('git.openPullRequest', { branch: 'protect/workflow-sync-stock', title: 'x' }),
    ) as { pullRequest: null; pullRequestError: string }
    expect(res.pullRequestError).toMatch(/GitLab said 401: 401 Unauthorized\. The token needs the api scope/)
    expect(res.pullRequestError).not.toContain('glpat-wrong')
    data(
      await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, host: 'gitlab', token: TOKEN }),
    )
  })

  it('deploys on GitLab’s push webhook, checked by its secret token', async () => {
    const post = (headers: Record<string, string>, body = JSON.stringify({ ref: 'refs/heads/main' })) =>
      env.app.inject({
        method: 'POST',
        url: '/api/git/webhook',
        payload: body,
        headers: { 'content-type': 'application/json', ...headers },
      })
    expect((await post({ 'x-gitlab-event': 'Push Hook' })).statusCode).toBe(401)
    expect((await post({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'wrong' })).statusCode).toBe(401)
    // GitHub's signature means nothing here.
    expect((await post({ 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' })).statusCode).toBe(
      401,
    )
    const ok = { 'x-gitlab-token': 'gitlab-hook-secret' }
    expect((await post({ ...ok, 'x-gitlab-event': 'Merge Request Hook' })).json()).toEqual({
      ignored: "Merge Request Hook events don't deploy",
    })
    expect(
      (
        await post({ ...ok, 'x-gitlab-event': 'Push Hook' }, JSON.stringify({ ref: 'refs/heads/other' }))
      ).json(),
    ).toEqual({ ignored: 'Only pushes to main deploy' })
    const push = await post({ ...ok, 'x-gitlab-event': 'Push Hook' })
    expect(push.statusCode).toBe(202)
    expect(push.json()).toEqual({ deploy: 'requested' })
  })
})
