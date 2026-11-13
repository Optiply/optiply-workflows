import type { AppDefinition } from '@ow/app-definition'
import { appDraftVersions } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KEPT, MERGE_WINDOW_MS, recordAppVersion } from '../src/services/app-history'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * An app's draft history (session 41): saves recorded and merged within minutes per person, labelled by what
 * changed, kept to the newest 200; restoring a version, and a new app from one; edit access only.
 */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminId: string

type Res = {
  status: number
  body: { result?: { data: unknown }; error?: { message: string; data?: { code: string } } }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

const def = (text: string, extra: Partial<AppDefinition> = {}): AppDefinition => ({
  schemaVersion: 1,
  components: [{ name: 'title', type: 'text', props: { value: text } }],
  queries: [],
  ...extra,
})

beforeAll(async () => {
  env = await startTestApp()
  adminId = (await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })).id
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
}, 120_000)

afterAll(async () => {
  await env?.stop()
})

describe('recording', () => {
  it('merges saves by one person within minutes, starts a new entry after, and skips saves changing nothing', async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'merging', name: 'Merging' }))
    const t0 = new Date('2026-11-05T10:00:00Z')
    const at = (ms: number) => new Date(t0.getTime() + ms)
    await recordAppVersion(env.db, {
      appId: app.id,
      definition: def('a'),
      revision: 2,
      userId: adminId,
      now: t0,
    })
    await recordAppVersion(env.db, {
      appId: app.id,
      definition: def('b', { variables: [{ name: 'v' }] }),
      revision: 3,
      userId: adminId,
      now: at(30_000),
    })
    // Nothing changed: not recorded.
    await recordAppVersion(env.db, {
      appId: app.id,
      definition: def('b', { variables: [{ name: 'v' }] }),
      revision: 4,
      userId: adminId,
      now: at(40_000),
    })
    await recordAppVersion(env.db, {
      appId: app.id,
      definition: def('c', { variables: [{ name: 'v' }] }),
      revision: 5,
      userId: adminId,
      now: at(40_000 + MERGE_WINDOW_MS + 1),
    })
    const history = data(await admin.query('apps.history', { appId: app.id }))
    expect(history.versions.map((v: { revision: number }) => v.revision)).toEqual([5, 3])
    expect(history.versions[0].summary).toEqual({ added: [], removed: [], changed: ['title'], parts: [] })
    // The first entry: from nothing, then merged with the variable's addition.
    expect(history.versions[1].summary.added).toEqual(['title', 'v'])
    expect(history.versions[1].author).toMatchObject({ email: 'admin@optiply.nl' })
  })

  it('records the saves the editor makes, and keeps the newest 200', async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'kept', name: 'Kept' }))
    data(await admin.mutate('apps.saveDraft', { id: app.id, revision: 1, definition: def('saved') }))
    expect(data(await admin.query('apps.history', { appId: app.id })).versions).toHaveLength(1)
    const t0 = Date.now() - 1000 * MERGE_WINDOW_MS
    for (let i = 0; i < KEPT + 5; i++) {
      // Another person each time, so nothing merges.
      await recordAppVersion(env.db, {
        appId: app.id,
        definition: def(`v${i}`),
        revision: 10 + i,
        userId: i % 2 ? adminId : null,
        now: new Date(t0 + i * 1000),
      })
    }
    const rows = await env.db.select().from(appDraftVersions).where(eq(appDraftVersions.appId, app.id))
    expect(rows).toHaveLength(KEPT)
    const page = data(await admin.query('apps.history', { appId: app.id }))
    expect(page.versions).toHaveLength(30)
    expect(page.more).toBe(true)
    const last = page.versions.at(-1)
    const next = data(
      await admin.query('apps.history', {
        appId: app.id,
        before: { updatedAt: last.updatedAt, id: last.id },
      }),
    )
    expect(next.versions[0].revision).toBe(last.revision - 1)
  })
})

describe('using a version', () => {
  it('restores one as the draft (a new entry), and makes a new app from one', async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'restoring', name: 'Restoring' }))
    const first = data(
      await admin.mutate('apps.saveDraft', { id: app.id, revision: 1, definition: def('first') }),
    )
    await env.db
      .update(appDraftVersions)
      .set({ updatedAt: new Date(Date.now() - 2 * MERGE_WINDOW_MS) })
      .where(eq(appDraftVersions.appId, app.id))
    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: first.revision,
        definition: def('second'),
      }),
    )
    const history = data(await admin.query('apps.history', { appId: app.id }))
    const older = history.versions[1]
    const version = data(await admin.query('apps.historyVersion', { appId: app.id, id: older.id }))
    expect(version.definition.components[0].props.value).toBe('first')

    const restored = data(await admin.mutate('apps.restoreVersion', { appId: app.id, id: older.id }))
    const draft = data(await admin.query('apps.get', { slug: 'restoring' }))
    expect(draft.draftRevision).toBe(restored.revision)
    expect(draft.draftDefinition.components[0].props.value).toBe('first')
    const after = data(await admin.query('apps.history', { appId: app.id }))
    expect(after.versions[0]).toMatchObject({ restoredFrom: older.id, revision: restored.revision })

    const copy = data(
      await admin.mutate('apps.duplicate', {
        id: app.id,
        slug: 'from-version',
        name: 'From a version',
        fromVersionId: history.versions[0].id,
      }),
    )
    const copied = data(await admin.query('apps.get', { slug: copy.slug }))
    expect(copied.draftDefinition.components[0].props.value).toBe('second')
  })

  it('needs edit access', async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'private-history', name: 'Private' }))
    const res = (await member.query('apps.history', { appId: app.id })) as Res
    expect(res.body.error?.data?.code).toMatch(/NOT_FOUND|FORBIDDEN/)
  })
})
