import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appJwt, appPrivateKey, GitHubAppTokens, gitCredentials } from '../src/services/git/hosts'
import { loadGitSettings } from '../src/services/git/settings'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M31 step 3: GitHub through a GitHub App (a JWT, the installation, installation tokens) on the fake GitHub.
const APP_ID = '424242'
const rsa = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
const keys = rsa()

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let admin: ReturnType<typeof trpc>
let remote: string

const data = (res: { body: { result?: { data: unknown }; error?: unknown } }) => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data as never
}
const failure = (res: { body: { error?: { data?: { code: string }; message?: string } } }) => ({
  code: res.body.error?.data?.code,
  message: res.body.error?.message,
})
const asApp = (extra: object = {}) =>
  admin.mutate('git.saveSettings', {
    repoUrl: `file://${remote}`,
    host: 'github',
    githubAuth: 'app',
    githubAppId: APP_ID,
    appPrivateKey: keys.privateKey,
    ...extra,
  })

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply'))
  remote = bareRepo(join(dir, 'optiply', 'flows.git'))
  github = await fakeGitHub({
    repoPath: remote,
    owner: 'optiply',
    repo: 'flows',
    token: 'ghp_not_used_here',
    app: { id: APP_ID, publicKey: keys.publicKey },
  })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITHUB_API_URL: github.url,
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
})
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

describe('a GitHub App', () => {
  it('signs its JWT with the private key (RS256: issued a minute back, nine minutes long)', () => {
    const now = Date.UTC(2026, 10, 4, 12)
    const [header, payload, signature] = appJwt(APP_ID, appPrivateKey(keys.privateKey), now).split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: APP_ID,
    })
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true)
  })

  it('needs the App’s id and an RSA private key', async () => {
    expect(failure(await asApp({ githubAppId: null }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/GitHub App's id/),
    })
    expect(failure(await asApp({ appPrivateKey: 'not a key' }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/isn't an RSA private key in PEM/),
    })
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    expect(failure(await asApp({ appPrivateKey: ec.privateKey })).message).toMatch(/it's an ec key/)
    expect(data(await asApp())).toMatchObject({
      host: 'github',
      githubAuth: 'app',
      githubAppId: APP_ID,
      appPrivateKey: { set: true },
      token: { set: false },
    })
    // Kept when saved again without it.
    expect(
      data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, branch: 'main' })),
    ).toMatchObject({ githubAuth: 'app', appPrivateKey: { set: true } })
  })

  it('opens pull requests with installation tokens: minted once, again when GitHub refuses one', async () => {
    data(await asApp())
    const created: { id: string } = data(
      await admin.mutate('workflows.create', { slug: 'sync-orders', name: 'Sync orders' }),
    )
    const protectedFlow = data(await admin.mutate('git.protect', { kind: 'workflow', id: created.id })) as {
      pullRequest: Record<string, unknown>
      pullRequestError: string | null
    }
    expect(protectedFlow.pullRequestError).toBeNull()
    expect(protectedFlow.pullRequest).toMatchObject({ kind: 'pull', number: 1, created: true })
    const minted = () => github.calls.filter((c) => c.startsWith('minted ')).length
    expect(minted()).toBe(1)
    // Kept: the next call doesn't mint.
    expect(
      data(await admin.query('git.pullRequest', { branch: 'protect/workflow-sync-orders' })),
    ).toMatchObject({
      pullRequest: { number: 1 },
    })
    expect(minted()).toBe(1)
    // Revoked (expired early): refused once, minted again, and the call goes through.
    await fetch(`${github.url}/_test/expire-app-tokens`, { method: 'POST' })
    expect(
      data(await admin.query('git.pullRequest', { branch: 'protect/workflow-sync-orders' })),
    ).toMatchObject({
      pullRequest: { number: 1 },
      error: null,
    })
    expect(minted()).toBe(2)
    // Git signs in with the installation token as `x-access-token`.
    const loaded = await loadGitSettings(env.db, env.config.keyring)
    expect(await gitCredentials(loaded!, env.config)()).toEqual({
      username: 'x-access-token',
      token: expect.stringMatching(/^ghs_installation\d+$/),
    })
  })

  it('mints again before a token runs out, and says when the App isn’t installed or the key is wrong', async () => {
    const shortLived = await fakeGitHub({
      repoPath: remote,
      owner: 'optiply',
      repo: 'flows',
      token: 'ghp_x',
      app: { id: APP_ID, publicKey: keys.publicKey, tokenTtlMs: 4 * 60_000 },
    })
    try {
      const target = { api: shortLived.url, owner: 'optiply', repo: 'flows' }
      const tokens = new GitHubAppTokens(target, APP_ID, keys.privateKey)
      // Under five minutes left: a new one each time.
      expect(await tokens.token()).not.toBe(await tokens.token())
      await expect(
        new GitHubAppTokens({ ...target, owner: 'someone-else' }, APP_ID, keys.privateKey).token(),
      ).rejects.toThrow(/isn't installed on someone-else\/flows/)
      await expect(new GitHubAppTokens(target, APP_ID, rsa().privateKey).token()).rejects.toThrow(
        /GitHub said 401.*Check the GitHub App's id and private key/,
      )
    } finally {
      await shortLived.close()
    }
  })

  it('Test connection names the App and its installation, and what it lacks', async () => {
    data(await asApp())
    const result = data(await admin.mutate('git.testConnection')) as { ok: boolean; host: unknown }
    expect(result).toMatchObject({
      ok: true,
      host: {
        ok: true,
        message: 'GitHub App optiply-sync, installed on optiply (optiply/flows)',
        problems: [],
      },
    })
    const limited = await fakeGitHub({
      repoPath: remote,
      owner: 'optiply',
      repo: 'flows',
      token: 'ghp_x',
      app: { id: APP_ID, publicKey: keys.publicKey, permissions: { contents: 'read', metadata: 'read' } },
    })
    try {
      const tokens = new GitHubAppTokens(
        { api: limited.url, owner: 'optiply', repo: 'flows' },
        APP_ID,
        keys.privateKey,
      )
      const { missingAppPermissions } = await import('../src/services/git/hosts/github-app')
      expect(missingAppPermissions((await tokens.installation()).permissions)).toEqual([
        'contents: write',
        'pull_requests: write',
      ])
    } finally {
      await limited.close()
    }
  })
})
