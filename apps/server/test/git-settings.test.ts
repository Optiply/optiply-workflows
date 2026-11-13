import { join } from 'node:path'
import { auditEvents } from '@ow/db'
import { encodeObject, manifestFile } from '@ow/git-format'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepo } from '../src/services/git/repo'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const TOKEN = 'ghp_neverShowThisToken'
const HOOK_SECRET = 'whsec_neverShowThisEither'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
const bodies: string[] = []

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  env = await startTestApp({ GIT_ALLOW_INSECURE_URLS: 'true', GIT_CACHE_DIR: join(dir, 'cache') })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'), { record: bodies })
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'), { record: bodies })
})
afterAll(async () => {
  await env?.stop()
  await cleanup?.()
})

describe('git settings', () => {
  it('are for admins only', async () => {
    expect((await member.query('git.settings')).body.error?.data?.code).toBe('FORBIDDEN')
    expect(
      (await member.mutate('git.saveSettings', { repoUrl: 'https://github.com/a/b.git' })).body.error?.data
        ?.code,
    ).toBe('FORBIDDEN')
    expect((await member.mutate('git.testConnection')).body.error?.data?.code).toBe('FORBIDDEN')
  })

  it('start empty, then store the token and webhook secret without ever returning them', async () => {
    expect((await admin.query('git.settings')).body.result?.data).toMatchObject({
      configured: false,
      repoUrl: null,
      branch: 'main',
      token: { set: false },
    })
    const saved = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://github.com/optiply/flows.git',
      token: TOKEN,
      webhookSecret: HOOK_SECRET,
    })
    expect(saved.body.result?.data).toMatchObject({
      configured: true,
      repoUrl: 'https://github.com/optiply/flows.git',
      branch: 'main',
      token: { set: true },
      webhookSecret: { set: true },
    })

    // Saving without the token keeps it; null clears it.
    const kept = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://github.com/optiply/other.git',
      branch: 'production',
    })
    expect(kept.body.result?.data).toMatchObject({ branch: 'production', token: { set: true } })
    const cleared = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://github.com/optiply/other.git',
      webhookSecret: null,
    })
    expect(cleared.body.result?.data).toMatchObject({ token: { set: true }, webhookSecret: { set: false } })

    const audits = await env.db.select().from(auditEvents)
    const gitAudits = audits.filter((a) => a.action === 'git.settings_updated')
    expect(gitAudits.map((a) => a.metadata)).toEqual([
      {
        repoUrl: 'https://github.com/optiply/flows.git',
        branch: 'main',
        host: 'github',
        githubAuth: 'token',
        changed: ['token', 'webhook'],
      },
      {
        repoUrl: 'https://github.com/optiply/other.git',
        branch: 'production',
        host: 'github',
        githubAuth: 'token',
        changed: [],
      },
      {
        repoUrl: 'https://github.com/optiply/other.git',
        branch: 'main',
        host: 'github',
        githubAuth: 'token',
        changed: ['webhook'],
      },
    ])
    const stored = JSON.stringify(audits)
    expect(stored).not.toContain(TOKEN)
    expect(stored).not.toContain(HOOK_SECRET)
  })

  it('needs the token again when the repo moves to another host', async () => {
    const moved = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://gitlab.example.com/optiply/flows.git',
    })
    expect(moved.body.error?.message).toMatch(/enter the token again/)
    const withToken = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://gitlab.example.com/optiply/flows.git',
      token: 'glpat_x',
    })
    expect(withToken.body.result?.data).toMatchObject({ token: { set: true } })
  })

  it('refuses URLs with credentials and bad branch names', async () => {
    const creds = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://me:pw@github.com/optiply/flows.git',
    })
    expect(creds.body.error?.message).toMatch(/credentials/)
    const branch = await admin.mutate('git.saveSettings', {
      repoUrl: 'https://github.com/a/b.git',
      branch: 'a..b',
    })
    expect(branch.body.error?.data?.code).toBe('BAD_REQUEST')
  })

  it('tests the connection: an empty repo, then one with workflows and apps', async () => {
    const remote = bareRepo(join(dir, 'flows.git'))
    await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: null })
    expect((await admin.mutate('git.testConnection')).body.result?.data).toEqual({
      ok: true,
      commit: null,
      branches: 0,
      manifest: 'missing',
      manifestMessage: 'The repo has no main branch yet',
      workflows: 0,
      apps: 0,
    })

    const seeder = await GitRepo.open(
      join(dir, 'seeder'),
      { url: `file://${remote}`, token: null },
      { allowInsecure: true },
    )
    const files = {
      ...encodeObject({
        kind: 'workflow',
        slug: 'sync-orders',
        value: {
          name: 'Sync',
          description: null,
          definition: {
            schemaVersion: 1,
            blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
            edges: [],
          },
        },
      }).files,
      ...encodeObject({
        kind: 'app',
        slug: 'admin',
        value: {
          name: 'Admin',
          description: null,
          definition: { schemaVersion: 1, components: [], queries: [] },
        },
      }).files,
    }
    const noManifest = await seeder.commit({
      parent: null,
      files,
      message: 'm',
      author: { name: 'a', email: 'a@x' },
    })
    await seeder.push(noManifest!, 'main')
    expect((await admin.mutate('git.testConnection')).body.result?.data).toMatchObject({
      ok: true,
      commit: noManifest,
      branches: 1,
      manifest: 'missing',
      workflows: 1,
      apps: 1,
    })

    const withManifest = await seeder.commit({
      parent: noManifest,
      files: { 'ow.json': manifestFile() },
      message: 'm',
      author: { name: 'a', email: 'a@x' },
    })
    await seeder.push(withManifest!, 'main')
    expect((await admin.mutate('git.testConnection')).body.result?.data).toMatchObject({
      ok: true,
      commit: withManifest,
      manifest: 'present',
      manifestMessage: null,
    })
  })

  it('reports a repo it cannot reach', async () => {
    await admin.mutate('git.saveSettings', { repoUrl: `file://${join(dir, 'missing.git')}` })
    const result = (await admin.mutate('git.testConnection')).body.result?.data
    expect(result).toMatchObject({ ok: false })
    expect(['not_found', 'failed']).toContain(result.kind)
  })

  it('clears', async () => {
    expect((await admin.mutate('git.clearSettings')).body.result?.data).toMatchObject({ configured: false })
    expect((await admin.mutate('git.testConnection')).body.result?.data).toMatchObject({
      ok: false,
      kind: 'not_configured',
    })
  })

  it('never sent the token or webhook secret to the browser', () => {
    const all = bodies.join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(HOOK_SECRET)
  })
})
