import { emptyComponentLibrary } from '@ow/app-definition'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/** Component libraries on the server (M25 step 2a): drafts, access, folders, use by apps, deleting. */

let env: TestEnv
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

const grant = (objectType: string, objectId: string | null, level: 'use' | 'edit' | 'own' | null) =>
  admin.mutate('permissions.set', {
    objectType,
    objectId,
    groupId: memberGroupId,
    environmentId: null,
    level,
  })

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Builders' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
})
afterAll(async () => {
  await env?.stop()
})

describe('component libraries', () => {
  it('starts from the starter library and saves drafts with optimistic revisions', async () => {
    const created = data(
      await admin.mutate('componentLibraries.create', { slug: 'widgets', name: 'Widgets' }),
    )
    const got = data(await admin.query('componentLibraries.get', { slug: 'widgets' }))
    expect(got).toMatchObject({
      slug: 'widgets',
      draftRevision: 1,
      draftLock: null,
      diagnostics: [],
      liveRelease: null,
      level: 'own',
    })
    expect(got.draftDefinition.components.map((c: { name: string }) => c.name)).toEqual(['Hello'])

    const next = emptyComponentLibrary()
    next.dependencies = { 'left-pad': '^1.3.0' }
    next.components[0]!.entry = 'src/Nope.tsx'
    const saved = data(
      await admin.mutate('componentLibraries.saveDraft', { id: created.id, revision: 1, definition: next }),
    )
    expect(saved.revision).toBe(2)
    expect(saved.diagnostics.map((d: { code: string }) => d.code)).toEqual(['unknown_entry'])
    // A stale revision, and a definition that doesn't match the schema.
    expect(
      failure(
        await admin.mutate('componentLibraries.saveDraft', { id: created.id, revision: 1, definition: next }),
      ),
    ).toMatchObject({ code: 'CONFLICT' })
    expect(
      failure(
        await admin.mutate('componentLibraries.saveDraft', {
          id: created.id,
          revision: 2,
          definition: { schemaVersion: 2 },
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(data(await admin.query('componentLibraries.list')).map((l: { slug: string }) => l.slug)).toContain(
      'widgets',
    )
  })

  it('needs access: none hides it, Use lists it, Edit opens it, creating needs Edit on all', async () => {
    const lib = data(await admin.mutate('componentLibraries.create', { slug: 'charts', name: 'Charts' }))
    expect(failure(await member.query('componentLibraries.get', { id: lib.id }))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(data(await member.query('componentLibraries.list'))).toEqual([])
    expect(
      failure(await member.mutate('componentLibraries.create', { slug: 'mine', name: 'Mine' })),
    ).toMatchObject({ code: 'FORBIDDEN' })

    await grant('component_library', lib.id, 'use')
    expect(data(await member.query('componentLibraries.list')).map((l: { slug: string }) => l.slug)).toEqual([
      'charts',
    ])
    expect(failure(await member.query('componentLibraries.get', { id: lib.id }))).toMatchObject({
      code: 'FORBIDDEN',
    })
    const resolved = data(
      await member.query('componentLibraries.resolve', { slugs: ['charts', 'widgets', 'x'] }),
    )
    expect(resolved.charts).toMatchObject({ id: lib.id, liveVersion: null, versions: {} })
    expect(resolved.widgets).toEqual({ liveVersion: null, versions: {}, noUse: true })
    expect(resolved.x).toBeUndefined()

    await grant('component_library', lib.id, 'edit')
    expect(data(await member.query('componentLibraries.get', { id: lib.id })).level).toBe('edit')
    expect(failure(await member.mutate('componentLibraries.delete', { id: lib.id }))).toMatchObject({
      code: 'FORBIDDEN',
    })
    await grant('component_library', null, 'edit')
    data(await member.mutate('componentLibraries.create', { slug: 'mine', name: 'Mine' }))
    await grant('component_library', null, null)
  })

  it('lives in folders of its own kind', async () => {
    const folder = data(await admin.mutate('folders.create', { name: 'UI', type: 'component_library' }))
    const appFolder = data(await admin.mutate('folders.create', { name: 'Apps', type: 'app' }))
    const lib = data(
      await admin.mutate('componentLibraries.create', { slug: 'maps', name: 'Maps', folderId: folder.id }),
    )
    expect(lib.folderId).toBe(folder.id)
    expect(
      failure(await admin.mutate('componentLibraries.update', { id: lib.id, folderId: appFolder.id })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    const moved = data(
      await admin.mutate('componentLibraries.update', { id: lib.id, folderId: null, name: 'Maps!' }),
    )
    expect(moved).toMatchObject({ folderId: null, name: 'Maps!' })
  })

  it('refuses deleting a library an app places, and says which', async () => {
    const lib = data(
      await admin.mutate('componentLibraries.create', { slug: 'signature', name: 'Signature' }),
    )
    const app = data(await admin.mutate('apps.create', { slug: 'contracts', name: 'Contracts' }))
    const definition = {
      schemaVersion: 1,
      components: [{ name: 'pad1', type: 'custom', props: { library: 'signature', component: 'Pad' } }],
      queries: [],
    }
    data(await admin.mutate('apps.saveDraft', { id: app.id, revision: 1, definition }))
    const usedBy = data(await admin.query('componentLibraries.usedBy', { componentLibraryId: lib.id }))
    expect(usedBy.apps.map((a: { slug: string }) => a.slug)).toEqual(['contracts'])
    const refused = failure(await admin.mutate('componentLibraries.delete', { id: lib.id }))
    expect(refused.code).toBe('CONFLICT')
    expect(refused.message).toContain('Contracts')

    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 2,
        definition: { ...definition, components: [] },
      }),
    )
    expect(data(await admin.mutate('componentLibraries.delete', { id: lib.id }))).toEqual({ ok: true })
    expect(failure(await admin.query('componentLibraries.get', { id: lib.id }))).toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
