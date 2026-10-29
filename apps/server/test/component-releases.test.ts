import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { emptyComponentLibrary } from '@ow/app-definition'
import { auditEvents, componentBundles } from '@ow/db'
import { encodeObjectDir, type RepoObject } from '@ow/git-format'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteUnusedBundles } from '../src/services/component-libraries'
import { runGitDeploy } from '../src/services/git/deploy'
import { GitRepo } from '../src/services/git/repo'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * Component library releases (M25 step 3b-2): publishing builds, allowed origins need an admin, what a release
 * drops for apps on `latest`, uploaded builds, unused bundles going, and deploying from Git.
 */

const TOKEN = 'ghp_component_library_tests'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let other: GitRepo
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberGroupId: string

type Res = {
  status: number
  body: { result?: { data: unknown }; error?: { message: string; data?: { code: string } } }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}
const failure = (res: Res) => ({ code: res.body.error?.data?.code, message: res.body.error?.message })

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply'))
  const remote = bareRepo(join(dir, 'optiply', 'flows.git'))
  github = await fakeGitHub({ repoPath: remote, owner: 'optiply', repo: 'flows', token: TOKEN })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITHUB_API_URL: github.url,
    COMPONENT_BUILD_DIR: join(dir, 'builds'),
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Builders' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
  data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: TOKEN }))
  other = await GitRepo.open(
    join(dir, 'other'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
}, 60_000)
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

/** A library and a way to save its next draft (tracking the revision). */
async function library(slug: string) {
  const { id } = data(await admin.mutate('componentLibraries.create', { slug, name: slug }))
  let revision = 1
  const save = async (edit: (def: ReturnType<typeof emptyComponentLibrary>) => void, as = admin) => {
    const def = data(await as.query('componentLibraries.get', { id })).draftDefinition
    edit(def)
    revision = data(
      await as.mutate('componentLibraries.saveDraft', { id, revision, definition: def }),
    ).revision
    return revision
  }
  const publish = (as = admin) =>
    as.mutate('componentLibraries.publish', { componentLibraryId: id, draftRevision: revision })
  return { id: id as string, save, publish }
}

describe('component library releases', () => {
  it('builds and publishes 1.0.0, refuses an unchanged one, and rolls back', async () => {
    const lib = await library('releasing')
    const first = data(await lib.publish())
    expect(first).toMatchObject({ version: '1.0.0', bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(failure(await lib.publish())).toMatchObject({ code: 'CONFLICT' })
    await lib.save((def) => {
      def.components[0]!.label = 'Hello there'
    })
    expect(data(await lib.publish()).version).toBe('1.0.1')
    const releases = data(await admin.query('componentLibraries.releases', { componentLibraryId: lib.id }))
    expect(releases.map((r: { version: string; live: boolean }) => [r.version, r.live])).toEqual([
      ['1.0.1', true],
      ['1.0.0', false],
    ])
    expect(releases[0].components.Hello).toMatchObject({ label: 'Hello there', events: ['click'] })
    data(
      await admin.mutate('componentLibraries.setLive', { componentLibraryId: lib.id, releaseId: first.id }),
    )
    expect(data(await admin.query('componentLibraries.get', { id: lib.id })).liveRelease.version).toBe(
      '1.0.0',
    )
  })

  it('refuses publishing a draft that doesn’t build, saying where', async () => {
    const lib = await library('broken-release')
    await lib.save((def) => {
      def.files[0]!.content = 'export default function Hello() {\n  return <b>{oops(</b>\n}'
    })
    const refused = failure(await lib.publish())
    expect(refused.code).toBe('BAD_REQUEST')
    expect(refused.message).toMatch(/^The build failed: src\/Hello\.tsx:2: /)
  })

  it('needs an admin to publish changed allowed origins, and audits them', async () => {
    const lib = await library('fetcher')
    await admin.mutate('permissions.set', {
      objectType: 'component_library',
      objectId: lib.id,
      groupId: memberGroupId,
      environmentId: null,
      level: 'edit',
    })
    await lib.save((def) => {
      def.allowedOrigins = ['https://api.example.com']
    }, member)
    expect(
      data(await member.query('componentLibraries.publishImpact', { componentLibraryId: lib.id })),
    ).toMatchObject({ originsChanged: true })
    expect(failure(await lib.publish(member))).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('only an admin'),
    })
    data(await lib.publish(admin))
    const audited = await env.db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.objectId, lib.id))
    expect(audited.find((a) => a.action === 'component_library.origins_changed')?.metadata).toMatchObject({
      version: '1.0.0',
      allowedOrigins: ['https://api.example.com'],
    })
    // The same origins again: the member may publish.
    await lib.save((def) => {
      def.components[0]!.label = 'Fetcher'
    }, member)
    expect(data(await lib.publish(member)).version).toBe('1.0.1')
  })

  it('warns about components and props apps on latest still use', async () => {
    const lib = await library('impacted')
    data(await lib.publish())
    const app = data(await admin.mutate('apps.create', { slug: 'impact-app', name: 'Impact app' }))
    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [
            {
              name: 'hello1',
              type: 'custom',
              props: { library: 'impacted', component: 'Hello', name: 'Ada' },
            },
          ],
          queries: [],
        },
      }),
    )
    await lib.save((def) => {
      def.components[0]!.props = {}
    })
    const impact = data(await admin.query('componentLibraries.publishImpact', { componentLibraryId: lib.id }))
    expect(impact).toMatchObject({
      dropped: ['Hello.name'],
      uses: [{ kind: 'app', slug: 'impact-app', passes: ['Hello.name'] }],
      originsChanged: false,
    })
  })

  it('warns about events with handlers and methods called, by apps on latest', async () => {
    const lib = await library('impacted-members')
    await lib.save((def) => {
      def.components[0]!.methods = { highlight: { params: ['id'] }, reset: { params: [] } }
    })
    data(await lib.publish())
    const app = data(await admin.mutate('apps.create', { slug: 'members-app', name: 'Members app' }))
    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [
            {
              name: 'hello1',
              type: 'custom',
              props: { library: 'impacted-members', component: 'Hello' },
              events: [{ id: 'c1', event: 'click', action: { type: 'notify', message: 'hi' } }],
            },
          ],
          queries: [{ name: 'q1', kind: 'js', code: 'return hello1.highlight(2)' }],
        },
      }),
    )
    await lib.save((def) => {
      def.components[0]!.events = []
      def.components[0]!.methods = {}
    })
    const impact = data(await admin.query('componentLibraries.publishImpact', { componentLibraryId: lib.id }))
    expect([...impact.dropped].sort()).toEqual(['Hello.highlight()', 'Hello.reset()', 'Hello:click'])
    expect(impact.uses).toEqual([
      expect.objectContaining({ slug: 'members-app', passes: ['Hello.highlight()', 'Hello:click'] }),
    ])
  })

  it('makes a release from an uploaded build', async () => {
    const lib = await library('uploaded')
    const js = 'export const Badge = () => null'
    const uploaded = data(
      await admin.mutate('componentLibraries.uploadBuild', {
        componentLibraryId: lib.id,
        js,
        components: [{ name: 'Badge', label: 'Badge', entry: 'dist/badge.js', props: {}, state: {} }],
      }),
    )
    expect(uploaded.version).toBe('1.0.0')
    const [release] = data(await admin.query('componentLibraries.releases', { componentLibraryId: lib.id }))
    expect(release).toMatchObject({ uploaded: true, bundleHash: uploaded.bundleHash })
    expect(Object.keys(release.components)).toEqual(['Badge'])
    expect(
      failure(
        await admin.mutate('componentLibraries.uploadBuild', {
          componentLibraryId: lib.id,
          js,
          components: [{ name: 'Badge', label: 'Badge', entry: 'dist/badge.js' }],
        }),
      ).code,
    ).toBe('CONFLICT')
  })

  it('removes old bundles no release keeps', async () => {
    const lib = await library('pruned')
    const kept = data(await lib.publish()).bundleHash
    await lib.save((def) => {
      // A change the bundle shows (a comment would be minified away: the same bundle).
      def.files[0]!.content = def.files[0]!.content.replace('Hello {name}', 'Hi {name}')
    })
    const draft = data(
      await admin.mutate('componentLibraries.build', { componentLibraryId: lib.id }),
    ).bundleHash
    await env.db
      .update(componentBundles)
      .set({ createdAt: sql`now() - interval '8 days'` })
      .where(sql`${componentBundles.hash} in (${kept}, ${draft})`)
    expect(await deleteUnusedBundles(env.db)).toBeGreaterThanOrEqual(1)
    const left = await env.db.select({ hash: componentBundles.hash }).from(componentBundles)
    expect(left.map((b) => b.hash)).toContain(kept)
    expect(left.map((b) => b.hash)).not.toContain(draft)
  })
})

describe('component libraries in Git', () => {
  const deploy = () => runGitDeploy(env.db, env.config, { trigger: 'poll' })

  it('protects a library as its directory, without a lock', async () => {
    const lib = await library('git-widgets')
    data(await lib.publish())
    const protectedOne = data(await admin.mutate('git.protect', { kind: 'component_library', id: lib.id }))
    expect(protectedOne.branch).toBe('protect/component_library-git-widgets')
    const files = await other.readFiles((await other.fetchBranch(protectedOne.branch))!, [
      'component-libraries/',
    ])
    expect(Object.keys(files)).toEqual([
      'component-libraries/git-widgets/library.json',
      'component-libraries/git-widgets/package.json',
      'component-libraries/git-widgets/src/Hello.tsx',
    ])
    const got = data(await admin.query('componentLibraries.get', { id: lib.id }))
    expect(
      failure(
        await admin.mutate('componentLibraries.saveDraft', {
          id: lib.id,
          revision: got.draftRevision,
          definition: got.draftDefinition,
        }),
      ),
    ).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('protects a library whose live release was uploaded with its draft (an upload has no files)', async () => {
    const lib = await library('git-uploaded')
    data(
      await admin.mutate('componentLibraries.uploadBuild', {
        componentLibraryId: lib.id,
        js: 'export const Badge = () => null',
        components: [{ name: 'Badge', label: 'Badge', entry: 'dist/badge.js' }],
      }),
    )
    const protectedOne = data(await admin.mutate('git.protect', { kind: 'component_library', id: lib.id }))
    const tip = (await other.fetchBranch(protectedOne.branch))!
    const files = await other.readFiles(tip, ['component-libraries/'])
    expect(Object.keys(files)).toContain('component-libraries/git-uploaded/src/Hello.tsx')
  })

  it('creates and builds a library merged to main, before an app placing it', async () => {
    const definition = emptyComponentLibrary()
    definition.components[0]!.label = 'From Git'
    const objects: RepoObject[] = [
      {
        kind: 'component_library',
        slug: 'from-git',
        value: { name: 'From Git', description: null, definition },
      },
      {
        kind: 'app',
        slug: 'from-git-app',
        value: {
          name: 'From Git app',
          description: null,
          definition: {
            schemaVersion: 1,
            components: [
              { name: 'hello1', type: 'custom', props: { library: 'from-git', component: 'Hello' } },
            ],
            queries: [],
            layout: { hello1: { x: 0, y: 0, w: 4, h: 6 } },
          },
        },
      },
    ]
    const parent = await other.fetchBranch('main')
    const directories = Object.fromEntries(
      objects.map((o) => {
        const { dir: path, files } = encodeObjectDir(o)
        return [path, files]
      }),
    )
    const commit = await other.commit({
      parent,
      directories,
      message: 'Components from Git',
      author: { name: 'Reviewer', email: 'reviewer@optiply.nl' },
    })
    expect(await other.push(commit!, 'main')).toBe('ok')
    const result = await deploy()
    expect(result.status).toBe('deployed')
    if (result.status !== 'deployed') return
    const outcome = Object.fromEntries(result.objects.map((o) => [`${o.kind}:${o.slug}`, o.outcome]))
    expect(outcome).toMatchObject({ 'component_library:from-git': 'created', 'app:from-git-app': 'created' })
    const got = data(await admin.query('componentLibraries.get', { slug: 'from-git' }))
    expect(got).toMatchObject({ gitProtected: true, liveRelease: { version: '1.0.0' } })
  })
})
