import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { auditEvents, configVars, configVarValues, resourceConfigs, resources } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepo } from '../src/services/git/repo'
import { applyOverrides, effectiveConfig } from '../src/services/resources'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const TOKEN = 'ghp_settings_tests'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberGroupId: string
let remote: string
let reader: GitRepo
let envs: { id: string; slug: string }[]

const data = (res: { body: { result?: { data: unknown }; error?: unknown } }) => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data as never
}
const code = (res: { body: { error?: { data?: { code: string } } } }) => res.body.error?.data?.code
const envId = (slug: string) => envs.find((e) => e.slug === slug)!.id

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply'))
  remote = bareRepo(join(dir, 'optiply', 'flows.git'))
  github = await fakeGitHub({ repoPath: remote, owner: 'optiply', repo: 'flows', token: TOKEN })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITHUB_API_URL: github.url,
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' }))['id' as never]
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
  envs = data(await admin.query('environments.list'))
  reader = await GitRepo.open(
    join(dir, 'reader'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
  data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: TOKEN }))
})
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

async function filesOn(branch: string, root: string) {
  const tip = await reader.fetchBranch(branch)
  return reader.readFiles(tip!, [root])
}

describe('protecting a resource (M22)', () => {
  let resourceId: string

  it('needs Own in every environment', async () => {
    const outer: { id: string } = data(
      await admin.mutate('folders.create', { name: 'Finance', type: 'resource' }),
    )
    const inner: { id: string } = data(
      await admin.mutate('folders.create', { name: 'Reports 2026', type: 'resource', parentId: outer.id }),
    )
    const created: { id: string } = data(
      await admin.mutate('resources.create', {
        type: 'postgres',
        name: 'Orders DB',
        slug: 'orders_db',
        folderId: inner.id,
      }),
    )
    resourceId = created.id
    for (const [slug, host] of [
      ['production', 'db.internal'],
      ['staging', 'db.staging'],
    ] as const) {
      data(
        await admin.mutate('resources.saveConfig', {
          resourceId,
          environmentId: envId(slug),
          config: { host, port: 5432, database: 'orders', user: 'app' },
          secrets: { password: `secret-${slug}` },
        }),
      )
    }
    expect(code(await member.mutate('git.protectSettings', { kind: 'resource', id: resourceId }))).toBe(
      'NOT_FOUND',
    )
    await admin.mutate('permissions.set', {
      objectType: 'resource',
      objectId: resourceId,
      groupId: memberGroupId,
      environmentId: envId('production'),
      level: 'own',
    })
    expect(code(await member.mutate('git.protectSettings', { kind: 'resource', id: resourceId }))).toBe(
      'FORBIDDEN',
    )
  })

  it('commits its settings without secrets, with its folder, and opens a pull request', async () => {
    const result = data(await admin.mutate('git.protectSettings', { kind: 'resource', id: resourceId })) as {
      branch: string
      pullRequest: { number: number; head: string }
    }
    expect(result.branch).toBe('protect/resource-orders_db')
    expect(result.pullRequest.head).toBe('protect/resource-orders_db')
    expect(github.pulls.at(-1)).toMatchObject({ title: 'Protect resource "Orders DB"' })

    const files = await filesOn(result.branch, 'resources/')
    expect(Object.keys(files)).toEqual(['resources/orders_db/resource.json'])
    const json = JSON.parse(files['resources/orders_db/resource.json']!)
    expect(json).toMatchObject({
      name: 'Orders DB',
      folder: 'Finance/Reports 2026',
      type: 'postgres',
      environments: {
        production: { config: { host: 'db.internal', port: 5432, database: 'orders', user: 'app' } },
        staging: { config: { host: 'db.staging' } },
      },
    })
    expect(files['resources/orders_db/resource.json']).not.toContain('secret-')

    const [row] = await env.db.select().from(resources).where(eq(resources.id, resourceId))
    expect(row!.gitProtected).toBe(true)
    const audits = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'resource.protected'))
    expect(audits[0]!.metadata).toMatchObject({ branch: 'protect/resource-orders_db' })
  })

  it('refuses protecting twice, and unprotecting leaves the files', async () => {
    expect(code(await admin.mutate('git.protectSettings', { kind: 'resource', id: resourceId }))).toBe(
      'CONFLICT',
    )
    data(await admin.mutate('git.unprotectSettings', { kind: 'resource', id: resourceId }))
    const [row] = await env.db.select().from(resources).where(eq(resources.id, resourceId))
    expect(row!.gitProtected).toBe(false)
    expect(Object.keys(await filesOn('protect/resource-orders_db', 'resources/'))).toEqual([
      'resources/orders_db/resource.json',
    ])
    expect(code(await admin.mutate('git.unprotectSettings', { kind: 'resource', id: resourceId }))).toBe(
      'CONFLICT',
    )
  })

  it('keeps the built-in database resource on each instance', async () => {
    const [builtIn] = await env.db.select().from(resources).where(eq(resources.systemKind, 'database'))
    if (!builtIn) return
    expect(code(await admin.mutate('git.protectSettings', { kind: 'resource', id: builtIn.id }))).toBe(
      'BAD_REQUEST',
    )
  })
})

describe('protecting a config var (M22)', () => {
  it('is for admins, and commits non-secret values that are not local', async () => {
    const created: { id: string } = data(
      await admin.mutate('configVars.create', { name: 'API_BASE', description: 'Where the API is' }),
    )
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: created.id,
        environmentId: envId('production'),
        value: 'https://api.example.com/',
      }),
    )
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: created.id,
        environmentId: envId('staging'),
        value: 'http://localhost:4000/',
      }),
    )
    // Staging's value is this instance's own: it stays out of Git.
    await env.db
      .update(configVarValues)
      .set({ local: true })
      .where(eq(configVarValues.environmentId, envId('staging')))

    expect(code(await member.mutate('git.protectSettings', { kind: 'config_var', id: created.id }))).toBe(
      'FORBIDDEN',
    )
    const result = data(
      await admin.mutate('git.protectSettings', { kind: 'config_var', id: created.id }),
    ) as {
      branch: string
    }
    expect(result.branch).toBe('protect/config-var-API_BASE')
    const files = await filesOn(result.branch, 'config-vars/')
    expect(JSON.parse(files['config-vars/API_BASE/config-var.json']!)).toEqual({
      description: 'Where the API is',
      secret: false,
      values: { production: 'https://api.example.com/' },
    })
    const [row] = await env.db.select().from(configVars).where(eq(configVars.id, created.id))
    expect(row!.gitProtected).toBe(true)
  })

  it('commits a secret one without its values', async () => {
    const created: { id: string } = data(
      await admin.mutate('configVars.create', { name: 'TOKEN', isSecret: true }),
    )
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: created.id,
        environmentId: envId('production'),
        value: 'hunter2',
      }),
    )
    const result = data(
      await admin.mutate('git.protectSettings', { kind: 'config_var', id: created.id }),
    ) as {
      branch: string
    }
    const files = await filesOn(result.branch, 'config-vars/')
    expect(files['config-vars/TOKEN/config-var.json']).toBe('{\n  "secret": true\n}\n')
  })
})

describe('on main, protected (M22)', () => {
  let resourceId: string
  const prod = () => envId('production')
  const getResource = async () =>
    data(await admin.query('resources.get', { id: resourceId })) as {
      environments: {
        environmentId: string
        config: Record<string, unknown>
        overrides: Record<string, unknown>
      }[]
    }

  it('refuses changing what Git holds of a resource, and takes its secrets', async () => {
    const [row] = await env.db.select().from(resources).where(eq(resources.slug, 'orders_db'))
    resourceId = row!.id
    await env.db.update(resources).set({ gitProtected: true }).where(eq(resources.id, resourceId))
    const config = { host: 'db.internal', port: 5432, database: 'orders', user: 'app' }
    expect(
      code(await admin.mutate('resources.update', { id: resourceId, name: 'Renamed', description: null })),
    ).toBe('PRECONDITION_FAILED')
    expect(code(await admin.mutate('resources.delete', { id: resourceId }))).toBe('PRECONDITION_FAILED')
    expect(code(await admin.mutate('resources.deleteConfig', { resourceId, environmentId: prod() }))).toBe(
      'PRECONDITION_FAILED',
    )
    const changed = await admin.mutate('resources.saveConfig', {
      resourceId,
      environmentId: prod(),
      config: { ...config, host: 'elsewhere' },
    })
    expect(code(changed)).toBe('PRECONDITION_FAILED')
    expect(JSON.stringify(changed.body)).toContain('secrets and overrides here')
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prod(),
        config,
        secrets: { password: 'rotated' },
      }),
    )
    const [stored] = await env.db
      .select()
      .from(resourceConfigs)
      .where(eq(resourceConfigs.resourceId, resourceId))
    expect(stored).toBeDefined()
  })

  it('overrides single fields of a protected resource on this instance', async () => {
    data(
      await admin.mutate('resources.setOverrides', {
        resourceId,
        environmentId: prod(),
        overrides: { host: 'db.local', port: 6543 },
      }),
    )
    const view = (await getResource()).environments.find((e) => e.environmentId === prod())!
    expect(view.config.host).toBe('db.internal')
    expect(view.overrides).toEqual({ host: 'db.local', port: 6543 })
    const [row] = await env.db
      .select()
      .from(resourceConfigs)
      .where(and(eq(resourceConfigs.environmentId, prod()), eq(resourceConfigs.resourceId, resourceId)))
    expect(effectiveConfig(row!)).toMatchObject({ host: 'db.local', port: 6543, database: 'orders' })
    expect(
      code(
        await admin.mutate('resources.setOverrides', {
          resourceId,
          environmentId: prod(),
          overrides: { nope: 1 },
        }),
      ),
    ).toBe('BAD_REQUEST')
    expect(
      code(
        await admin.mutate('resources.setOverrides', {
          resourceId,
          environmentId: prod(),
          overrides: { port: 'x' },
        }),
      ),
    ).toBe('BAD_REQUEST')
    data(await admin.mutate('resources.setOverrides', { resourceId, environmentId: prod(), overrides: {} }))
    expect((await getResource()).environments.find((e) => e.environmentId === prod())!.overrides).toEqual({})
  })

  it('keeps overrides to protected resources', async () => {
    const other: { id: string } = data(
      await admin.mutate('resources.create', { type: 'postgres', name: 'Plain', slug: 'plain_db' }),
    )
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: other.id,
        environmentId: prod(),
        config: { host: 'h', port: 5432, database: 'd', user: 'u' },
      }),
    )
    expect(
      code(
        await admin.mutate('resources.setOverrides', {
          resourceId: other.id,
          environmentId: prod(),
          overrides: { host: 'x' },
        }),
      ),
    ).toBe('PRECONDITION_FAILED')
  })

  it("takes a protected config var's local values and secret values, nothing else", async () => {
    const vars = data(await admin.query('configVars.list')) as {
      id: string
      name: string
      gitProtected: boolean
      values: Record<string, { value?: string; local?: true }>
    }[]
    const apiBase = vars.find((v) => v.name === 'API_BASE')!
    const token = vars.find((v) => v.name === 'TOKEN')!
    expect(apiBase.gitProtected).toBe(true)
    expect(apiBase.values[envId('staging')]).toEqual({ value: 'http://localhost:4000/', local: true })
    expect(code(await admin.mutate('configVars.update', { id: apiBase.id, description: 'x' }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect(code(await admin.mutate('configVars.delete', { id: apiBase.id }))).toBe('PRECONDITION_FAILED')
    const set = (value: string | null, local?: boolean) =>
      admin.mutate('configVars.setValue', {
        configVarId: apiBase.id,
        environmentId: prod(),
        value,
        ...(local === undefined ? {} : { local }),
      })
    expect(code(await set('https://other/'))).toBe('PRECONDITION_FAILED')
    expect(code(await set(null))).toBe('PRECONDITION_FAILED')
    data(await set('https://mine/', true))
    const after = (data(await admin.query('configVars.list')) as typeof vars).find(
      (v) => v.name === 'API_BASE',
    )!
    expect(after.values[prod()]).toEqual({ value: 'https://mine/', local: true })
    data(await set(null))
    const cleared = (data(await admin.query('configVars.list')) as typeof vars).find(
      (v) => v.name === 'API_BASE',
    )!
    expect(cleared.values[prod()]).toBeUndefined()
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: token.id,
        environmentId: prod(),
        value: 'rotated',
      }),
    )
  })
})

describe('applyOverrides', () => {
  it('sets values at paths, making objects on the way, without touching the config', () => {
    const config = { host: 'a', ssh: { host: 'b', port: 22 }, list: [1] }
    expect(
      applyOverrides(config, { host: 'x', 'ssh.host': 'y', 'list.first': 1, 'new.deep.key': true }),
    ).toEqual({
      host: 'x',
      ssh: { host: 'y', port: 22 },
      list: { first: 1 },
      new: { deep: { key: true } },
    })
    expect(config).toEqual({ host: 'a', ssh: { host: 'b', port: 22 }, list: [1] })
    expect(applyOverrides(config, {})).toBe(config)
  })
})
