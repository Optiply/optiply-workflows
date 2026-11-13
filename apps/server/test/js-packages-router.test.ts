import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditEvents } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

/** The editor's routes for JavaScript packages: `jsPackages.state` and `.install`, for workflows and apps. */

let env: TestEnv
let registry: TestRegistry
let work: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let workflowId: string
let appId: string

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

beforeAll(async () => {
  registry = await startTestRegistry([
    { name: 'pad', version: '1.0.0', files: { 'index.js': 'module.exports = (s) => `[${s}]`' } },
    {
      name: 'needs-fs',
      version: '1.0.0',
      files: { 'index.js': 'const fs = require("fs")\nexports.read = (p) => fs.readFileSync(p)' },
    },
  ])
  work = await mkdtemp(join(tmpdir(), 'ow-js-packages-test-'))
  env = await startTestApp({ NPM_REGISTRY_URL: registry.url, COMPONENT_BUILD_DIR: work })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  workflowId = data(await admin.mutate('workflows.create', { slug: 'pkgs', name: 'Packages' })).id
  appId = data(await admin.mutate('apps.create', { slug: 'pkgs-app', name: 'Packages app' })).id
}, 60_000)
afterAll(async () => {
  await env?.stop()
  await registry?.stop()
  await rm(work, { recursive: true, force: true })
})

describe('jsPackages routes', () => {
  it('reports nothing yet, installs, then reports the versions; a new bundle is audited once', async () => {
    const target = { kind: 'workflow', id: workflowId }
    expect(data(await admin.query('jsPackages.state', { target, packages: ['pad@^1'] }))).toEqual({
      state: 'none',
    })
    const installed = data(await admin.mutate('jsPackages.install', { target, packages: ['pad@^1'] }))
    expect(installed).toMatchObject({ state: 'ready', versions: { pad: '1.0.0' }, warnings: [] })
    expect(installed.sizeBytes).toBeGreaterThan(0)
    expect(data(await admin.query('jsPackages.state', { target, packages: ['pad@^1'] }))).toMatchObject({
      state: 'ready',
      versions: { pad: '1.0.0' },
    })
    // Again: found, not built, not audited again.
    data(await admin.mutate('jsPackages.install', { target, packages: ['pad@^1'] }))
    const audits = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'js.bundle_built'), eq(auditEvents.objectId, workflowId)))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      objectType: 'workflow',
      metadata: { packages: ['pad@^1'], versions: { pad: '1.0.0' } },
    })
  })

  it('works for apps, and passes on Node built-in warnings', async () => {
    const target = { kind: 'app', id: appId }
    const installed = data(await admin.mutate('jsPackages.install', { target, packages: ['needs-fs'] }))
    expect(installed).toMatchObject({
      state: 'ready',
      warnings: ["needs-fs uses Node's fs, which the sandbox doesn't have: it fails if that part is used"],
    })
    const [audit] = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'js.bundle_built'), eq(auditEvents.objectId, appId)))
    expect(audit).toMatchObject({ objectType: 'app' })
  })

  it('says what is wrong: bad lines without building, a failed install with npm’s reason', async () => {
    const target = { kind: 'workflow', id: workflowId }
    expect(data(await admin.query('jsPackages.state', { target, packages: ['user/repo'] }))).toMatchObject({
      state: 'invalid',
      error: expect.stringContaining('GitHub repository'),
    })
    expect(data(await admin.mutate('jsPackages.install', { target, packages: ['Bad'] }))).toMatchObject({
      state: 'invalid',
    })
    const failed = data(await admin.mutate('jsPackages.install', { target, packages: ['no-such-pkg'] }))
    expect(failed).toMatchObject({ state: 'failed', kind: 'install' })
    expect(data(await admin.query('jsPackages.state', { target, packages: ['no-such-pkg'] }))).toMatchObject({
      state: 'failed',
      kind: 'install',
      error: failed.error,
    })
    expect(data(await admin.query('jsPackages.state', { target, packages: [] }))).toEqual({ state: 'none' })
  })

  it('is for people who can edit the workflow or app', async () => {
    for (const target of [
      { kind: 'workflow', id: workflowId },
      { kind: 'app', id: appId },
    ]) {
      const res = await member.mutate('jsPackages.install', { target, packages: ['pad'] })
      expect(res.status).toBe(404)
    }
    const unknown = await admin.query('jsPackages.state', {
      target: { kind: 'app', id: '00000000-0000-4000-8000-000000000000' },
      packages: ['pad'],
    })
    expect(unknown.status).toBe(404)
  })
})
