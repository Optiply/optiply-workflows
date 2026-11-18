import { environments, workflowRuns } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * Environments only admins may use (session 56): Staging as seeded. Everyone else doesn't see it and is refused it:
 * runs, app queries, resource credentials, grants, schedules and webhooks named for it, and the runs made there.
 */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let memberCookie: string
let prodId: string
let stagingId: string

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

const start = { name: 'startTrigger', type: 'startTrigger' }
const definition = (triggers?: object) => ({
  schemaVersion: 1,
  blocks: [start, { name: 'a', type: 'code', config: { code: 'return 1' } }],
  edges: [{ from: 'startTrigger', port: 'out', to: 'a' }],
  ...(triggers && { triggers }),
})

/** A workflow the member may edit, with a saved draft. */
async function workflowWith(slug: string, def: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  data(
    await admin.mutate('permissions.set', {
      objectType: 'workflow',
      objectId: created.id,
      groupId: await allUsers(),
      environmentId: null,
      level: 'edit',
    }),
  )
  const { revision } = data(
    await admin.mutate('workflows.saveDraft', { id: created.id, revision: 1, definition: def }),
  )
  return { id: created.id as string, slug, revision: revision as number }
}

async function allUsers(): Promise<string> {
  const groups = data(await admin.query('groups.list')) as { id: string; systemKind: string | null }[]
  return groups.find((g) => g.systemKind === 'all_users')!.id
}

const startRun = (cookie: string, slug: string, environment?: string) =>
  env.app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${slug}/runs${environment ? `?environment=${environment}` : ''}`,
    headers: { cookie },
    payload: {},
  })

beforeAll(async () => {
  env = await startTestApp({}, { adminOnlyStaging: true })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, memberCookie)
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
})
afterAll(async () => {
  await env?.stop()
})

describe('the seed and the schema', () => {
  it('makes Staging admins-only and keeps Production the default for everyone', async () => {
    const rows = await env.db.select().from(environments)
    expect(rows.map((e) => [e.slug, e.isDefault, e.adminOnly]).sort()).toEqual([
      ['production', true, false],
      ['staging', false, true],
    ])
  })

  it('refuses making the default environment admins-only (everyone always has one)', async () => {
    await expect(
      env.db.update(environments).set({ adminOnly: true }).where(eq(environments.slug, 'production')),
    ).rejects.toThrow()
  })
})

describe('who sees it', () => {
  it('lists Staging for admins only', async () => {
    const slugs = (client: ReturnType<typeof trpc>) =>
      client.query('environments.list').then((r) => (data(r) as { slug: string }[]).map((e) => e.slug))
    expect(await slugs(admin)).toEqual(['production', 'staging'])
    expect(await slugs(member)).toEqual(['production'])
  })

  it("leaves Staging out of a resource's environments, even with a grant for every environment", async () => {
    const resource = data(
      await admin.mutate('resources.create', { type: 'postgres', name: 'Warehouse', slug: 'warehouse' }),
    )
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: resource.id,
        groupId: await allUsers(),
        environmentId: null,
        level: 'edit',
      }),
    )
    const listed = data(await member.query('resources.list')).resources.find(
      (r: { slug: string }) => r.slug === 'warehouse',
    )
    expect(listed.environments.map((e: { environmentId: string }) => e.environmentId)).toEqual([prodId])
    const got = data(await member.query('resources.get', { id: resource.id }))
    expect(got.environments.map((e: { environmentId: string }) => e.environmentId)).toEqual([prodId])
    // Edit "everywhere" means every environment they may use: Staging doesn't hold them back.
    expect(got.level).toBe('edit')
    // Its credentials there are the admins'.
    const config = { host: 'db.internal', port: 5432, database: 'w', user: 'u' }
    expect(
      failure(
        await member.mutate('resources.saveConfig', {
          resourceId: resource.id,
          environmentId: stagingId,
          config,
          secrets: {},
        }),
      ).code,
    ).toBe('FORBIDDEN')
    // Admins see both.
    const forAdmin = data(await admin.query('resources.get', { id: resource.id }))
    expect(forAdmin.environments.map((e: { environmentId: string }) => e.environmentId).sort()).toEqual(
      [prodId, stagingId].sort(),
    )
  })

  it('lets only admins grant anything in Staging', async () => {
    const resource = data(
      await admin.mutate('resources.create', { type: 'postgres', name: 'CRM', slug: 'crm' }),
    )
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: resource.id,
        groupId: await allUsers(),
        environmentId: null,
        level: 'own',
      }),
    )
    const groupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
    const grant = (client: ReturnType<typeof trpc>, environmentId: string) =>
      client.mutate('permissions.set', {
        objectType: 'resource',
        objectId: resource.id,
        groupId,
        environmentId,
        level: 'use',
      })
    expect(failure(await grant(member, stagingId))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only admins can use this environment',
    })
    data(await grant(member, prodId))
    data(await grant(admin, stagingId))
  })
})

describe('runs', () => {
  it('refuses a run in Staging to everyone but admins, and hides the runs made there', async () => {
    const wf = await workflowWith('nightly', definition())
    const refused = await startRun(memberCookie, wf.slug, 'staging')
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.message).toBe('Only admins can run in Staging')
    // Without one: Production, the default.
    const own = await startRun(memberCookie, wf.slug)
    expect(own.statusCode).toBe(202)
    expect(own.json().run.environment).toBe('production')

    const byAdmin = await startRun(adminCookie, wf.slug, 'staging')
    expect(byAdmin.statusCode).toBe(202)
    const stagingRun = byAdmin.json().run.id as string
    const [row] = await env.db.select().from(workflowRuns).where(eq(workflowRuns.id, stagingRun))
    expect(row!.environmentId).toBe(stagingId)

    const ids = async (cookie: string, url: string) =>
      (
        (await env.app.inject({ method: 'GET', url, headers: { cookie } })).json().runs as { id: string }[]
      ).map((r) => r.id)
    expect(await ids(memberCookie, `/api/v1/workflows/${wf.slug}/runs`)).not.toContain(stagingRun)
    expect(await ids(memberCookie, '/api/v1/runs')).not.toContain(stagingRun)
    expect(await ids(adminCookie, `/api/v1/workflows/${wf.slug}/runs`)).toContain(stagingRun)
    expect(await ids(adminCookie, '/api/v1/runs')).toContain(stagingRun)
    const one = (cookie: string) =>
      env.app.inject({ method: 'GET', url: `/api/v1/runs/${stagingRun}`, headers: { cookie } })
    expect((await one(memberCookie)).statusCode).toBe(404)
    expect((await one(adminCookie)).statusCode).toBe(200)
  })
})

describe('apps', () => {
  it("refuses an app's queries in Staging to everyone but admins", async () => {
    const created = data(await admin.mutate('apps.create', { slug: 'board', name: 'Board' }))
    data(
      await admin.mutate('apps.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [{ name: 'script', kind: 'js', code: 'return 1' }],
        },
      }),
    )
    const release = data(await admin.mutate('apps.publish', { appId: created.id, draftRevision: 2 }))
    data(
      await admin.mutate('permissions.set', {
        objectType: 'app',
        objectId: created.id,
        groupId: await allUsers(),
        environmentId: null,
        level: 'use',
      }),
    )
    const run = (client: ReturnType<typeof trpc>, environmentId: string) =>
      client.mutate('apps.runQuery', {
        appId: created.id,
        releaseId: release.id,
        query: 'script',
        environmentId,
        values: {},
      })
    expect(failure(await run(member, stagingId))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only admins can use this environment',
    })
    // Past the environment, the server refuses a browser-side query for its own reason: the check let them through.
    const allowed = { code: 'BAD_REQUEST', message: '"script" is a JS query; it runs in the browser' }
    expect(failure(await run(member, prodId))).toMatchObject(allowed)
    expect(failure(await run(admin, stagingId))).toMatchObject(allowed)
  })
})

describe('releases', () => {
  const publish = (client: ReturnType<typeof trpc>, wf: { id: string; revision: number }) =>
    client.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision })

  it('lets only admins release a schedule in Staging', async () => {
    const wf = await workflowWith(
      'hourly',
      definition({
        schedules: [{ name: 'hourly', enabled: true, cron: '0 * * * *', environment: 'staging' }],
      }),
    )
    expect(failure(await publish(member, wf))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Schedule "hourly" runs in Staging, which only admins can use',
    })
    data(await publish(admin, wf))
  })

  it('lets only admins release a webhook named for Staging; "all" leaves Staging out', async () => {
    const named = await workflowWith(
      'hook',
      definition({ webhook: { enabled: true, environments: ['staging'] } }),
    )
    expect(failure(await publish(member, named))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'The webhook runs in Staging, which only admins can use',
    })
    data(await publish(admin, named))

    // An API-key webhook runs in every environment unless it says otherwise: every one but Staging now.
    const everywhere = await workflowWith('hook-all', definition({ webhook: { enabled: true } }))
    data(await publish(member, everywhere))
    const { key } = data(await admin.mutate('apiKeys.create', { name: 'all' }))
    const call = (environment: string) =>
      env.app.inject({
        method: 'POST',
        url: `/api/v1/workflows/hook-all/webhook?environment=${environment}`,
        headers: { 'x-api-key': key },
      })
    const res = await call('staging')
    expect(res.statusCode).toBe(403)
    expect(res.json().error.message).toBe("This webhook doesn't run in Staging")
    expect((await call('production')).statusCode).toBeLessThan(300)
  })

  it("hides Staging's schedules and webhook environments from everyone else", async () => {
    const wf = await workflowWith(
      'twice',
      definition({
        schedules: [
          { name: 'prod', enabled: true, cron: '0 1 * * *' },
          { name: 'stage', enabled: true, cron: '0 2 * * *', environment: 'staging' },
        ],
        webhook: { enabled: true, environments: ['production', 'staging'] },
      }),
    )
    data(await publish(admin, wf))
    const triggers = async (client: ReturnType<typeof trpc>) =>
      (data(await client.query('workflows.triggers', { id: wf.id })) as { name: string }[])
        .map((t) => t.name)
        .sort()
    expect(await triggers(admin)).toEqual(['prod', 'stage', 'webhook'])
    expect(await triggers(member)).toEqual(['prod', 'webhook'])

    const environmentsIn = async (cookie: string) => {
      const doc = (
        await env.app.inject({ method: 'GET', url: '/api/v1/openapi.json', headers: { cookie } })
      ).json()
      const post = doc.paths['/workflows/twice/webhook'].post
      return post.parameters.find((p: { name: string }) => p.name === 'environment').schema.enum
    }
    expect(await environmentsIn(adminCookie)).toEqual(['production', 'staging'])
    expect(await environmentsIn(memberCookie)).toEqual(['production'])
  })
})

describe('resource-wide changes', () => {
  it('leaves deleting a resource with settings in Staging to admins', async () => {
    const resource = data(
      await admin.mutate('resources.create', { type: 'postgres', name: 'Shop', slug: 'shop' }),
    )
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: resource.id,
        groupId: await allUsers(),
        environmentId: null,
        level: 'own',
      }),
    )
    const url = new URL(env.databaseUrl)
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: resource.id,
        environmentId: stagingId,
        config: { host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: 'u' },
        secrets: {},
      }),
    )
    expect(failure(await member.mutate('resources.delete', { id: resource.id }))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only admins can delete this resource: it has settings in Staging',
    })
    data(await admin.mutate('resources.delete', { id: resource.id }))
  })
})
