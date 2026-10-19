import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepo } from '../src/services/git/repo'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/** Library queries and modules in Git (M14 step 7b): protected, guarded, edited and run in branch drafts. */

const TOKEN = 'ghp_library_module_tests'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let admin: ReturnType<typeof trpc>
let other: GitRepo
let prodId: string
let queryId: string
let moduleId: string

// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
const data = (res: { body: { result?: { data: unknown }; error?: unknown } }): any => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data
}
const failure = (res: { body: { error?: { message: string; data?: { code: string } } } }) => ({
  code: res.body.error?.data?.code,
  message: res.body.error?.message,
})

const plusOne = (n: number) => ({
  schemaVersion: 1,
  resource: 'optiply_db',
  query: { sql: `select {{ n }}::int + ${n} as x` },
  params: [{ name: 'n', testValue: 41 }],
})

const badge = (tag: string, withModule = true) => ({
  schemaVersion: 1,
  components: [{ name: 'label', type: 'text', props: { value: '{{ regions.data[0].region }}' } }],
  queries: [
    {
      name: 'regions',
      kind: 'resource',
      resource: 'optiply_db',
      query: { sql: `select {{ inputs.region }}::text as region, '${tag}' as tag` },
      run: 'auto',
    },
  ],
  layout: { label: { x: 0, y: 0, w: 6, h: 2 } },
  ...(withModule && { module: { inputs: [{ name: 'region', default: 'EU' }], outputs: [], events: [] } }),
})

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply'))
  const remote = bareRepo(join(dir, 'optiply', 'flows.git'))
  github = await fakeGitHub({ repoPath: remote, owner: 'optiply', repo: 'flows', token: TOKEN })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITHUB_API_URL: github.url,
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: TOKEN }))
  other = await GitRepo.open(
    join(dir, 'other'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id

  queryId = data(await admin.mutate('libraryQueries.create', { slug: 'plus_one', name: 'Plus one' })).id
  data(await admin.mutate('libraryQueries.saveDraft', { id: queryId, revision: 1, definition: plusOne(1) }))
  data(await admin.mutate('libraryQueries.publish', { libraryQueryId: queryId, draftRevision: 2 }))
  moduleId = data(await admin.mutate('modules.create', { slug: 'badge', name: 'Badge' })).id
  data(await admin.mutate('modules.saveDraft', { id: moduleId, revision: 1, definition: badge('v1') }))
  data(await admin.mutate('modules.publish', { moduleId, draftRevision: 2 }))
})
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

describe('library queries and modules in Git', () => {
  it('protect onto a branch, as their directories, with a pull request', async () => {
    const query = data(await admin.mutate('git.protect', { kind: 'library_query', id: queryId }))
    expect(query.branch).toBe('protect/library_query-plus_one')
    expect(query.pullRequest).toMatchObject({ number: 1 })
    const files = await other.readFiles((await other.fetchBranch(query.branch))!, ['library/'])
    expect(Object.keys(files)).toEqual(['library/plus_one/query.json', 'library/plus_one/query.sql'])
    expect(files['library/plus_one/query.sql']).toBe('select {{ n }}::int + 1 as x\n')

    const module = data(await admin.mutate('git.protect', { kind: 'module', id: moduleId }))
    expect(module.branch).toBe('protect/module-badge')
    expect(
      Object.keys(await other.readFiles((await other.fetchBranch(module.branch))!, ['modules/'])),
    ).toEqual(['modules/badge/layout.json', 'modules/badge/module.json', 'modules/badge/queries/regions.sql'])
    expect(failure(await admin.mutate('git.protect', { kind: 'module', id: moduleId }))).toEqual({
      code: 'CONFLICT',
      message: 'This module is already protected',
    })
  })

  it('are then changed on branches only; admins can still roll back', async () => {
    expect(
      failure(
        await admin.mutate('libraryQueries.saveDraft', { id: queryId, revision: 2, definition: plusOne(2) }),
      ),
    ).toEqual({
      code: 'PRECONDITION_FAILED',
      message: 'This library query is protected: edit it on a Git branch, and merge it to deploy',
    })
    expect(failure(await admin.mutate('modules.publish', { moduleId, draftRevision: 2 })).message).toBe(
      'This module is protected: publish it on a Git branch, and merge it to deploy',
    )
    expect(failure(await admin.mutate('modules.update', { id: moduleId, name: 'Badge 2' })).code).toBe(
      'PRECONDITION_FAILED',
    )
    const releases = data(await admin.query('modules.releases', { moduleId }))
    data(await admin.mutate('modules.setLive', { moduleId, releaseId: releases[0].id }))
  })

  it('are edited in branch drafts, run from them, and committed', async () => {
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'module',
        id: moduleId,
        branch: 'fabio/badge',
        create: true,
      }),
    )
    expect(draft).toMatchObject({
      kind: 'module',
      objectId: moduleId,
      name: 'Badge',
      revision: 1,
      diagnostics: [],
    })
    expect(
      failure(
        await admin.mutate('branchDrafts.save', {
          id: draft.id,
          revision: 1,
          definition: badge('v2', false),
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('A module needs its inputs') })
    data(await admin.mutate('branchDrafts.save', { id: draft.id, revision: 1, definition: badge('v2') }))

    // The editor runs the branch draft's queries, the main draft's otherwise.
    const run = (branchDraftId?: string) =>
      admin.mutate('modules.runQuery', {
        moduleId,
        ...(branchDraftId && { branchDraftId }),
        query: 'regions',
        environmentId: prodId,
        values: { ' inputs.region ': 'US' },
      })
    expect(data(await run(draft.id))).toMatchObject({ ok: true, data: [{ region: 'US', tag: 'v2' }] })
    expect(data(await run())).toMatchObject({ ok: true, data: [{ tag: 'v1' }] })

    const changes = data(await admin.query('branchDrafts.changes', { id: draft.id }))
    expect(changes.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ['modules/badge/layout.json', 'added'],
      ['modules/badge/module.json', 'added'],
      ['modules/badge/queries/regions.sql', 'added'],
    ])
    const committed = data(
      await admin.mutate('branchDrafts.commit', { id: draft.id, revision: 2, message: 'Badge v2' }),
    )
    expect(committed.changed).toBe(true)
    const tip = await other.fetchBranch('fabio/badge')
    expect((await other.readFiles(tip!, ['modules/']))['modules/badge/queries/regions.sql']).toContain("'v2'")

    // A library query's draft runs with its test values.
    const queryDraft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'library_query',
        id: queryId,
        branch: 'fabio/plus-two',
        create: true,
      }),
    )
    data(await admin.mutate('branchDrafts.save', { id: queryDraft.id, revision: 1, definition: plusOne(2) }))
    const runQuery = (branchDraftId?: string) =>
      admin.mutate('libraryQueries.run', {
        libraryQueryId: queryId,
        ...(branchDraftId && { branchDraftId }),
        environmentId: prodId,
      })
    expect(data(await runQuery(queryDraft.id))).toMatchObject({ ok: true, data: [{ x: 43 }] })
    expect(data(await runQuery())).toMatchObject({ ok: true, data: [{ x: 42 }] })
    // Another object's draft isn't this one's.
    expect(failure(await runQuery(draft.id))).toEqual({
      code: 'NOT_FOUND',
      message: 'This library query has no such branch draft',
    })
    expect(data(await admin.query('branchDrafts.list', { kind: 'library_query', id: queryId }))).toEqual([
      expect.objectContaining({ id: queryDraft.id, branch: 'fabio/plus-two' }),
    ])
  })

  it('unprotect to be edited here again', async () => {
    data(await admin.mutate('git.unprotect', { kind: 'library_query', id: queryId }))
    data(await admin.mutate('libraryQueries.saveDraft', { id: queryId, revision: 2, definition: plusOne(2) }))
  })
})
