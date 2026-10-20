import {
  type AppDefinition,
  appDefinitionHash,
  appDefinitionSchema,
  emptyModule,
  validateApp,
} from '@ow/app-definition'
import { type Module, moduleReleases, modules, permissions, users } from '@ow/db'
import { workflowSlugSchema } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { checkApp } from '../../services/apps'
import { inUseMessage, usedByView } from '../../services/dependents'
import { branchDraftDefinition } from '../../services/git/branch-drafts'
import { requireRollbackAllowed, requireUnprotected } from '../../services/git/protection'
import {
  moduleInfos,
  moduleReleasesByKey,
  moduleUsers,
  publishModuleRelease,
  runModuleDraftQuery,
  setLiveModuleRelease,
} from '../../services/modules'
import {
  type Access,
  atLeast,
  checkFolderMove,
  checkFolderType,
  loadAccess,
  requireLevel,
} from '../../services/permissions'
import { invalidInput, uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
/** How apps place it, so it's a stable identifier. */
const Slug = workflowSlugSchema
const Name = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).nullish()
const QueryName = z.string().max(64)

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** The module and the caller's access; modules the caller can't see are NOT_FOUND. */
async function visibleModule(
  ctx: AuthedContext,
  where: { id: string } | { slug: string },
): Promise<{ access: Access; module: Module }> {
  const access = await loadAccess(ctx.db, ctx.user)
  const [module] = await ctx.db
    .select()
    .from(modules)
    .where('id' in where ? eq(modules.id, where.id) : eq(modules.slug, where.slug))
  if (!module || access.moduleLevel(module) === null) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Module not found' })
  }
  return { access, module }
}

const summary = (m: Module, access: Access) => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  description: m.description,
  folderId: m.folderId,
  liveReleaseId: m.liveReleaseId,
  gitProtected: m.gitProtected,
  updatedAt: m.updatedAt,
  level: access.moduleLevel(m)!,
})

/** What a release offers an app: its inputs, outputs and events with their descriptions. */
const interfaceOf = (def: AppDefinition) => ({
  inputs: (def.module?.inputs ?? []).map(({ name, description }) => ({
    name,
    ...(description && { description }),
  })),
  outputs: (def.module?.outputs ?? []).map(({ name, description }) => ({
    name,
    ...(description && { description }),
  })),
  events: (def.module?.events ?? []).map(({ name, description }) => ({
    name,
    ...(description && { description }),
  })),
})

/**
 * Modules (M14): reusable pieces of app with inputs, outputs and events, placed in apps. Built like apps: a draft
 * people with Edit change (autosaved, optimistic concurrency), semver releases, and the live release instances
 * following `latest` run. Use lets someone place it in an app.
 */
export const modulesRouter = router({
  /** The modules the caller has any access to, with the live release's version. */
  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const rows = await ctx.db
      .select({ module: modules, liveVersion: moduleReleases.version })
      .from(modules)
      .leftJoin(moduleReleases, eq(moduleReleases.id, modules.liveReleaseId))
      .orderBy(asc(modules.name))
    return rows
      .filter((r) => access.moduleLevel(r.module) !== null)
      .map((r) => ({ ...summary(r.module, access), liveVersion: r.liveVersion }))
  }),

  /** For the editor: the draft with its diagnostics (connector and library checks included) and the live release. */
  get: authedProcedure
    .input(z.union([z.object({ id: Id }), z.object({ slug: Slug })]))
    .query(async ({ ctx, input }) => {
      const { access, module } = await visibleModule(ctx, input)
      requireLevel(access.moduleLevel(module), 'edit', 'this module')
      const [live] = module.liveReleaseId
        ? await ctx.db.select().from(moduleReleases).where(eq(moduleReleases.id, module.liveReleaseId))
        : []
      return {
        ...summary(module, access),
        draftDefinition: module.draftDefinition,
        draftRevision: module.draftRevision,
        draftHash: await appDefinitionHash(module.draftDefinition),
        diagnostics: (await checkApp(ctx.db, module.draftDefinition)).diagnostics,
        liveRelease: live
          ? {
              id: live.id,
              version: live.version,
              definitionHash: live.definitionHash,
              createdAt: live.createdAt,
            }
          : null,
      }
    }),

  create: authedProcedure
    .input(z.object({ slug: Slug, name: Name, description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateModules) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all modules to create one',
        })
      }
      await checkFolderType(ctx.db, 'module', input.folderId)
      const [module] = await uniqueOr('A module with that slug already exists', () =>
        ctx.db
          .insert(modules)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: emptyModule(),
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'module.created',
        objectType: 'module',
        objectId: module!.id,
        metadata: { slug: input.slug },
      })
      return summary(module!, access)
    }),

  update: authedProcedure
    .input(z.object({ id: Id, name: Name.optional(), description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, module } = await visibleModule(ctx, input)
      requireLevel(access.moduleLevel(module), 'edit', 'this module')
      // The name and description live in the repo; the folder is the instance's.
      if (input.name !== undefined || input.description !== undefined) {
        requireUnprotected(module, 'module', 'rename it or change its description')
      }
      await checkFolderMove(ctx.db, {
        type: 'module',
        level: access.moduleLevel(module),
        from: module.folderId,
        to: input.folderId,
      })
      const { id, ...changes } = input
      const [updated] = await ctx.db
        .update(modules)
        .set({ ...changes, updatedBy: ctx.user.id })
        .where(eq(modules.id, id))
        .returning()
      await ctx.audit({ action: 'module.updated', objectType: 'module', objectId: id, metadata: changes })
      return summary(updated!, access)
    }),

  /**
   * Saves the draft if nobody saved since `revision` (CONFLICT otherwise). It must match the app schema and be a
   * module (have its `module` part), but may otherwise be invalid while it's edited.
   */
  saveDraft: authedProcedure
    .input(z.object({ id: Id, revision: z.number().int().positive(), definition: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const { access, module } = await visibleModule(ctx, input)
      requireLevel(access.moduleLevel(module), 'edit', 'this module')
      requireUnprotected(module, 'module', 'edit it')
      const parsed = appDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw invalidInput('module definition', parsed.error.issues)
      const definition: AppDefinition = parsed.data
      if (!definition.module) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A module definition needs its module part' })
      }
      const [saved] = await ctx.db
        .update(modules)
        .set({ draftDefinition: definition, draftRevision: input.revision + 1, updatedBy: ctx.user.id })
        .where(and(eq(modules.id, input.id), eq(modules.draftRevision, input.revision)))
        .returning({ revision: modules.draftRevision })
      if (!saved) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Someone else saved this module since revision ${input.revision}; reload to get their changes`,
        })
      }
      return {
        revision: saved.revision,
        draftHash: await appDefinitionHash(definition),
        diagnostics: validateApp(definition).diagnostics,
      }
    }),

  /** The apps placing it (draft, live release or a Git branch draft): the ones the caller sees, and how many others. */
  usedBy: authedProcedure.input(z.object({ moduleId: Id })).query(async ({ ctx, input }) => {
    const { access, module } = await visibleModule(ctx, { id: input.moduleId })
    const users = await moduleUsers(ctx.db, module.slug)
    return usedByView(access, users)
  }),

  /**
   * What the app editor's validator needs for the modules an app places (`ModuleInfo` by slug: the live version
   * and each release's interface), plus their names; the ones the caller can't see are left out.
   */
  resolve: authedProcedure
    // Whatever the draft holds: a malformed slug is just not found (the validator reports it), not a failed request.
    .input(z.object({ slugs: z.array(z.string().max(200)).max(200) }))
    .query(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      const infos = await moduleInfos(ctx.db, [...new Set(input.slugs)])
      return Object.fromEntries(
        [...infos]
          .filter(([, { module }]) => access.moduleLevel(module) !== null)
          .map(([slug, { module, info }]) => [slug, { id: module.id, name: module.name, ...info }]),
      )
    }),

  /**
   * The module releases named by `slug@version` keys, for running an app's draft in its editor (M14); only modules
   * the caller may use (running the draft needs it), others are left out.
   */
  instanceReleases: authedProcedure
    .input(z.object({ keys: z.array(z.string().max(200)).max(200) }))
    .query(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      return moduleReleasesByKey(ctx.db, input.keys, (m) => atLeast(access.moduleLevel(m), 'use'))
    }),

  /** Deletes the module with its releases and grants; refused while apps place it. */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, module } = await visibleModule(ctx, input)
    requireLevel(access.moduleLevel(module), 'own', 'this module')
    const users = await moduleUsers(ctx.db, module.slug)
    if (users.length)
      throw new TRPCError({ code: 'CONFLICT', message: inUseMessage(access, users, 'module') })
    await ctx.db.transaction(async (tx) => {
      await tx.delete(modules).where(eq(modules.id, input.id))
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'module'), eq(permissions.objectId, input.id)))
    })
    await ctx.audit({
      action: 'module.deleted',
      objectType: 'module',
      objectId: input.id,
      metadata: { slug: module.slug },
    })
    return { ok: true }
  }),

  /** Releases, newest first, with what each offers an app (inputs, outputs, events). Use is enough. */
  releases: authedProcedure.input(z.object({ moduleId: Id })).query(async ({ ctx, input }) => {
    const { module } = await visibleModule(ctx, { id: input.moduleId })
    const rows = await ctx.db
      .select({ release: moduleReleases, author: { id: users.id, name: users.name, email: users.email } })
      .from(moduleReleases)
      .leftJoin(users, eq(users.id, moduleReleases.createdBy))
      .where(eq(moduleReleases.moduleId, module.id))
      .orderBy(desc(moduleReleases.createdAt), desc(moduleReleases.id))
    return rows.map(({ release, author }) => ({
      id: release.id,
      version: release.version,
      notes: release.notes,
      interface: interfaceOf(release.definition),
      definitionHash: release.definitionHash,
      createdAt: release.createdAt,
      createdBy: author,
      gitCommit: release.gitCommit,
      live: release.id === module.liveReleaseId,
    }))
  }),

  /** Releases the draft at `draftRevision` and makes it live (`version`, or `bump` from the latest; first 1.0.0). */
  publish: authedProcedure
    .input(
      z.object({
        moduleId: Id,
        draftRevision: z.number().int().positive(),
        version: z.string().max(40).optional(),
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, module } = await visibleModule(ctx, { id: input.moduleId })
      requireUnprotected(module, 'module', 'publish it')
      const release = await publishModuleRelease(ctx.db, access, ctx.user, {
        module,
        draftRevision: input.draftRevision,
        version: input.version,
        bump: input.bump,
        notes: input.notes,
      })
      await ctx.audit({
        action: 'module.release_published',
        objectType: 'module',
        objectId: module.id,
        metadata: { releaseId: release.id, version: release.version, definitionHash: release.definitionHash },
      })
      return { id: release.id, version: release.version, definitionHash: release.definitionHash }
    }),

  /** Makes another release live (rollback, or forward again): instances following `latest` run it. */
  setLive: authedProcedure
    .input(z.object({ moduleId: Id, releaseId: Id }))
    .mutation(async ({ ctx, input }) => {
      const { access, module } = await visibleModule(ctx, { id: input.moduleId })
      requireRollbackAllowed(module, 'module', ctx.user)
      const release = await setLiveModuleRelease(ctx.db, access, { module, releaseId: input.releaseId })
      await ctx.audit({
        action: 'module.release_live',
        objectType: 'module',
        objectId: module.id,
        metadata: {
          releaseId: release.id,
          version: release.version,
          previousReleaseId: module.liveReleaseId,
        },
      })
      return { id: release.id, version: release.version }
    }),

  /**
   * Runs one of the draft's server queries from the module's editor (Edit on the module, Use on what the query
   * reaches), with the values the browser evaluated. Manual ones are audited without values.
   */
  runQuery: authedProcedure
    .input(
      z.object({
        moduleId: Id,
        /** A Git branch draft (M14) instead of the main draft. */
        branchDraftId: Id.optional(),
        query: QueryName,
        environmentId: Id,
        values: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const { access, module } = await visibleModule(ctx, { id: input.moduleId })
      const definition = input.branchDraftId
        ? ((await branchDraftDefinition(ctx.db, 'module', module.id, input.branchDraftId)) as AppDefinition)
        : undefined
      const { outcome, manual } = await runModuleDraftQuery(
        { db: ctx.db, keyring: ctx.config.keyring, pool: ctx.services.pool, sandbox: ctx.services.sandbox },
        access,
        ctx.user,
        {
          module,
          ...(definition && { definition }),
          query: input.query,
          environmentId: input.environmentId,
          values: input.values,
          ...(signal && { signal }),
        },
      )
      if (manual) {
        await ctx.audit({
          action: 'module.query_run',
          objectType: 'module',
          objectId: module.id,
          environmentId: input.environmentId,
          metadata: {
            query: input.query,
            version: 'draft',
            ok: outcome.ok,
            errorCode: outcome.ok ? undefined : outcome.error.code,
            durationMs: outcome.durationMs,
          },
        })
      }
      return outcome
    }),
})
