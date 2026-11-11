import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/** Access (session 44): grants to one person as well as to groups; a group's and a person's grants listed. */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let other: ReturnType<typeof trpc>
let memberId: string
let groupId: string

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
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  memberId = (await createLocalUser(env.db, 'member@optiply.nl')).id
  await createLocalUser(env.db, 'other@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  other = trpc(env.app, await login(env.app, 'other@optiply.nl'))
  groupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
})
afterAll(async () => {
  await env?.stop()
})

const newWorkflow = async (slug: string) =>
  data(await admin.mutate('workflows.create', { slug, name: slug })) as { id: string; slug: string }

describe('grants to one person', () => {
  it('raise that person, and nobody else', async () => {
    const wf = await newWorkflow('payroll')
    expect(data(await member.query('workflows.list'))).toEqual([])
    data(
      await admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: wf.id,
        userId: memberId,
        environmentId: null,
        level: 'use',
      }),
    )
    expect(
      data(await member.query('workflows.list')).map((w: { slug: string; level: string }) => w.level),
    ).toEqual(['use'])
    expect(data(await other.query('workflows.list'))).toEqual([])
    // A person's grant and their group's: the higher wins.
    await admin.mutate('groups.addMember', { groupId, userId: memberId })
    data(
      await admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: wf.id,
        groupId,
        environmentId: null,
        level: 'edit',
      }),
    )
    expect(data(await member.query('workflows.get', { id: wf.id })).level).toBe('edit')
  })

  it('show in the target’s list beside the groups, by name', async () => {
    const wf = await newWorkflow('invoices')
    for (const subject of [{ userId: memberId }, { groupId }]) {
      data(
        await admin.mutate('permissions.set', {
          objectType: 'workflow',
          objectId: wf.id,
          ...subject,
          environmentId: null,
          level: 'use',
        }),
      )
    }
    const list = data(await admin.query('permissions.list', { objectType: 'workflow', objectId: wf.id }))
    expect(
      list.map((g: { subject: string; groupName: string | null; userEmail: string | null }) => [
        g.subject,
        g.groupName ?? g.userEmail,
      ]),
    ).toEqual([
      ['group', 'Ops'],
      ['user', 'member@optiply.nl'],
    ])
  })

  it('need exactly one of a group and a person', async () => {
    const wf = await newWorkflow('either')
    const base = { objectType: 'workflow', objectId: wf.id, environmentId: null, level: 'use' }
    expect(failure(await admin.mutate('permissions.set', base))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      failure(await admin.mutate('permissions.set', { ...base, groupId, userId: memberId })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('are given by owners, not by people with less', async () => {
    const wf = await newWorkflow('owned')
    const grant = (by: typeof admin, level: string) =>
      by.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: wf.id,
        userId: memberId,
        environmentId: null,
        level,
      })
    data(await grant(admin, 'edit'))
    expect(failure(await grant(member, 'own'))).toMatchObject({ code: 'FORBIDDEN' })
    data(await grant(admin, 'own'))
    // An owner can share it with another person.
    const otherId = data(await member.query('users.directory')).find(
      (u: { email: string }) => u.email === 'other@optiply.nl',
    ).id
    data(
      await member.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: wf.id,
        userId: otherId,
        environmentId: null,
        level: 'use',
      }),
    )
    expect(data(await other.query('workflows.list')).map((w: { slug: string }) => w.slug)).toContain('owned')
  })
})

describe('a subject’s grants', () => {
  it('list every grant of a group or a person with what it is on (admins only)', async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'board', name: 'Board' }))
    const folder = data(
      await admin.mutate('folders.create', { name: 'Finance', type: 'app', parentId: null }),
    )
    const set = (target: object, level: string) =>
      admin.mutate('permissions.set', { ...target, userId: memberId, environmentId: null, level })
    data(await set({ objectType: 'app', objectId: app.id }, 'use'))
    data(await set({ objectType: 'folder', objectId: folder.id }, 'edit'))
    data(await set({ objectType: 'workflow', objectId: null }, 'edit'))
    const rows = data(await admin.query('permissions.forSubject', { userId: memberId }))
    const byType = (t: string) => rows.filter((r: { objectType: string }) => r.objectType === t)
    expect(byType('app')).toEqual([
      expect.objectContaining({ objectId: app.id, name: 'Board', slug: 'board', level: 'use' }),
    ])
    expect(byType('folder')).toEqual([
      expect.objectContaining({ objectId: folder.id, name: 'Finance', folderType: 'app', level: 'edit' }),
    ])
    expect(byType('workflow').find((r: { objectId: string | null }) => r.objectId === null)).toMatchObject({
      level: 'edit',
    })
    // Type-wide Edit lets them create.
    data(await member.mutate('workflows.create', { slug: 'mine', name: 'Mine' }))
    expect(failure(await member.query('permissions.forSubject', { userId: memberId }))).toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
