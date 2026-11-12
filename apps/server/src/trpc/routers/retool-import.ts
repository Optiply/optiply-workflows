import {
  apps,
  environments,
  type RetoolImport,
  resources,
  retoolImports,
  retoolMappings,
  workflows,
} from '@ow/db'
import {
  convertApp,
  convertWorkflow,
  type ImportReport,
  type RetoolExport,
  RetoolReadError,
  readRetoolExport,
} from '@ow/retool-import'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { atLeast, loadAccess } from '../../services/permissions'
import { authedProcedure, type Context, createCallerFactory, router } from '../init'
import { appsRouter } from './apps'
import { workflowsRouter } from './workflows'

/**
 * Importing apps and workflows from Retool's JSON exports (M36, architecture §2.40). One file a request (exports can
 * be a few MB; the API takes 10 MB). `analyze` reads it and says what an import would do; `run` imports it: a new app
 * or workflow, or a new draft of the one this Retool app or workflow became before (`copy` makes a new one anyway).
 * The export itself is never stored: the import keeps its report.
 */

const Id = z.string().uuid()
const Kind = z.enum(['app', 'workflow'])
const MAX_EXPORT_CHARS = 10_000_000
const fileInput = {
  /** Which list the person imports from: a file of the other kind is refused, saying where it goes. */
  expect: Kind,
  fileName: z.string().max(500),
  content: z.string().max(MAX_EXPORT_CHARS),
}
const mapping = z.record(z.string().max(500), z.string().max(63)).default({})

const createWorkflowCaller = createCallerFactory(workflowsRouter)
const createAppCaller = createCallerFactory(appsRouter)

type Ctx = Context & { user: NonNullable<Context['user']> }

/** The export, read, of the kind expected. */
function readExport(input: { expect: 'app' | 'workflow'; fileName: string; content: string }): RetoolExport {
  let read: RetoolExport
  try {
    read = readRetoolExport(input.content, { fileName: input.fileName })
  } catch (err) {
    if (err instanceof RetoolReadError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    throw err
  }
  if (read.kind !== input.expect) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        read.kind === 'app'
          ? 'This is a Retool app: import it from Apps'
          : 'This is a Retool workflow: import it from Workflows',
    })
  }
  return read
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What identifies a Retool app or workflow across exports: an app's uuid. A workflow export carries none of its own,
 * and its webhook trigger's "uuid" is `startTrigger` in every workflow: its name, then (a real uuid there).
 */
export function retoolKeyOf(read: RetoolExport): string {
  if (read.kind === 'app') return read.uuid || `name:${read.name}`
  const hook = read.webhooks.find((w) => w.uuid && UUID.test(w.uuid))?.uuid
  return hook ? `webhook:${hook}` : `name:${read.name}`
}

/** Who may use what: the person's access and the environments (a resource is usable with Use in any of them). */
async function usage(ctx: Ctx) {
  const [access, envs] = await Promise.all([
    loadAccess(ctx.db, ctx.user),
    ctx.db.select({ id: environments.id }).from(environments),
  ])
  const canUse = (resource: typeof resources.$inferSelect) =>
    // Built-in resources are everyone's.
    !!resource.systemKind || envs.some((env) => atLeast(access.level(resource, env.id), 'use'))
  return { access, canUse }
}
type Usage = Awaited<ReturnType<typeof usage>>

/** Remembered mappings (Retool key → our slug) for the keys given, of resources and workflows the person can use. */
async function rememberedMappings(ctx: Ctx, use: Usage, keys: { resources: string[]; workflows: string[] }) {
  const resourceMap: Record<string, string> = {}
  const workflowMap: Record<string, string> = {}
  if (keys.resources.length) {
    const rows = await ctx.db
      .select({ key: retoolMappings.retoolKey, resource: resources })
      .from(retoolMappings)
      .innerJoin(resources, eq(resources.id, retoolMappings.resourceId))
      .where(and(eq(retoolMappings.kind, 'resource'), inArray(retoolMappings.retoolKey, keys.resources)))
    for (const { key, resource } of rows) if (use.canUse(resource)) resourceMap[key] = resource.slug
  }
  if (keys.workflows.length) {
    const rows = await ctx.db
      .select({ key: retoolMappings.retoolKey, workflow: workflows })
      .from(retoolMappings)
      .innerJoin(workflows, eq(workflows.id, retoolMappings.workflowId))
      .where(and(eq(retoolMappings.kind, 'workflow'), inArray(retoolMappings.retoolKey, keys.workflows)))
    for (const { key, workflow } of rows) {
      if (use.access.workflowLevel(workflow) !== null) workflowMap[key] = workflow.slug
    }
  }
  return { resources: resourceMap, workflows: workflowMap }
}

/** A dry conversion: what importing would make, with remembered mappings over the given ones. */
async function convert(
  ctx: Ctx,
  use: Usage,
  read: RetoolExport,
  given: { resources: Record<string, string>; workflows: Record<string, string> },
) {
  // First pass to learn the keys, then with what's remembered and given.
  const first = read.kind === 'app' ? convertApp(read) : convertWorkflow(read)
  const remembered = await rememberedMappings(ctx, use, {
    resources: first.report.resources.map((r) => r.key),
    workflows: first.report.workflows.map((w) => w.key),
  })
  const mappings = {
    resources: { ...remembered.resources, ...given.resources },
    workflows: { ...remembered.workflows, ...given.workflows },
  }
  const result =
    read.kind === 'app'
      ? convertApp(read, { resources: mappings.resources, workflows: mappings.workflows })
      : convertWorkflow(read, { resources: mappings.resources })
  return { ...result, remembered, mappings }
}

/** Our resources that look like a Retool one by name, for the mapping step. */
async function suggestions(ctx: Ctx, use: Usage, report: ImportReport) {
  const all = await ctx.db.select().from(resources)
  const usable = all.filter((r) => use.canUse(r))
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const out: Record<string, string> = {}
  for (const need of report.resources) {
    if (need.mapped) continue
    const label = norm(need.label)
    const match = usable.find((r) => norm(r.name) === label || norm(r.slug) === label)
    if (match) out[need.key] = match.slug
  }
  return out
}

async function existingImport(ctx: Ctx, kind: 'app' | 'workflow', retoolKey: string) {
  const [row] = await ctx.db
    .select()
    .from(retoolImports)
    .where(and(eq(retoolImports.kind, kind), eq(retoolImports.retoolKey, retoolKey)))
  if (!row) return null
  if (kind === 'app') {
    const [app] = await ctx.db.select().from(apps).where(eq(apps.id, row.appId!))
    return app ? { row, id: app.id, slug: app.slug, name: app.name, revision: app.draftRevision } : null
  }
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, row.workflowId!))
  return workflow
    ? { row, id: workflow.id, slug: workflow.slug, name: workflow.name, revision: workflow.draftRevision }
    : null
}

/** A free slug from a name: `Order Desk` → `order-desk`, then `order-desk-2`… */
async function freeSlug(ctx: Ctx, kind: 'app' | 'workflow', name: string): Promise<string> {
  const base =
    `${name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/, '')}`.slice(0, 50) || `retool-${kind}`
  const stem = base.length < 2 ? `${base}-${kind}` : base
  const table = kind === 'app' ? apps : workflows
  const taken = new Set(
    (await ctx.db.select({ slug: table.slug }).from(table)).map((r: { slug: string }) => r.slug),
  )
  if (!taken.has(stem)) return stem
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`
}

export const retoolImportRouter = router({
  /** What importing this file would do: its kind and name, new or an update, the report, the mappings it needs. */
  analyze: authedProcedure.input(z.object(fileInput)).mutation(async ({ ctx, input }) => {
    const read = readExport(input)
    const retoolKey = retoolKeyOf(read)
    const use = await usage(ctx)
    const { report, remembered } = await convert(ctx, use, read, { resources: {}, workflows: {} })
    const existing = await existingImport(ctx, read.kind, retoolKey)
    return {
      kind: read.kind,
      name: read.name,
      update: existing ? { id: existing.id, slug: existing.slug, name: existing.name } : null,
      report,
      remembered: { resources: remembered.resources, workflows: remembered.workflows },
      suggested: await suggestions(ctx, use, report),
    }
  }),

  /**
   * Imports the file: a new draft of what it became before (Edit on it), or a new app or workflow (as creating one
   * needs) in `folderId`. Mappings are remembered for next time, only to resources and workflows the person can use.
   */
  run: authedProcedure
    .input(
      z.object({
        ...fileInput,
        resources: mapping,
        workflows: mapping,
        folderId: Id.nullish(),
        /** A new app or workflow even when this one was imported before. */
        copy: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const read = readExport(input)
      const retoolKey = retoolKeyOf(read)
      const use = await usage(ctx)
      const { definition, report } = await convert(ctx, use, read, {
        resources: input.resources,
        workflows: input.workflows,
      })

      // Mappings given must name resources and workflows the person can use.
      const resourceSlugs = [...new Set(Object.values(input.resources))]
      const resourceRows = resourceSlugs.length
        ? await ctx.db.select().from(resources).where(inArray(resources.slug, resourceSlugs))
        : []
      for (const slug of resourceSlugs) {
        const row = resourceRows.find((r) => r.slug === slug)
        if (!row || !use.canUse(row)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `You can't use a resource "${slug}"` })
        }
      }
      const workflowSlugs = [...new Set(Object.values(input.workflows))]
      const workflowRows = workflowSlugs.length
        ? await ctx.db.select().from(workflows).where(inArray(workflows.slug, workflowSlugs))
        : []
      for (const slug of workflowSlugs) {
        const row = workflowRows.find((w) => w.slug === slug)
        if (!row || use.access.workflowLevel(row) === null) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `You can't see a workflow "${slug}"` })
        }
      }

      const existing = input.copy ? null : await existingImport(ctx, read.kind, retoolKey)
      let target: { id: string; slug: string; name: string }
      let mode: 'created' | 'updated' | 'copied'
      if (read.kind === 'workflow') {
        const caller = createWorkflowCaller(ctx)
        if (existing) {
          await caller.saveDraft({ id: existing.id, revision: existing.revision, definition })
          target = existing
          mode = 'updated'
        } else {
          const slug = await freeSlug(ctx, 'workflow', read.name)
          const created = await caller.create({
            slug,
            name: read.name.slice(0, 120),
            folderId: input.folderId ?? null,
            ...(read.description && { description: read.description.slice(0, 1000) }),
          })
          await caller.saveDraft({ id: created.id, revision: 1, definition })
          target = { id: created.id, slug, name: created.name }
          mode = input.copy ? 'copied' : 'created'
        }
      } else {
        const caller = createAppCaller(ctx)
        if (existing) {
          await caller.saveDraft({ id: existing.id, revision: existing.revision, definition })
          target = existing
          mode = 'updated'
        } else {
          const slug = await freeSlug(ctx, 'app', read.name)
          const created = await caller.create({
            slug,
            name: read.name.slice(0, 120),
            folderId: input.folderId ?? null,
          })
          await caller.saveDraft({ id: created.id, revision: 1, definition })
          target = { id: created.id, slug, name: created.name }
          mode = input.copy ? 'copied' : 'created'
        }
      }

      // The import's record (a copy leaves an earlier record pointing at the original) and its mappings.
      const record = {
        retoolName: read.name.slice(0, 500),
        report,
        importedBy: ctx.user.id,
        updatedAt: new Date(),
        ...(read.kind === 'app'
          ? { appId: target.id, workflowId: null }
          : { workflowId: target.id, appId: null }),
      }
      if (mode !== 'copied' || !(await existingImport(ctx, read.kind, retoolKey))) {
        await ctx.db
          .insert(retoolImports)
          .values({ kind: read.kind, retoolKey, ...record })
          .onConflictDoUpdate({ target: [retoolImports.kind, retoolImports.retoolKey], set: record })
      }
      for (const [key, slug] of Object.entries(input.resources)) {
        const row = resourceRows.find((r) => r.slug === slug)!
        const values = { resourceId: row.id, workflowId: null, updatedBy: ctx.user.id, updatedAt: new Date() }
        await ctx.db
          .insert(retoolMappings)
          .values({ kind: 'resource', retoolKey: key, ...values })
          .onConflictDoUpdate({ target: [retoolMappings.kind, retoolMappings.retoolKey], set: values })
      }
      for (const [key, slug] of Object.entries(input.workflows)) {
        const row = workflowRows.find((w) => w.slug === slug)!
        const values = { workflowId: row.id, resourceId: null, updatedBy: ctx.user.id, updatedAt: new Date() }
        await ctx.db
          .insert(retoolMappings)
          .values({ kind: 'workflow', retoolKey: key, ...values })
          .onConflictDoUpdate({ target: [retoolMappings.kind, retoolMappings.retoolKey], set: values })
      }
      await ctx.audit({
        action: 'retool.imported',
        objectType: read.kind,
        objectId: target.id,
        metadata: {
          retoolName: read.name,
          mode,
          ...report.counts,
          configVarsToSet: new Set(report.secrets.map((s) => s.configVar)).size,
        },
      })
      return { kind: read.kind, ...target, mode, report }
    }),

  /** The report of the import an app or workflow came from, if it did (the editors' "Imported from Retool" note). */
  reportFor: authedProcedure
    .input(z.object({ kind: Kind, id: Id }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<(Pick<RetoolImport, 'retoolName' | 'updatedAt'> & { report: ImportReport }) | null> => {
        const access = await loadAccess(ctx.db, ctx.user)
        if (input.kind === 'app') {
          const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.id))
          if (!app || !atLeast(access.appLevel(app), 'edit')) return null
        } else {
          const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, input.id))
          if (!workflow || !atLeast(access.workflowLevel(workflow), 'edit')) return null
        }
        const [row] = await ctx.db
          .select()
          .from(retoolImports)
          .where(
            input.kind === 'app' ? eq(retoolImports.appId, input.id) : eq(retoolImports.workflowId, input.id),
          )
        return row
          ? { retoolName: row.retoolName, updatedAt: row.updatedAt, report: row.report as ImportReport }
          : null
      },
    ),
})
