import { join } from 'node:path'
import {
  auditEvents,
  configVars,
  configVarValues,
  environments,
  gitObjects,
  resourceConfigs,
  resources,
} from '@ow/db'
import { encodeSettingsDir, type Files, manifestFile, type SettingsObject } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runGitDeploy } from '../src/services/git/deploy'
import { GitRepo } from '../src/services/git/repo'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const author = { name: 'Reviewer', email: 'reviewer@optiply.nl' }

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let admin: ReturnType<typeof trpc>
let seeder: GitRepo
let envs: { id: string; slug: string }[]

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  env = await startTestApp({ GIT_ALLOW_INSECURE_URLS: 'true', GIT_CACHE_DIR: join(dir, 'cache') })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const remote = bareRepo(join(dir, 'flows.git'))
  await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}` })
  seeder = await GitRepo.open(
    join(dir, 'seeder'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
  envs = await env.db.select({ id: environments.id, slug: environments.slug }).from(environments)
  const first = await seeder.commit({
    parent: null,
    files: { 'ow.json': manifestFile() },
    message: 'Start',
    author,
  })
  expect(await seeder.push(first!, 'main')).toBe('ok')
})
afterAll(async () => {
  await env?.stop()
  await cleanup?.()
})

const deploy = (force = false) => runGitDeploy(env.db, env.config, { trigger: 'poll', force })
const envId = (slug: string) => envs.find((e) => e.slug === slug)!.id

async function pushMain(message: string, objects: SettingsObject[], raw: Record<string, Files | null> = {}) {
  const parent = await seeder.fetchBranch('main')
  const directories: Record<string, Files | null> = { ...raw }
  for (const object of objects) {
    const { dir: path, files } = encodeSettingsDir(object)
    directories[path] = files
  }
  const commit = await seeder.commit({ parent, directories, message, author })
  expect(await seeder.push(commit!, 'main')).toBe('ok')
  return commit!
}

const configVar = (
  name: string,
  value: { description?: string | null; secret?: boolean; values?: Record<string, string> },
): SettingsObject => ({
  kind: 'config_var',
  slug: name,
  value: {
    description: value.description ?? null,
    secret: value.secret ?? false,
    values: value.values ?? {},
  },
})

async function valuesOf(name: string) {
  const [variable] = await env.db.select().from(configVars).where(eq(configVars.name, name))
  const rows = await env.db
    .select()
    .from(configVarValues)
    .where(eq(configVarValues.configVarId, variable!.id))
  return {
    variable: variable!,
    values: Object.fromEntries(
      rows.map((r) => [
        envs.find((e) => e.id === r.environmentId)!.slug,
        r.local ? `${r.value} (local)` : r.value,
      ]),
    ),
  }
}

type Deployed = {
  status: string
  objects: { kind: string; slug: string; outcome: string; problems?: unknown[] }[]
}
const outcomes = (result: unknown) =>
  Object.fromEntries((result as Deployed).objects.map((o) => [`${o.kind}:${o.slug}`, o.outcome]))

describe('deploying config vars (M22)', () => {
  it('creates them protected, with their values per environment', async () => {
    await pushMain('Add config vars', [
      configVar('API_BASE', {
        description: 'Where the API is',
        values: { production: 'https://api/', staging: 'https://staging/', mars: 'x' },
      }),
      configVar('TOKEN', { secret: true }),
    ])
    const result = await deploy()
    expect(outcomes(result)).toEqual({ 'config_var:API_BASE': 'created', 'config_var:TOKEN': 'created' })
    const { variable, values } = await valuesOf('API_BASE')
    expect(variable).toMatchObject({ gitProtected: true, description: 'Where the API is', isSecret: false })
    expect(values).toEqual({ production: 'https://api/', staging: 'https://staging/' })
    expect((await valuesOf('TOKEN')).variable).toMatchObject({ gitProtected: true, isSecret: true })
    const audits = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'config_var.created'))
    expect(audits.map((a) => a.metadata)).toEqual([
      expect.objectContaining({ name: 'API_BASE', source: 'git' }),
      expect.objectContaining({ name: 'TOKEN', source: 'git' }),
    ])
  })

  it('skips unchanged ones, and updates changed ones keeping local and secret values', async () => {
    const [token] = await env.db.select().from(configVars).where(eq(configVars.name, 'TOKEN'))
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: token!.id,
        environmentId: envId('production'),
        value: 'hunter2',
      }),
    )
    const [apiBase] = await env.db.select().from(configVars).where(eq(configVars.name, 'API_BASE'))
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: apiBase!.id,
        environmentId: envId('staging'),
        value: 'http://localhost/',
        local: true,
      }),
    )
    await pushMain('Change API_BASE', [
      configVar('API_BASE', { description: 'The API', values: { staging: 'https://staging-2/' } }),
    ])
    const result = await deploy()
    expect(outcomes(result)).toEqual({ 'config_var:API_BASE': 'updated', 'config_var:TOKEN': 'unchanged' })
    const { variable, values } = await valuesOf('API_BASE')
    expect(variable.description).toBe('The API')
    // Production left Git: its value goes. Staging's is local: it stays.
    expect(values).toEqual({ staging: 'http://localhost/ (local)' })
    expect((await valuesOf('TOKEN')).values.production).toBeNull()
    const [tokenValue] = await env.db
      .select()
      .from(configVarValues)
      .where(eq(configVarValues.configVarId, token!.id))
    expect(tokenValue!.valueEncrypted).toBeTruthy()
  })

  it("brings Git's value back when a local one is removed", async () => {
    const [apiBase] = await env.db.select().from(configVars).where(eq(configVars.name, 'API_BASE'))
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: apiBase!.id,
        environmentId: envId('staging'),
        value: null,
      }),
    )
    const result = await deploy(true)
    expect(outcomes(result)['config_var:API_BASE']).toBe('updated')
    expect((await valuesOf('API_BASE')).values).toEqual({ staging: 'https://staging-2/' })
  })

  it("refuses one that isn't protected, or would flip secret, and keeps the rest", async () => {
    data(await admin.mutate('configVars.create', { name: 'MINE' }))
    await pushMain('More', [
      configVar('MINE', { values: { production: 'x' } }),
      configVar('API_BASE', { secret: true }),
      configVar('NEW_ONE', { values: { production: 'y' } }),
    ])
    const result = (await deploy()) as Deployed
    expect(outcomes(result)).toMatchObject({
      'config_var:MINE': 'problem',
      'config_var:API_BASE': 'problem',
      'config_var:NEW_ONE': 'created',
    })
    const problems = Object.fromEntries(result.objects.map((o) => [o.slug, JSON.stringify(o.problems ?? [])]))
    expect(problems.MINE).toContain('not_protected')
    expect(problems.API_BASE).toContain("can't change")
    const [row] = await env.db.select().from(gitObjects).where(eq(gitObjects.slug, 'MINE'))
    expect(row).toMatchObject({ kind: 'config_var', status: 'problem' })
  })

  it('flags a directory that left the branch, and keeps the config var', async () => {
    await pushMain('Remove NEW_ONE', [], { 'config-vars/NEW_ONE': null })
    const result = await deploy()
    expect(outcomes(result)['config_var:NEW_ONE']).toBe('missing')
    expect((await valuesOf('NEW_ONE')).values).toEqual({ production: 'y' })
  })
})

function data(res: { body: { result?: { data: unknown }; error?: unknown } }) {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data as never
}

const resource = (
  slug: string,
  environmentsOf: Record<string, Record<string, unknown>>,
  extra: { name?: string; type?: string; description?: string | null } = {},
): SettingsObject => ({
  kind: 'resource',
  slug,
  value: {
    name: extra.name ?? slug,
    description: extra.description ?? null,
    type: extra.type ?? 'postgres',
    environments: Object.fromEntries(Object.entries(environmentsOf).map(([e, config]) => [e, { config }])),
  },
})
const pg = (host: string) => ({ host, port: 5432, database: 'orders', user: 'app' })

type ResourceView = {
  id: string
  gitProtected: boolean
  name: string
  environments: {
    environmentId: string
    config: Record<string, unknown> | null
    overrides: Record<string, unknown> | null
    secretsSet: boolean
    needsSecrets: boolean
  }[]
}
async function resourceView(slug: string) {
  const [row] = await env.db.select().from(resources).where(eq(resources.slug, slug))
  const view = data(await admin.query('resources.get', { id: row!.id })) as ResourceView
  const at = (envSlug: string) => view.environments.find((e) => e.environmentId === envId(envSlug))!
  return { view, at }
}

describe('deploying resources (M22)', () => {
  it('creates them protected with each environment Git configures, needing secrets', async () => {
    await pushMain('Add resources', [
      resource(
        'orders_db',
        { production: pg('db.internal'), staging: pg('db.staging') },
        { name: 'Orders DB' },
      ),
      resource('warehouse', { production: { projectId: 'optiply-dw' } }, { type: 'bigquery' }),
    ])
    const result = await deploy()
    expect(outcomes(result)).toMatchObject({
      'resource:orders_db': 'created',
      'resource:warehouse': 'created',
    })
    const { view, at } = await resourceView('orders_db')
    expect(view).toMatchObject({ gitProtected: true, name: 'Orders DB' })
    expect(at('production')).toMatchObject({
      config: pg('db.internal'),
      secretsSet: false,
      needsSecrets: false,
    })
    expect((await resourceView('warehouse')).at('production').needsSecrets).toBe(true)
  })

  it('updates configs keeping secrets and overrides, and drops environments Git left', async () => {
    const { view } = await resourceView('orders_db')
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: view.id,
        environmentId: envId('production'),
        config: pg('db.internal'),
        secrets: { password: 'mine' },
      }),
    )
    data(
      await admin.mutate('resources.setOverrides', {
        resourceId: view.id,
        environmentId: envId('production'),
        overrides: { host: 'localhost' },
      }),
    )
    await pushMain('Move orders DB', [
      resource(
        'orders_db',
        { production: { ...pg('db2.internal'), database: 'orders2' } },
        { name: 'Orders' },
      ),
    ])
    const result = await deploy()
    expect(outcomes(result)).toMatchObject({
      'resource:orders_db': 'updated',
      'resource:warehouse': 'unchanged',
    })
    const { view: after, at } = await resourceView('orders_db')
    expect(after.name).toBe('Orders')
    expect(at('production')).toMatchObject({
      config: { host: 'db2.internal', database: 'orders2' },
      overrides: { host: 'localhost' },
      secretsSet: true,
    })
    expect(at('staging').config).toBeNull()
    const audits = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'resource.updated'))
    expect(audits.at(-1)!.metadata).toMatchObject({ slug: 'orders_db', source: 'git' })
  })

  it('refuses a type change, a bad config, overrides that no longer fit, an unprotected one; the rest deploys', async () => {
    data(await admin.mutate('resources.create', { type: 'postgres', name: 'Mine', slug: 'mine_db' }))
    // An override the next settings can't take (the connector would refuse the result).
    const { view } = await resourceView('orders_db')
    await env.db
      .update(resourceConfigs)
      .set({ overrides: { port: 'not a port' } })
      .where(eq(resourceConfigs.resourceId, view.id))
    await pushMain('Broken', [
      resource('warehouse', { production: pg('x') }, { type: 'postgres' }),
      resource('mine_db', { production: pg('y') }),
      resource('bad_config', { production: { host: 5 } }),
      resource('orders_db', { production: pg('db3') }),
      resource('fresh_db', { staging: pg('fresh') }),
    ])
    const result = (await deploy()) as Deployed
    expect(outcomes(result)).toMatchObject({
      'resource:warehouse': 'problem',
      'resource:mine_db': 'problem',
      'resource:bad_config': 'problem',
      'resource:fresh_db': 'created',
    })
    const problems = Object.fromEntries(result.objects.map((o) => [o.slug, JSON.stringify(o.problems ?? [])]))
    expect(problems.warehouse).toContain("type can't change")
    expect(problems.mine_db).toContain('not_protected')
    expect(problems.bad_config).toContain('production: host')
    // The resource with nothing written for a problem stays as it was.
    expect((await resourceView('warehouse')).at('production').config).toMatchObject({
      projectId: 'optiply-dw',
    })
    expect(outcomes(result)['resource:orders_db']).toBe('problem')
    expect(problems.orders_db).toContain('override_conflict')
    expect((await resourceView('orders_db')).at('production').config).toMatchObject({ host: 'db2.internal' })
  })
})
