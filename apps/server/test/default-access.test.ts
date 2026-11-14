import { permissions } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertGitObject } from '../src/services/git/kinds'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// Session 54, the owner's choice: anything people create starts shared with everyone (All Users: Use), its creator
// keeps Edit; admins change it afterwards. Workflows, apps, library queries, modules, component libraries.
let env: TestEnv
let admin: ReturnType<typeof trpc>
let builder: ReturnType<typeof trpc>
let viewer: ReturnType<typeof trpc>
let builderId: string

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

const grantsOn = async (objectType: string, objectId: string) =>
  (
    await env.db
      .select({ groupId: permissions.groupId, userId: permissions.userId, level: permissions.level })
      .from(permissions)
      .where(and(eq(permissions.objectType, objectType as 'workflow'), eq(permissions.objectId, objectId)))
  ).map((g) => ({
    to: g.groupId ? 'all users' : g.userId === builderId ? 'builder' : g.userId,
    level: g.level,
  }))

beforeAll(async () => {
  env = await startTestApp({ SHARE_NEW_WITH_EVERYONE: 'true' })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  builderId = (await createLocalUser(env.db, 'builder@optiply.nl')).id
  await createLocalUser(env.db, 'viewer@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  builder = trpc(env.app, await login(env.app, 'builder@optiply.nl'))
  viewer = trpc(env.app, await login(env.app, 'viewer@optiply.nl'))
  // The builder may create every kind (Edit on all of each); the viewer has nothing of their own.
  for (const objectType of ['workflow', 'app', 'library_query', 'module', 'component_library'])
    data(
      await admin.mutate('permissions.set', {
        objectType,
        objectId: null,
        userId: builderId,
        environmentId: null,
        level: 'edit',
      }),
    )
})
afterAll(() => env?.stop())

describe('what something new is shared with', () => {
  it('a workflow a builder makes: everyone may Use it, the builder may Edit it, and others see it', async () => {
    expect(data(await viewer.query('workflows.list'))).toEqual([])
    const wf = data(await builder.mutate('workflows.create', { slug: 'stock-sync', name: 'Stock sync' }))
    expect(await grantsOn('workflow', wf.id)).toEqual(
      expect.arrayContaining([
        { to: 'all users', level: 'use' },
        { to: 'builder', level: 'edit' },
      ]),
    )
    expect(await grantsOn('workflow', wf.id)).toHaveLength(2)
    const seen = data(await viewer.query('workflows.list')) as { slug: string; level: string }[]
    expect(seen).toEqual([expect.objectContaining({ slug: 'stock-sync', level: 'use' })])
  })

  it('its duplicate starts the same way', async () => {
    const [wf] = data(await builder.query('workflows.list')) as { id: string }[]
    const copy = data(
      await builder.mutate('workflows.duplicate', {
        id: wf!.id,
        slug: 'stock-sync-copy',
        name: 'Stock sync copy',
      }),
    )
    expect(await grantsOn('workflow', copy.id)).toHaveLength(2)
  })

  it('an app, a library query, a module and a component library too', async () => {
    const made = [
      ['app', data(await builder.mutate('apps.create', { slug: 'dashboard', name: 'Dashboard' })).id],
      ['library_query', data(await builder.mutate('libraryQueries.create', { slug: 'q1', name: 'Q1' })).id],
      ['module', data(await builder.mutate('modules.create', { slug: 'm1', name: 'M1' })).id],
      [
        'component_library',
        data(await builder.mutate('componentLibraries.create', { slug: 'c1', name: 'C1' })).id,
      ],
    ] as const
    for (const [kind, id] of made) {
      expect(await grantsOn(kind, id)).toEqual(
        expect.arrayContaining([
          { to: 'all users', level: 'use' },
          { to: 'builder', level: 'edit' },
        ]),
      )
    }
  })

  it('what an admin makes is shared with everyone only (admins can do everything anyway)', async () => {
    const wf = data(await admin.mutate('workflows.create', { slug: 'admin-made', name: 'Admin made' }))
    expect(await grantsOn('workflow', wf.id)).toEqual([{ to: 'all users', level: 'use' }])
  })

  it('an object arriving from Git sync is shared with nobody: an admin approves it', async () => {
    const made = await insertGitObject(env.db, 'workflow', {
      slug: 'from-git',
      name: 'From Git',
      description: null,
      definition: { schemaVersion: 1, blocks: [{ name: 'startTrigger', type: 'startTrigger' }], edges: [] },
    })
    expect(made).toBeDefined()
    expect(await grantsOn('workflow', made!.id)).toEqual([])
    expect(
      (data(await viewer.query('workflows.list')) as { slug: string }[]).map((w) => w.slug),
    ).not.toContain('from-git')
  })
})
