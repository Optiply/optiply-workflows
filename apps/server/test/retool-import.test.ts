import { auditEvents, retoolImports, retoolMappings, workflows } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appExport, plugin, workflowExport } from '../../../packages/retool-import/test/fixtures'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/** Importing Retool exports (M36 step 6): analyze, then import; re-importing updates; mappings are remembered. */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>

type Res = {
  status: number
  body: { result?: { data: unknown }; error?: { message: string; data?: { code?: string } } }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}
const failure = (res: Res) => res.body.error

const TOKEN = 'sk_live_51HxAbCdEfGhIjKlMnOp'

/** A Retool workflow: a webhook, a SQL query on Retool's "Orders DB", a REST call with a token written in. */
const workflowFile = () =>
  JSON.stringify(
    workflowExport(
      [
        {
          uuid: 'b0',
          pluginId: 'startTrigger',
          blockType: 'webhook',
          top: 0,
          left: 0,
          options: {},
          incomingOnSuccessEdges: [],
        },
        {
          uuid: 'b1',
          pluginId: 'getOrders',
          blockType: 'default',
          editorType: 'SqlQueryUnified',
          resourceName: 'orders-uuid',
          top: 0,
          left: 300,
          incomingOnSuccessEdges: ['b0'],
        },
        {
          uuid: 'b2',
          pluginId: 'notify',
          blockType: 'default',
          editorType: 'RESTQuery',
          resourceName: 'REST-WithoutResource',
          top: 0,
          left: 600,
          incomingOnSuccessEdges: ['b1'],
        },
      ],
      [
        plugin('getOrders', {
          type: 'datasource',
          subtype: 'SqlQueryUnified',
          resourceName: 'orders-uuid',
          template: { query: 'select 1 as n' },
        }),
        plugin('notify', {
          type: 'datasource',
          subtype: 'RESTQuery',
          template: {
            type: 'POST',
            query: 'https://hooks.example.com/x',
            headers: JSON.stringify([{ key: 'Authorization', value: `Bearer ${TOKEN}` }]),
            bodyType: 'none',
          },
        }),
      ],
    ),
  )

/** A Retool app running a Retool workflow, reading Retool's "Orders DB". */
const appFile = () => {
  const exported = appExport([
    plugin('total', {
      subtype: 'TextWidget2',
      template: { value: '{{ getOrders.data.length }}' },
      position: { container: '', row: 0, col: 0, width: 6, height: 1 },
    }),
    plugin('getOrders', {
      type: 'datasource',
      subtype: 'SqlQueryUnified',
      resourceName: 'orders-uuid',
      template: { query: 'select 1' },
    }),
    plugin('start', {
      type: 'datasource',
      subtype: 'WorkflowRun',
      resourceName: 'WorkflowRun',
      template: { workflowId: 'retool-wf-1', workflowParams: '{}' },
    }),
  ])
  // biome-ignore lint/suspicious/noExplicitAny: a fixture's name
  ;(exported as any).uuid = '11111111-2222-4333-8444-555555555555'
  return JSON.stringify(exported)
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  data(await admin.mutate('resources.create', { type: 'postgres', name: 'Orders DB', slug: 'orders_db' }))
})

afterAll(async () => {
  await env?.stop()
})

describe('retool import', () => {
  let workflowId: string

  it('analyzes a file: what it is, what it needs, and resources that look alike', async () => {
    const analysis = data(
      await admin.mutate('retoolImport.analyze', {
        expect: 'workflow',
        fileName: 'Sync%20orders.json',
        content: workflowFile(),
      }),
    )
    expect(analysis).toMatchObject({
      kind: 'workflow',
      name: 'Sync orders',
      update: null,
      remembered: { resources: {} },
    })
    expect(analysis.report.resources).toEqual([
      expect.objectContaining({ key: 'orders-uuid', mapped: false, kind: 'sql' }),
      expect.objectContaining({ key: 'REST-WithoutResource', slug: 'rest_api', mapped: true }),
    ])
    expect(analysis.report.secrets).toEqual([
      { where: 'notify header Authorization', configVar: 'RETOOL_SECRET_1' },
    ])
    // No suggestion: Retool's label is the uuid here (exports name resources by uuid or name).
    expect(analysis.suggested).toEqual({})
    expect(
      failure(
        await admin.mutate('retoolImport.analyze', {
          expect: 'app',
          fileName: 'x.json',
          content: workflowFile(),
        }),
      ),
    ).toMatchObject({
      message: 'This is a Retool workflow: import it from Workflows',
    })
    expect(
      failure(
        await admin.mutate('retoolImport.analyze', {
          expect: 'app',
          fileName: 'x.json',
          content: '{"a": 1}',
        }),
      ),
    ).toMatchObject({
      message: "This isn't a Retool app or workflow export",
    })
  })

  it('imports a workflow, remembers the mapping and the import, keeps the report but no secret', async () => {
    const result = data(
      await admin.mutate('retoolImport.run', {
        expect: 'workflow',
        fileName: 'Sync%20orders.json',
        content: workflowFile(),
        resources: { 'orders-uuid': 'orders_db' },
      }),
    )
    expect(result).toMatchObject({
      kind: 'workflow',
      slug: 'sync-orders',
      name: 'Sync orders',
      mode: 'created',
    })
    workflowId = result.id
    const [wf] = await env.db.select().from(workflows).where(eq(workflows.id, workflowId))
    expect(wf!.draftDefinition.blocks.map((b: { name: string }) => b.name)).toEqual([
      'startTrigger',
      'getOrders',
      'notify',
    ])
    expect(JSON.stringify(wf!.draftDefinition)).toContain('"resource":"orders_db"')
    expect(JSON.stringify(wf!.draftDefinition)).not.toContain(TOKEN)
    const [record] = await env.db.select().from(retoolImports).where(eq(retoolImports.workflowId, workflowId))
    expect(record).toMatchObject({
      kind: 'workflow',
      retoolKey: 'name:Sync orders',
      retoolName: 'Sync orders',
    })
    expect(JSON.stringify(record!.report)).not.toContain(TOKEN)
    expect(await env.db.select().from(retoolMappings)).toEqual([
      expect.objectContaining({ kind: 'resource', retoolKey: 'orders-uuid' }),
    ])
    const audits = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'retool.imported'))
    expect(audits.at(-1)).toMatchObject({
      objectId: workflowId,
      metadata: expect.objectContaining({ mode: 'created', configVarsToSet: 1 }),
    })
    const report = data(await admin.query('retoolImport.reportFor', { kind: 'workflow', id: workflowId }))
    expect(report).toMatchObject({ retoolName: 'Sync orders', report: { kind: 'workflow' } })
  })

  it('re-imports as a new draft of the same workflow (mapping remembered), or as a copy', async () => {
    const analysis = data(
      await admin.mutate('retoolImport.analyze', {
        expect: 'workflow',
        fileName: 'Sync%20orders.json',
        content: workflowFile(),
      }),
    )
    expect(analysis).toMatchObject({
      update: { id: workflowId, slug: 'sync-orders' },
      remembered: { resources: { 'orders-uuid': 'orders_db' } },
    })
    const again = data(
      await admin.mutate('retoolImport.run', {
        expect: 'workflow',
        fileName: 'Sync%20orders.json',
        content: workflowFile(),
      }),
    )
    expect(again).toMatchObject({ id: workflowId, mode: 'updated' })
    const [wf] = await env.db.select().from(workflows).where(eq(workflows.id, workflowId))
    expect(wf!.draftRevision).toBe(3)
    expect(JSON.stringify(wf!.draftDefinition)).toContain('"resource":"orders_db"')
    const copy = data(
      await admin.mutate('retoolImport.run', {
        expect: 'workflow',
        fileName: 'Sync%20orders.json',
        content: workflowFile(),
        copy: true,
      }),
    )
    expect(copy).toMatchObject({ slug: 'sync-orders-2', mode: 'copied' })
    expect(copy.id).not.toBe(workflowId)
    const [record] = await env.db
      .select()
      .from(retoolImports)
      .where(eq(retoolImports.retoolKey, 'name:Sync orders'))
    expect(record!.workflowId).toBe(workflowId)
  })

  it('tells workflows apart by name: their webhook "uuid" is startTrigger in every Retool export', async () => {
    const other = JSON.parse(workflowFile())
    other.name = 'Another flow'
    other.triggerWebhooks[0].uuid = 'startTrigger'
    const result = data(
      await admin.mutate('retoolImport.run', {
        expect: 'workflow',
        fileName: 'another.json',
        content: JSON.stringify(other),
      }),
    )
    expect(result).toMatchObject({ name: 'Another flow', mode: 'created' })
    expect(result.id).not.toBe(workflowId)
  })

  it('imports an app, its Retool workflow mapped to one of ours', async () => {
    const analysis = data(
      await admin.mutate('retoolImport.analyze', {
        expect: 'app',
        fileName: 'Order%20Desk.json',
        content: appFile(),
      }),
    )
    expect(analysis.report.workflows).toEqual([
      { key: 'retool-wf-1', slug: expect.stringMatching(/^retool-/), mapped: false, usedBy: ['start'] },
    ])
    expect(analysis.remembered.resources).toEqual({ 'orders-uuid': 'orders_db' })
    const result = data(
      await admin.mutate('retoolImport.run', {
        expect: 'app',
        fileName: 'Order%20Desk.json',
        content: appFile(),
        workflows: { 'retool-wf-1': 'sync-orders' },
      }),
    )
    expect(result).toMatchObject({ kind: 'app', slug: 'order-desk', mode: 'created' })
    const app = data(await admin.query('apps.get', { id: result.id }))
    expect(app.draftDefinition.queries).toEqual([
      expect.objectContaining({ name: 'getOrders', resource: 'orders_db' }),
      expect.objectContaining({ name: 'start', kind: 'workflow', workflow: 'sync-orders' }),
    ])
    expect(await env.db.select().from(retoolMappings).where(eq(retoolMappings.kind, 'workflow'))).toEqual([
      expect.objectContaining({ retoolKey: 'retool-wf-1', workflowId }),
    ])
  })

  it("doesn't tell someone who can't edit it which app or workflow an export became (review)", async () => {
    const analysis = data(
      await member.mutate('retoolImport.analyze', {
        expect: 'workflow',
        fileName: 'Sync%20orders.json',
        content: workflowFile(),
      }),
    )
    expect(analysis.update).toBeNull()
  })

  it('needs what creating needs, and mappings only to what the person can use', async () => {
    expect(
      failure(
        await member.mutate('retoolImport.run', {
          expect: 'workflow',
          fileName: 'other.json',
          content: workflowFile(),
          copy: true,
        }),
      ),
    ).toMatchObject({
      data: { code: 'FORBIDDEN' },
    })
    expect(
      failure(
        await member.mutate('retoolImport.run', {
          expect: 'workflow',
          fileName: 'other.json',
          content: workflowFile(),
          resources: { 'orders-uuid': 'orders_db' },
        }),
      ),
    ).toMatchObject({ message: `You can't use a resource "orders_db"` })
  })
})

/**
 * The real exports on this machine (never committed), through the router, as the import dialog sends them:
 *   RETOOL_EXPORTS_DIR=~/Desktop/retool_exports pnpm --filter @ow/server exec vitest run test/retool-import.test.ts
 * Prints counts and timings only.
 */
const exportsDir = process.env.RETOOL_EXPORTS_DIR?.replace(/^~(?=\/)/, process.env.HOME ?? '~')
describe.skipIf(!exportsDir)('real exports (RETOOL_EXPORTS_DIR)', () => {
  it('imports every workflow, then every app', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const lines: string[] = []
    for (const kind of ['workflow', 'app'] as const) {
      const dir = `${exportsDir}/${kind}s`
      for (const [i, file] of readdirSync(dir).entries()) {
        const content = readFileSync(`${dir}/${file}`, 'utf8')
        const started = performance.now()
        const analysis = data(
          await admin.mutate('retoolImport.analyze', { expect: kind, fileName: file, content }),
        )
        const analyzed = Math.round(performance.now() - started)
        const result = data(
          await admin.mutate('retoolImport.run', { expect: kind, fileName: file, content, copy: true }),
        )
        const total = Math.round(performance.now() - started)
        const c = result.report.counts
        lines.push(
          `${kind} #${i + 1}: ${Math.round(content.length / 1024)} KB, analyze ${analyzed} ms, import ${total - analyzed} ms; ` +
            `converted ${c.converted}, approximated ${c.approximated}, unsupported ${c.unsupported}, skipped ${c.skipped}; ` +
            `resources ${analysis.report.resources.length}, errors ${result.report.diagnostics.length}`,
        )
      }
    }
    console.log(lines.join('\n'))
  }, 120_000)
})
