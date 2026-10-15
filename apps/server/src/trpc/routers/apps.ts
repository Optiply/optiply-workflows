import {
  type AppDefinition,
  appDefinitionHash,
  appDefinitionSchema,
  emptyApp,
  validateApp,
} from '@ow/app-definition'
import { type App, appReleases, apps, permissions, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { checkApp, publishAppRelease, runAppQuery, setLiveAppRelease } from '../../services/apps'
import { type Access, loadAccess, requireLevel } from '../../services/permissions'
import { invalidInput, uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
/** Appears in the app's URL, so it's a stable identifier. */
const Slug = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{1,62}$/,
    'Use 2–63 lowercase letters, digits, dashes or underscores, starting with a letter',
  )
const Name = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).nullish()
const QueryName = z.string().max(64)

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** The app and the caller's access; apps the caller can't see are NOT_FOUND. */
async function visibleApp(
  ctx: AuthedContext,
  where: { id: string } | { slug: string },
): Promise<{ access: Access; app: App }> {
  const access = await loadAccess(ctx.db, ctx.user)
  const [app] = await ctx.db
    .select()
    .from(apps)
    .where('id' in where ? eq(apps.id, where.id) : eq(apps.slug, where.slug))
  if (!app || access.appLevel(app) === null)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'App not found' })
  return { access, app }
}

const summary = (a: App, access: Access) => ({
  id: a.id,
  slug: a.slug,
  name: a.name,
  description: a.description,
  folderId: a.folderId,
  liveReleaseId: a.liveReleaseId,
  updatedAt: a.updatedAt,
  level: access.appLevel(a)!,
})

async function liveRelease(ctx: AuthedContext, app: App) {
  if (!app.liveReleaseId) return null
  const [release] = await ctx.db.select().from(appReleases).where(eq(appReleases.id, app.liveReleaseId))
  return release ?? null
}

/**
 * Apps: a draft people with Edit change (autosaved, with optimistic concurrency), semver releases, and the live
 * release people with Use open. Queries run on the server by name (`runQuery`); everything else runs in the
 * browser.
 */
export const appsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const rows = await ctx.db.select().from(apps).orderBy(asc(apps.name))
    return rows.filter((a) => access.appLevel(a) !== null).map((a) => summary(a, access))
  }),

  /**
   * For the editor: the draft with its diagnostics (connector checks included) and the live release's version and
   * hash. `draftHash` equals the live release's hash when the draft has no unpublished changes.
   */
  get: authedProcedure
    .input(z.union([z.object({ id: Id }), z.object({ slug: Slug })]))
    .query(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, input)
      requireLevel(access.appLevel(app), 'edit', 'this app')
      const live = await liveRelease(ctx, app)
      return {
        ...summary(app, access),
        draftDefinition: app.draftDefinition,
        draftRevision: app.draftRevision,
        draftHash: await appDefinitionHash(app.draftDefinition),
        diagnostics: (await checkApp(ctx.db, app.draftDefinition)).diagnostics,
        liveRelease: live && {
          id: live.id,
          version: live.version,
          definitionHash: live.definitionHash,
          createdAt: live.createdAt,
        },
      }
    }),

  /** For people using the app: its live release. NOT_FOUND until the first release. */
  open: authedProcedure.input(z.object({ slug: Slug })).query(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, input)
    const live = await liveRelease(ctx, app)
    if (!live) {
      throw new TRPCError({ code: 'NOT_FOUND', message: "This app hasn't been published yet" })
    }
    return {
      ...summary(app, access),
      release: { id: live.id, version: live.version, definition: live.definition, createdAt: live.createdAt },
    }
  }),

  create: authedProcedure
    .input(z.object({ slug: Slug, name: Name, description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateApps) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to all apps to create one' })
      }
      const [app] = await uniqueOr('An app with that slug already exists', () =>
        ctx.db
          .insert(apps)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: emptyApp(),
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'app.created',
        objectType: 'app',
        objectId: app!.id,
        metadata: { slug: input.slug },
      })
      return summary(app!, access)
    }),

  update: authedProcedure
    .input(z.object({ id: Id, name: Name.optional(), description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, input)
      requireLevel(access.appLevel(app), 'edit', 'this app')
      const { id, ...changes } = input
      const [updated] = await ctx.db
        .update(apps)
        .set({ ...changes, updatedBy: ctx.user.id })
        .where(eq(apps.id, id))
        .returning()
      await ctx.audit({ action: 'app.updated', objectType: 'app', objectId: id, metadata: changes })
      return summary(updated!, access)
    }),

  /**
   * Saves the draft if nobody saved since `revision`; a stale revision is CONFLICT. The draft must match the schema
   * but may otherwise be invalid while it's being edited: the diagnostics (from the browser's checks; connector
   * checks come with `get` and publishing) come back.
   */
  saveDraft: authedProcedure
    .input(z.object({ id: Id, revision: z.number().int().positive(), definition: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, input)
      requireLevel(access.appLevel(app), 'edit', 'this app')
      const parsed = appDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw invalidInput('app definition', parsed.error.issues)
      const definition: AppDefinition = parsed.data
      const [saved] = await ctx.db
        .update(apps)
        .set({ draftDefinition: definition, draftRevision: input.revision + 1, updatedBy: ctx.user.id })
        .where(and(eq(apps.id, input.id), eq(apps.draftRevision, input.revision)))
        .returning({ revision: apps.draftRevision })
      if (!saved) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Someone else saved this app since revision ${input.revision}; reload to get their changes`,
        })
      }
      return {
        revision: saved.revision,
        draftHash: await appDefinitionHash(definition),
        diagnostics: validateApp(definition).diagnostics,
      }
    }),

  /** Deletes the app with its releases and grants. */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, input)
    requireLevel(access.appLevel(app), 'own', 'this app')
    await ctx.db.transaction(async (tx) => {
      await tx.delete(apps).where(eq(apps.id, input.id))
      // Grants reference objects polymorphically, so they're removed here rather than by a foreign key.
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'app'), eq(permissions.objectId, input.id)))
    })
    await ctx.audit({
      action: 'app.deleted',
      objectType: 'app',
      objectId: input.id,
      metadata: { slug: app.slug },
    })
    return { ok: true }
  }),

  /** Releases, newest first, without definitions. */
  releases: authedProcedure.input(z.object({ appId: Id })).query(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, { id: input.appId })
    requireLevel(access.appLevel(app), 'edit', 'this app')
    const rows = await ctx.db
      .select({ release: appReleases, author: { id: users.id, name: users.name, email: users.email } })
      .from(appReleases)
      .leftJoin(users, eq(users.id, appReleases.createdBy))
      .where(eq(appReleases.appId, app.id))
      .orderBy(desc(appReleases.createdAt), desc(appReleases.id))
    return rows.map(({ release, author }) => ({
      id: release.id,
      version: release.version,
      notes: release.notes,
      definitionHash: release.definitionHash,
      createdAt: release.createdAt,
      createdBy: author,
      live: release.id === app.liveReleaseId,
    }))
  }),

  /** Releases the draft at `draftRevision` and makes it live (`version`, or `bump` from the latest; first 1.0.0). */
  publish: authedProcedure
    .input(
      z.object({
        appId: Id,
        draftRevision: z.number().int().positive(),
        version: z.string().max(40).optional(),
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, { id: input.appId })
      const release = await publishAppRelease(ctx.db, access, ctx.user, {
        app,
        draftRevision: input.draftRevision,
        version: input.version,
        bump: input.bump,
        notes: input.notes,
      })
      await ctx.audit({
        action: 'app.release_published',
        objectType: 'app',
        objectId: app.id,
        metadata: { releaseId: release.id, version: release.version, definitionHash: release.definitionHash },
      })
      return { id: release.id, version: release.version, definitionHash: release.definitionHash }
    }),

  /** Makes another release live (rollback, or forward again). */
  setLive: authedProcedure.input(z.object({ appId: Id, releaseId: Id })).mutation(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, { id: input.appId })
    const release = await setLiveAppRelease(ctx.db, access, { app, releaseId: input.releaseId })
    await ctx.audit({
      action: 'app.release_live',
      objectType: 'app',
      objectId: app.id,
      metadata: { releaseId: release.id, version: release.version, previousReleaseId: app.liveReleaseId },
    })
    return { id: release.id, version: release.version }
  }),

  /**
   * Runs a resource query of the draft (`releaseId` null) or of the live release in one environment, binding the
   * `values` the browser evaluated (keyed by each `{{ }}`'s code). Manual queries (writes) are audited, without
   * their values; automatic ones (reads, which re-run as people type) aren't.
   */
  runQuery: authedProcedure
    .input(
      z.object({
        appId: Id,
        releaseId: Id.nullable(),
        query: QueryName,
        environmentId: Id,
        values: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const { access, app } = await visibleApp(ctx, { id: input.appId })
      const { outcome, manual, version } = await runAppQuery(
        { db: ctx.db, keyring: ctx.config.keyring, pool: ctx.services.pool, sandbox: ctx.services.sandbox },
        access,
        ctx.user,
        {
          app,
          releaseId: input.releaseId,
          query: input.query,
          environmentId: input.environmentId,
          values: input.values,
          ...(signal && { signal }),
        },
      )
      if (manual) {
        await ctx.audit({
          action: 'app.query_run',
          objectType: 'app',
          objectId: app.id,
          environmentId: input.environmentId,
          metadata: {
            query: input.query,
            version: version ?? 'draft',
            ok: outcome.ok,
            errorCode: outcome.ok ? undefined : outcome.error.code,
            durationMs: outcome.durationMs,
          },
        })
      }
      return outcome
    }),
})
