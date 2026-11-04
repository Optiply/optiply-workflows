import { join } from 'node:path'
import { auditEvents, folders, gitObjects, resources, workflows } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import {
  encodeObjectDir,
  encodeSettingsDir,
  type Files,
  manifestFile,
  type RepoObject,
  type SettingsObject,
} from '@ow/git-format'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runGitDeploy } from '../src/services/git/deploy'
import { folderPathOf } from '../src/services/git/folders'
import { GitRepo } from '../src/services/git/repo'
import { clearGitSettings } from '../src/services/git/settings'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const author = { name: 'Reviewer', email: 'reviewer@optiply.nl' }

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let seeder: GitRepo

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  env = await startTestApp({ GIT_ALLOW_INSECURE_URLS: 'true', GIT_CACHE_DIR: join(dir, 'cache') })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const remote = bareRepo(join(dir, 'flows.git'))
  await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}` })
  seeder = await GitRepo.open(
    join(dir, 'seeder'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
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

const deploy = () => runGitDeploy(env.db, env.config, { trigger: 'poll' })

async function pushMain(message: string, objects: Array<RepoObject | SettingsObject>) {
  const parent = await seeder.fetchBranch('main')
  const directories: Record<string, Files | null> = {}
  for (const object of objects) {
    const { dir: path, files } =
      object.kind === 'resource' || object.kind === 'config_var'
        ? encodeSettingsDir(object as SettingsObject)
        : encodeObjectDir(object as RepoObject)
    directories[path] = files
  }
  const commit = await seeder.commit({ parent, directories, message, author })
  expect(await seeder.push(commit!, 'main')).toBe('ok')
}

/** `folder` left out: a file from before M22, which names none; null: the top level. */
const workflow = (slug: string, folder?: string | null, code = 'return 1'): RepoObject => ({
  kind: 'workflow',
  slug,
  value: {
    name: slug,
    description: null,
    ...(folder !== undefined ? { folder } : {}),
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'step', type: 'code', config: { code } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'step' }],
    } as WorkflowDefinition,
  },
})

const resource = (slug: string, folder?: string | null): SettingsObject => ({
  kind: 'resource',
  slug,
  value: {
    name: slug,
    description: null,
    ...(folder !== undefined ? { folder } : {}),
    type: 'postgres',
    environments: { production: { config: { host: 'db', port: 5432, database: 'orders', user: 'app' } } },
  },
})

type Deployed = {
  objects: { kind: string; slug: string; outcome: string; folder?: unknown }[]
}
const outcomeOf = (result: unknown, kind: string, slug: string) =>
  (result as Deployed).objects.find((o) => o.kind === kind && o.slug === slug)

async function folderOf(table: typeof workflows | typeof resources, slug: string) {
  const [row] = await env.db.select({ folderId: table.folderId }).from(table).where(eq(table.slug, slug))
  return (await folderPathOf(env.db, row!.folderId)) ?? null
}

describe('folders from Git (M22)', () => {
  it('puts new objects into their Git folders, making the folders of their kind', async () => {
    await pushMain('Add filed objects', [
      workflow('nightly', 'Finance/Reports'),
      resource('orders', 'Finance'),
    ])
    const result = await deploy()
    expect(outcomeOf(result, 'workflow', 'nightly')).toMatchObject({ outcome: 'created' })
    expect(outcomeOf(result, 'resource', 'orders')).toMatchObject({ outcome: 'created' })
    expect(await folderOf(workflows, 'nightly')).toBe('Finance/Reports')
    expect(await folderOf(resources, 'orders')).toBe('Finance')
    // A workflow folder and a resource folder named alike are different folders.
    const finance = await env.db.select().from(folders).where(eq(folders.name, 'Finance'))
    expect(finance.map((f) => f.objectType).sort()).toEqual(['resource', 'workflow'])
    const made = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'folder.created'))
    expect(made).toHaveLength(3)
    expect(made[0]!.metadata).toMatchObject({ source: 'git' })
  })

  it('moves an object when only its folder changed in Git, and to the top when the folder goes', async () => {
    await pushMain('Move them', [workflow('nightly', 'Ops'), resource('orders', 'Finance/Databases')])
    let result = await deploy()
    expect(outcomeOf(result, 'workflow', 'nightly')).toMatchObject({
      outcome: 'updated',
      folder: { from: 'Finance/Reports', to: 'Ops' },
    })
    expect(outcomeOf(result, 'resource', 'orders')).toMatchObject({
      outcome: 'updated',
      folder: { from: 'Finance', to: 'Finance/Databases' },
    })
    expect(await folderOf(workflows, 'nightly')).toBe('Ops')
    expect(await folderOf(resources, 'orders')).toBe('Finance/Databases')
    // The folder it left stays.
    const reports = await env.db
      .select()
      .from(folders)
      .where(and(eq(folders.name, 'Reports'), eq(folders.objectType, 'workflow')))
    expect(reports).toHaveLength(1)

    await pushMain('To the top', [workflow('nightly', null, 'return 2'), resource('orders', null)])
    result = await deploy()
    expect(outcomeOf(result, 'workflow', 'nightly')).toMatchObject({
      outcome: 'released',
      folder: { from: 'Ops', to: null },
    })
    expect(outcomeOf(result, 'resource', 'orders')).toMatchObject({
      outcome: 'updated',
      folder: { from: 'Finance/Databases', to: null },
    })
    expect(await folderOf(workflows, 'nightly')).toBeNull()
    expect(await folderOf(resources, 'orders')).toBeNull()
  })

  it('uses the folders already there', async () => {
    await pushMain('Another in Ops', [workflow('hourly', 'Ops')])
    expect(outcomeOf(await deploy(), 'workflow', 'hourly')).toMatchObject({ outcome: 'created' })
    const ops = await env.db
      .select()
      .from(folders)
      .where(and(eq(folders.name, 'Ops'), eq(folders.objectType, 'workflow')))
    expect(ops).toHaveLength(1)
    expect(await folderOf(workflows, 'hourly')).toBe('Ops')
  })

  it('leaves an object where it is when its file names no folder (written before M22)', async () => {
    await pushMain('Into Ops', [workflow('legacy', 'Ops')])
    expect(outcomeOf(await deploy(), 'workflow', 'legacy')).toMatchObject({ outcome: 'created' })
    // A pre-M22 instance commits a change: its file has no folder key.
    await pushMain('An edit from before M22', [workflow('legacy', undefined, 'return 3')])
    const result = await deploy()
    expect(outcomeOf(result, 'workflow', 'legacy')).toMatchObject({ outcome: 'released' })
    expect(outcomeOf(result, 'workflow', 'legacy')!.folder).toBeUndefined()
    expect(await folderOf(workflows, 'legacy')).toBe('Ops')
    // Deploy now redeploys every directory: still there.
    await runGitDeploy(env.db, env.config, { trigger: 'manual', force: true })
    expect(await folderOf(workflows, 'legacy')).toBe('Ops')
  })

  it('leaves an object with problems where it is', async () => {
    const broken = workflow('hourly', 'Elsewhere')
    ;(broken.value.definition as WorkflowDefinition).edges = [
      { from: 'startTrigger', port: 'out', to: 'nowhere' },
    ]
    await pushMain('Break it', [broken])
    expect(outcomeOf(await deploy(), 'workflow', 'hourly')).toMatchObject({ outcome: 'problem' })
    expect(await folderOf(workflows, 'hourly')).toBe('Ops')
  })
})

describe('the deploy state of objects that go (M22 review)', () => {
  const rowsOf = async (slug: string) => env.db.select().from(gitObjects).where(eq(gitObjects.slug, slug))

  it('goes with an object deleted on the instance, however it was deleted', async () => {
    await pushMain('One to delete', [workflow('doomed', null)])
    await deploy()
    expect(await rowsOf('doomed')).toHaveLength(1)
    await env.db.delete(workflows).where(eq(workflows.slug, 'doomed'))
    expect(await rowsOf('doomed')).toHaveLength(0)
  })

  it('all goes when the Git settings are cleared', async () => {
    expect((await env.db.select().from(gitObjects)).length).toBeGreaterThan(0)
    expect(await clearGitSettings(env.db)).toBe(true)
    expect(await env.db.select().from(gitObjects)).toEqual([])
  })
})
