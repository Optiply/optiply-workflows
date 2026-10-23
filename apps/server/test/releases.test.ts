import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakePubSub } from '@ow/connectors/testing'
import { createDb, workflowTriggers } from '@ow/db'
import { bumpVersion, compareVersions, nextScheduleFire } from '@ow/definition'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeGoogle } from '../../../packages/connectors/test/google-fake'
import { configureGoogle } from '../src/services/google'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let memberGroupId: string
let prodId: string
let stagingId: string
let resourceId: string
let stopWorker: () => Promise<void>
let worker: Awaited<ReturnType<typeof startWorker>>

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}
const failure = (res: {
  status: number
  body: { error?: { message: string; data?: { code: string } } }
}) => ({
  code: res.body.error?.data?.code,
  message: res.body.error?.message,
})

const start = { name: 'startTrigger', type: 'startTrigger' }
const code = (name: string, src: string) => ({ name, type: 'code', config: { code: src } })
const reply = (body: string) => ({ name: 'reply', type: 'response', config: { body } })

/** A definition: start → (blocks in a chain). */
function definition(blocks: object[], extra: object = {}) {
  const names = ['startTrigger', ...blocks.map((b) => (b as { name: string }).name)]
  return {
    schemaVersion: 1,
    blocks: [start, ...blocks],
    edges: names.slice(1).map((to, i) => ({ from: names[i]!, port: 'out', to })),
    ...extra,
  }
}

/** A workflow with a saved draft; `save` saves the next draft and returns its revision. */
async function workflowWith(slug: string, def: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  let revision = 1
  const save = async (next: object, client = admin) => {
    revision = data(
      await client.mutate('workflows.saveDraft', { id: created.id, revision, definition: next }),
    ).revision
    return revision
  }
  await save(def)
  return { id: created.id as string, slug, save, revision: () => revision }
}

const publish = (wf: { id: string; revision: () => number }, extra: object = {}, client = admin) =>
  client.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision(), ...extra })

async function triggersOf(workflowId: string) {
  return env.db.select().from(workflowTriggers).where(eq(workflowTriggers.workflowId, workflowId))
}

async function runLive(slug: string, input: unknown) {
  const res = await env.app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${slug}/runs`,
    headers: { cookie: adminCookie },
    payload: { version: 'live', input },
  })
  if (res.statusCode !== 202) throw new Error(`run: ${res.statusCode} ${res.body}`)
  const id = res.json().run.id as string
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
    const run = (
      await env.app.inject({ method: 'GET', url: `/api/v1/runs/${id}`, headers: { cookie: adminCookie } })
    ).json().run
    if (['succeeded', 'failed'].includes(run.status)) return run
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`run ${id} didn't finish`)
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))

  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
  resourceId = data(
    await admin.mutate('resources.create', { type: 'postgres', name: 'Warehouse', slug: 'warehouse' }),
  ).id
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })

  const workerDb = createDb(env.databaseUrl, { max: 5 })
  worker = await startWorker({
    db: workerDb.db,
    sql: workerDb.sql,
    config: env.config,
    log: pino({ level: 'silent' }),
  })
  stopWorker = async () => {
    await worker.stop()
    await workerDb.close()
  }
})
afterAll(async () => {
  await stopWorker?.()
  await env?.stop()
})

describe('versions', () => {
  it('bumps and compares semver', () => {
    expect(bumpVersion(null, 'minor')).toBe('1.0.0')
    expect(bumpVersion('1.4.2', 'patch')).toBe('1.4.3')
    expect(bumpVersion('1.4.2', 'minor')).toBe('1.5.0')
    expect(bumpVersion('1.4.2', 'major')).toBe('2.0.0')
    expect(['1.10.0', '1.2.0', '0.9.9', '1.2.10'].sort(compareVersions)).toEqual([
      '0.9.9',
      '1.2.0',
      '1.2.10',
      '1.10.0',
    ])
  })
})

describe('publishing', () => {
  it('releases the draft as 1.0.0, makes it live, and reports unpublished changes by hash', async () => {
    const wf = await workflowWith('greeter', definition([code('hello', 'return "v1"')]))
    const before = data(await admin.query('workflows.get', { id: wf.id }))
    expect(before.liveRelease).toBeNull()

    const release = data(await publish(wf, { notes: '  First cut  ' }))
    expect(release.version).toBe('1.0.0')
    const after = data(await admin.query('workflows.get', { id: wf.id }))
    expect(after.liveRelease).toMatchObject({ id: release.id, version: '1.0.0' })
    expect(after.draftHash).toBe(after.liveRelease.definitionHash)

    const list = data(await admin.query('releases.list', { workflowId: wf.id }))
    expect(list).toEqual([
      expect.objectContaining({
        version: '1.0.0',
        notes: 'First cut',
        live: true,
        createdBy: expect.objectContaining({ email: 'admin@optiply.nl' }),
      }),
    ])
    const full = data(await admin.query('releases.get', { workflowId: wf.id, id: release.id }))
    expect(full.definition.blocks.map((b: { name: string }) => b.name)).toEqual(['hello', 'startTrigger'])

    await wf.save(definition([code('hello', 'return "v2"')]))
    const changed = data(await admin.query('workflows.get', { id: wf.id }))
    expect(changed.draftHash).not.toBe(changed.liveRelease.definitionHash)
  })

  it('refuses to publish nothing new, including a layout-only change', async () => {
    const wf = await workflowWith('no-change', definition([code('a', 'return 1')]))
    data(await publish(wf))
    expect(failure(await publish(wf))).toEqual({
      code: 'CONFLICT',
      message: 'Nothing changed since the live release, v1.0.0',
    })
    await wf.save(definition([code('a', 'return 1')], { layout: { blocks: { a: { x: 5, y: 9 } } } }))
    expect(failure(await publish(wf)).message).toBe('Nothing changed since the live release, v1.0.0')
  })

  it('bumps from the highest version, and only accepts higher explicit versions', async () => {
    const wf = await workflowWith('versions', definition([code('a', 'return 1')]))
    data(await publish(wf, { version: '0.3.0' }))
    await wf.save(definition([code('a', 'return 2')]))
    expect(data(await publish(wf, { bump: 'minor' })).version).toBe('0.4.0')
    await wf.save(definition([code('a', 'return 3')]))
    expect(failure(await publish(wf, { version: '0.4.0' }))).toEqual({
      code: 'CONFLICT',
      message: 'The version must be higher than v0.4.0, the latest release',
    })
    expect(failure(await publish(wf, { version: 'v1' }))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Use a version like 1.2.3',
    })
    expect(data(await publish(wf)).version).toBe('0.4.1')
  })

  it('refuses a stale draft revision, so nobody publishes changes they have not seen', async () => {
    const wf = await workflowWith('stale', definition([code('a', 'return 1')]))
    const seen = wf.revision()
    await wf.save(definition([code('a', 'return 2')]))
    const res = await admin.mutate('releases.publish', { workflowId: wf.id, draftRevision: seen })
    expect(failure(res)).toEqual({
      code: 'CONFLICT',
      message: `The draft changed since revision ${seen}; reload before publishing`,
    })
  })

  it('refuses an invalid definition, checking queries against their resources', async () => {
    const wf = await workflowWith('broken', definition([code('a', 'return nope')]))
    expect(failure(await publish(wf))).toEqual({
      code: 'BAD_REQUEST',
      message: `The workflow isn't valid: "nope" is not defined`,
    })
    await wf.save(
      definition([
        { name: 'q', type: 'resourceQuery', config: { resource: 'missing', query: { sql: 'select 1' } } },
      ]),
    )
    expect(failure(await publish(wf)).message).toBe(
      `The workflow isn't valid: No resource has the slug "missing"`,
    )
  })
})

describe('who may release', () => {
  const grant = (objectType: string, objectId: string | null, level: string | null, environmentId?: string) =>
    admin.mutate('permissions.set', {
      objectType,
      objectId,
      groupId: memberGroupId,
      environmentId: environmentId ?? null,
      level,
    })

  it('needs edit on the workflow and use on its resources in every environment', async () => {
    const wf = await workflowWith(
      'guarded',
      definition([
        { name: 'q', type: 'resourceQuery', config: { resource: 'warehouse', query: { sql: 'select 1' } } },
      ]),
    )
    data(await grant('workflow', wf.id, 'use'))
    expect(failure(await publish(wf, {}, member))).toEqual({
      code: 'FORBIDDEN',
      message: 'You need edit access to this workflow to release it',
    })

    data(await grant('workflow', wf.id, 'edit'))
    data(await grant('resource', resourceId, 'use', prodId))
    expect(failure(await publish(wf, {}, member))).toEqual({
      code: 'FORBIDDEN',
      message: 'You need use access to resource "warehouse" in every environment to release this workflow',
    })

    data(await grant('resource', resourceId, 'use', stagingId))
    expect(data(await publish(wf, {}, member)).version).toBe('1.0.0')
  })

  it('lets editors set the concurrency limit, not users', async () => {
    const wf = await workflowWith('limited', definition([code('a', 'return 1')]))
    expect(
      data(await admin.mutate('workflows.update', { id: wf.id, maxConcurrentRuns: 2 })).maxConcurrentRuns,
    ).toBe(2)
    data(await grant('workflow', wf.id, 'use'))
    expect(
      failure(await member.mutate('workflows.update', { id: wf.id, maxConcurrentRuns: null })).code,
    ).toBe('FORBIDDEN')
    expect(
      data(await admin.mutate('workflows.update', { id: wf.id, maxConcurrentRuns: null })).maxConcurrentRuns,
    ).toBeNull()
    expect(failure(await admin.mutate('workflows.update', { id: wf.id, maxConcurrentRuns: 0 })).code).toBe(
      'BAD_REQUEST',
    )
  })
})

describe('rollback', () => {
  it('makes an earlier release live again, and live runs execute it', async () => {
    const wf = await workflowWith(
      'rollback',
      definition([code('v', 'return 1'), reply('{"v": {{ v.data }}}')]),
    )
    const v1 = data(await publish(wf))
    await wf.save(definition([code('v', 'return 2'), reply('{"v": {{ v.data }}}')]))
    const v2 = data(await publish(wf))
    expect((await runLive(wf.slug, {})).response.body).toEqual({ v: 2 })

    expect(
      data(await admin.mutate('releases.setLive', { workflowId: wf.id, releaseId: v1.id })).version,
    ).toBe('1.0.0')
    expect((await runLive(wf.slug, {})).response.body).toEqual({ v: 1 })
    const list = data(await admin.query('releases.list', { workflowId: wf.id }))
    expect(list.map((r: { version: string; live: boolean }) => [r.version, r.live])).toEqual([
      ['1.0.1', false],
      ['1.0.0', true],
    ])

    // Forward again; and nothing to roll back to in another workflow.
    data(await admin.mutate('releases.setLive', { workflowId: wf.id, releaseId: v2.id }))
    const other = await workflowWith('other', definition([code('a', 'return 1')]))
    expect(
      failure(await admin.mutate('releases.setLive', { workflowId: other.id, releaseId: v1.id })).code,
    ).toBe('NOT_FOUND')
  })
})

describe('trigger projection', () => {
  const yearly = { name: 'new-year', enabled: true, cron: '0 3 1 1 *' }
  const every10 = { name: 'every-10', enabled: true, intervalMs: 600_000, environment: 'staging' }

  it('projects the live release triggers, with next fire times and environments', async () => {
    const wf = await workflowWith(
      'scheduled',
      definition([code('a', 'return 1')], {
        triggers: {
          webhook: { enabled: true, alias: 'scheduled/:id' },
          schedules: [yearly, every10, { name: 'off', enabled: false, cron: '* * * * *' }],
        },
      }),
    )
    const before = new Date()
    data(await publish(wf))
    const after = new Date()
    const rows = await triggersOf(wf.id)
    const byName = new Map(rows.map((r) => [r.name, r]))

    expect(byName.get('webhook')).toMatchObject({
      kind: 'webhook',
      enabled: true,
      aliasShape: 'scheduled/:',
      // Stored as written: resolveWebhookSettings applies the defaults (methods, sync timeout) per call.
      config: { enabled: true, alias: 'scheduled/:id' },
      nextFireAt: null,
    })
    expect(byName.get('new-year')).toMatchObject({
      kind: 'schedule',
      environmentId: prodId,
      config: { ...yearly, overlap: 'skip' },
      nextFireAt: nextScheduleFire(yearly, before),
    })
    const every = byName.get('every-10')!
    expect(every.environmentId).toBe(stagingId)
    expect(every.nextFireAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 600_000)
    expect(every.nextFireAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 600_000)
    expect(byName.get('off')).toMatchObject({ enabled: false, nextFireAt: null })

    const listed = data(await admin.query('workflows.triggers', { id: wf.id }))
    expect(listed.map((t: { name: string; environment: string | null }) => [t.name, t.environment])).toEqual([
      ['every-10', 'staging'],
      ['new-year', 'production'],
      ['off', 'production'],
      ['webhook', null],
    ])
  })

  it('keeps trigger ids and unchanged fire times across releases, and drops removed triggers', async () => {
    const wf = await workflowWith(
      'republished',
      definition([code('a', 'return 1')], { triggers: { schedules: [yearly, every10] } }),
    )
    data(await publish(wf))
    const first = new Map((await triggersOf(wf.id)).map((r) => [r.name, r]))

    // Only the overlap policy changes: same row, same next fire.
    await wf.save(
      definition([code('a', 'return 2')], {
        triggers: { schedules: [{ ...yearly, overlap: 'queue' }, every10] },
      }),
    )
    const v2 = data(await publish(wf))
    const second = new Map((await triggersOf(wf.id)).map((r) => [r.name, r]))
    expect(second.get('new-year')).toMatchObject({
      id: first.get('new-year')!.id,
      releaseId: v2.id,
      nextFireAt: first.get('new-year')!.nextFireAt,
      config: { overlap: 'queue' },
    })
    expect(second.get('every-10')!.nextFireAt).toEqual(first.get('every-10')!.nextFireAt)

    // A new cron moves the next fire; a removed schedule goes; a disabled one stops firing.
    const daily = { ...yearly, cron: '0 3 * * *' }
    await wf.save(
      definition([code('a', 'return 3')], {
        triggers: { schedules: [daily, { ...every10, enabled: false }] },
      }),
    )
    data(await publish(wf))
    const third = new Map((await triggersOf(wf.id)).map((r) => [r.name, r]))
    expect(third.get('new-year')!.id).toBe(first.get('new-year')!.id)
    expect(third.get('new-year')!.nextFireAt!.getTime()).toBeLessThan(
      first.get('new-year')!.nextFireAt!.getTime(),
    )
    expect(third.get('every-10')).toMatchObject({ id: first.get('every-10')!.id, nextFireAt: null })

    await wf.save(definition([code('a', 'return 4')]))
    data(await publish(wf))
    expect(await triggersOf(wf.id)).toEqual([])
  })

  it('refuses schedules in an environment that does not exist', async () => {
    const wf = await workflowWith(
      'nowhere',
      definition([code('a', 'return 1')], { triggers: { schedules: [{ ...yearly, environment: 'qa' }] } }),
    )
    expect(failure(await publish(wf))).toEqual({
      code: 'BAD_REQUEST',
      message: `Schedule "new-year" runs in environment "qa", which doesn't exist`,
    })
  })

  it('gives each webhook alias to one live workflow', async () => {
    const hook = (alias: string, enabled = true) =>
      definition([code('a', 'return 1')], { triggers: { webhook: { enabled, alias } } })
    const a = await workflowWith('alias-a', hook('orders/:id'))
    data(await publish(a))

    // Same shape (orders/:), different param name: same URLs.
    const b = await workflowWith('alias-b', hook('orders/:orderId'))
    expect(failure(await publish(b))).toEqual({
      code: 'CONFLICT',
      message: `The webhook alias "orders/:orderId" would answer the same URLs as workflow "alias-a"'s`,
    })
    // A more specific alias is a different shape; a disabled webhook holds no alias.
    await b.save(hook('orders/:id/refunds'))
    data(await publish(b))
    await a.save(hook('orders/:id', false))
    data(await publish(a))
    expect((await triggersOf(a.id))[0]!.aliasShape).toBeNull()
    await b.save(hook('orders/:orderId'))
    data(await publish(b))
    // The workflow that already has it can republish it.
    await b.save(
      definition([code('a', 'return 2')], { triggers: { webhook: { enabled: true, alias: 'orders/:x' } } }),
    )
    data(await publish(b))
  })
})

describe('Pub/Sub trigger projection (M19)', () => {
  let eventsId: string
  const orders = { name: 'orders', enabled: true, resource: 'events', subscription: 'orders-sub' }
  beforeAll(async () => {
    eventsId = data(
      await admin.mutate('resources.create', { type: 'pubsub', name: 'Events', slug: 'events' }),
    ).id
  })

  it('projects Pub/Sub triggers with their defaults and environment, keeping ids and leases across releases', async () => {
    const wf = await workflowWith(
      'subscribed',
      definition([code('a', 'return 1')], {
        triggers: { pubsub: [orders, { ...orders, name: 'staged', environment: 'staging', maxInFlight: 9 }] },
      }),
    )
    data(await publish(wf))
    const first = new Map((await triggersOf(wf.id)).map((r) => [r.name, r]))
    expect(first.get('orders')).toMatchObject({
      kind: 'pubsub',
      enabled: true,
      environmentId: prodId,
      config: { ...orders, maxInFlight: 4, maxHoldMinutes: 60 },
      nextFireAt: null,
    })
    expect(first.get('staged')).toMatchObject({ environmentId: stagingId, config: { maxInFlight: 9 } })

    // A worker holds the lease; a new release keeps it (and the id), and drops the trigger it no longer has.
    const leaseExpiresAt = new Date(Date.now() + 30_000)
    await env.db
      .update(workflowTriggers)
      .set({ leaseOwner: 'worker-1', leaseExpiresAt })
      .where(eq(workflowTriggers.id, first.get('orders')!.id))
    await wf.save(
      definition([code('a', 'return 2')], { triggers: { pubsub: [{ ...orders, maxHoldMinutes: 5 }] } }),
    )
    data(await publish(wf))
    const second = await triggersOf(wf.id)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      id: first.get('orders')!.id,
      leaseOwner: 'worker-1',
      leaseExpiresAt,
      config: { maxHoldMinutes: 5 },
    })
    expect(
      data(await admin.query('workflows.triggers', { id: wf.id })).map((t: { name: string }) => t.name),
    ).toEqual(['orders'])
  })

  it("refuses an environment that doesn't exist, a resource that isn't Pub/Sub, and one that isn't there", async () => {
    const wf = await workflowWith(
      'mis-subscribed',
      definition([code('a', 'return 1')], { triggers: { pubsub: [{ ...orders, environment: 'qa' }] } }),
    )
    expect(failure(await publish(wf))).toEqual({
      code: 'BAD_REQUEST',
      message: `Pub/Sub trigger "orders" runs in environment "qa", which doesn't exist`,
    })
    await wf.save(
      definition([code('a', 'return 1')], { triggers: { pubsub: [{ ...orders, resource: 'warehouse' }] } }),
    )
    expect(failure(await publish(wf)).message).toBe(
      `The workflow isn't valid: Pub/Sub trigger "orders": "warehouse" isn't a Pub/Sub resource`,
    )
    await wf.save(
      definition([code('a', 'return 1')], { triggers: { pubsub: [{ ...orders, resource: 'nothing' }] } }),
    )
    expect(failure(await publish(wf)).message).toBe(
      `The workflow isn't valid: Pub/Sub trigger "orders": no resource has the slug "nothing"`,
    )
  })

  it("needs use on the trigger's resource in every environment to release, like a queried one", async () => {
    const wf = await workflowWith(
      'member-subscribed',
      definition([code('a', 'return 1')], { triggers: { pubsub: [orders] } }),
    )
    const grant = (
      objectType: string,
      objectId: string,
      level: string,
      environmentId: string | null = null,
    ) =>
      admin.mutate('permissions.set', { objectType, objectId, groupId: memberGroupId, environmentId, level })
    data(await grant('workflow', wf.id, 'edit'))
    expect(failure(await publish(wf, {}, member))).toEqual({
      code: 'FORBIDDEN',
      message: 'You need use access to resource "events" in every environment to release this workflow',
    })
    data(await grant('resource', eventsId, 'use'))
    expect(data(await publish(wf, {}, member)).version).toBe('1.0.0')
  })
})

describe('schedules on the worker', () => {
  it('runs the live release when a published schedule comes due', async () => {
    const wf = await workflowWith(
      'ticking',
      definition([code('which', 'return startTrigger.data.schedule')], {
        triggers: {
          schedules: [{ name: 'hourly', enabled: true, cron: '0 * * * *', environment: 'staging' }],
        },
      }),
    )
    const release = data(await publish(wf))
    const [trigger] = await triggersOf(wf.id)
    await env.db
      .update(workflowTriggers)
      .set({ nextFireAt: new Date(Date.now() - 1000) })
      .where(eq(workflowTriggers.id, trigger!.id))

    await worker.scheduler.tick()
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/workflows/ticking/runs',
      headers: { cookie: adminCookie },
    })
    const [run] = res.json().runs
    expect(run).toMatchObject({ triggerType: 'schedule', environment: 'staging', version: 'live' })
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      const current = (
        await env.app.inject({
          method: 'GET',
          url: `/api/v1/runs/${run.id}`,
          headers: { cookie: adminCookie },
        })
      ).json().run
      if (current.status === 'succeeded') {
        expect(current.input).toEqual({ data: { scheduledFor: expect.any(String), schedule: 'hourly' } })
        const [row] = await triggersOf(wf.id)
        expect(row!.nextFireAt!.getTime()).toBeGreaterThan(Date.now())
        expect(row!.releaseId).toBe(release.id)
        return
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('the scheduled run did not succeed')
  })
})

describe('Pub/Sub triggers on the worker (M19)', () => {
  const google = new FakeGoogle()
  let pubsub: Awaited<ReturnType<typeof startFakePubSub>>
  beforeAll(async () => {
    await google.start()
    const keyFile = join(mkdtempSync(join(tmpdir(), 'ow-pubsub-')), 'key.json')
    writeFileSync(keyFile, google.keyJson)
    pubsub = await startFakePubSub({ project: 'fake-project', pullWaitMs: 100 })
    pubsub.createTopic('orders')
    pubsub.createSubscription('orders-live', { topic: 'orders' })
    // Process-wide, so the worker's consumer (started with the test config) pulls from the fake as this server.
    configureGoogle(
      { GOOGLE_SERVER_IDENTITY: 'allow', GOOGLE_PUBSUB_URL: pubsub.url, GOOGLE_TOKEN_URL: google.tokenUrl },
      { GOOGLE_APPLICATION_CREDENTIALS: keyFile },
    )
  })
  afterAll(async () => {
    configureGoogle({ GOOGLE_SERVER_IDENTITY: 'deny' })
    await pubsub?.close()
    await google.stop()
  })

  it('runs the live release per message, acks it, and the editor sees the trigger pulling', async () => {
    const { id: resourceId } = data(
      await admin.mutate('resources.create', { type: 'pubsub', name: 'Live events', slug: 'events_live' }),
    )
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prodId,
        config: { identity: 'server', project: 'fake-project' },
      }),
    )
    const wf = await workflowWith(
      'on_orders',
      definition(
        [
          code(
            'seen',
            'return { doubled: startTrigger.data.n * 2, kind: startTrigger.message.attributes.kind }',
          ),
        ],
        {
          triggers: {
            pubsub: [{ name: 'orders', enabled: true, resource: 'events_live', subscription: 'orders-live' }],
          },
        },
      ),
    )
    data(await publish(wf))
    await worker.pubsub.tick()
    const messageId = pubsub.publish('orders', '{"n": 21}', { kind: 'created' })

    await expect.poll(() => pubsub.messages('orders-live')[0]?.acked ?? false, { timeout: 15_000 }).toBe(true)
    const listed = await env.app.inject({
      method: 'GET',
      url: '/api/v1/workflows/on_orders/runs',
      headers: { cookie: adminCookie },
    })
    const [run] = listed.json().runs
    expect(run).toMatchObject({
      triggerType: 'pubsub',
      status: 'succeeded',
      environment: 'production',
      version: 'live',
    })
    expect(run.input).toMatchObject({
      data: { n: 21 },
      message: { messageId, attributes: { kind: 'created' }, subscription: 'orders-live' },
    })
    const block = await env.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/blocks/seen`,
      headers: { cookie: adminCookie },
    })
    expect(block.json().block.data).toEqual({ doubled: 42, kind: 'created' })

    await worker.pubsub.tick()
    const [trigger] = data(await admin.query('workflows.triggers', { id: wf.id }))
    expect(trigger).toMatchObject({
      kind: 'pubsub',
      environment: 'production',
      pubsub: {
        worker: worker.dispatcher.workerId,
        state: { inFlight: 0, lastMessageAt: expect.any(String), lastError: null },
        lastDay: { messages: 1, succeeded: 1, failed: 0 },
      },
    })
  })
})
