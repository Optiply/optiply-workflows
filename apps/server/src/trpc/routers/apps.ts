import {
  type AppDefinition,
  appDefinitionHash,
  appDefinitionSchema,
  customInstanceKeys,
  emptyApp,
  instanceKeys,
  MAX_MODULE_DEPTH,
  validateApp,
} from '@ow/app-definition'
import { type App, appReleases, apps, permissions, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getAppVersion, listAppVersions, recordAppVersion } from '../../services/app-history'
import { checkApp, publishAppRelease, runAppQuery, setLiveAppRelease } from '../../services/apps'
import { componentLibraryReleasesByKey } from '../../services/component-libraries'
import { requireGitRepo, requireRollbackAllowed, requireUnprotected } from '../../services/git/protection'
import { instanceStepSchema, moduleReleaseTree } from '../../services/modules'
import {
  type Access,
  checkFolderMove,
  checkFolderType,
  loadAccess,
  requireLevel,
} from '../../services/permissions'
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
export async function visibleApp(
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
  /** Edited on Git branches and deployed from the repo (M11); main is read-only here. */
  gitProtected: a.gitProtected,
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
  /** The apps the user can see, with who edited each last and its live release's version and time (session 40). */
  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const rows = await ctx.db
      .select({
        app: apps,
        editor: users.name,
        liveVersion: appReleases.version,
        publishedAt: appReleases.createdAt,
      })
      .from(apps)
      .leftJoin(users, eq(users.id, apps.updatedBy))
      .leftJoin(appReleases, eq(appReleases.id, apps.liveReleaseId))
      .orderBy(asc(apps.name))
    return rows
      .filter((r) => access.appLevel(r.app) !== null)
      .map(({ app, editor, liveVersion, publishedAt }) => ({
        ...summary(app, access),
        updatedByName: editor,
        liveRelease: liveVersion && publishedAt ? { version: liveVersion, publishedAt } : null,
      }))
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

  /**
   * The caller's level on an app and whether it's live: what the app's page says when it can't open (editors are
   * offered the editor, people with Use are told it isn't published, others that it isn't theirs). An app that
   * doesn't exist and one they can't see answer alike (`level: null`), so nothing about it leaks.
   */
  access: authedProcedure.input(z.object({ slug: Slug })).query(async ({ ctx, input }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const [app] = await ctx.db.select().from(apps).where(eq(apps.slug, input.slug))
    const level = app ? access.appLevel(app) : null
    if (!app || level === null) return { level: null, name: null, published: false }
    return { level, name: app.name, published: app.liveReleaseId !== null }
  }),

  /**
   * For people using the app: its live release, the module releases its instances run (M14) and the component
   * library releases its custom components run (M25, its modules' too), by `slug@version` (the app's publisher
   * vouched for them; one whose release is gone doesn't run). NOT_FOUND until the first release.
   */
  open: authedProcedure.input(z.object({ slug: Slug })).query(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, input)
    const live = await liveRelease(ctx, app)
    if (!live) {
      throw new TRPCError({ code: 'NOT_FOUND', message: "This app hasn't been published yet" })
    }
    return {
      ...summary(app, access),
      release: {
        id: live.id,
        version: live.version,
        definition: live.definition,
        createdAt: live.createdAt,
        /** Its JavaScript packages' bundle, at `/api/js-bundles/<hash>.js`; null without packages. */
        jsBundleHash: live.jsBundleHash,
      },
      ...(await placedReleases(ctx.db, live.definition)),
    }
  }),

  /** `protected`: made in Git from the start (edited on branches; the first merge deploys it). */
  create: authedProcedure
    .input(
      z.object({
        slug: Slug,
        name: Name,
        description: Description,
        folderId: Id.nullish(),
        protected: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateApps) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to all apps to create one' })
      }
      await checkFolderType(ctx.db, 'app', input.folderId)
      if (input.protected) await requireGitRepo(ctx.db, ctx.config)
      const [app] = await uniqueOr('An app with that slug already exists', () =>
        ctx.db
          .insert(apps)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: emptyApp(),
            gitProtected: input.protected ?? false,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'app.created',
        objectType: 'app',
        objectId: app!.id,
        metadata: { slug: input.slug, ...(input.protected ? { protected: true } : {}) },
      })
      return summary(app!, access)
    }),

  update: authedProcedure
    .input(z.object({ id: Id, name: Name.optional(), description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, input)
      requireLevel(access.appLevel(app), 'edit', 'this app')
      // The name, description and folder live in the repo (the folder since M22).
      if (input.name !== undefined || input.description !== undefined) {
        requireUnprotected(app, 'app', 'rename it or change its description')
      }
      if (input.folderId !== undefined && input.folderId !== app.folderId) {
        requireUnprotected(app, 'app', 'move it to another folder')
      }
      await checkFolderMove(ctx.db, {
        type: 'app',
        level: access.appLevel(app),
        from: app.folderId,
        to: input.folderId,
      })
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
      requireUnprotected(app, 'app', 'edit it')
      const parsed = appDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw invalidInput('app definition', parsed.error.issues)
      const definition: AppDefinition = parsed.data
      // The draft and its history entry together (session 41): one can't be saved without the other, and a collab
      // save can't come between them.
      const saved = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(apps)
          .set({ draftDefinition: definition, draftRevision: input.revision + 1, updatedBy: ctx.user.id })
          .where(and(eq(apps.id, input.id), eq(apps.draftRevision, input.revision)))
          .returning({ revision: apps.draftRevision })
        if (!row) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Someone else saved this app since revision ${input.revision}; reload to get their changes`,
          })
        }
        await recordAppVersion(tx, {
          appId: input.id,
          definition,
          revision: row.revision,
          userId: ctx.user.id,
        })
        return row
      })
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
    if (app.gitProtected) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This app is kept in Git: unprotect it before deleting it',
      })
    }
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

  /**
   * A copy of an app's draft under a new slug and name (session 40, as workflows have): no releases, not in Git,
   * in the same folder unless another is given. Needs Edit on the original (Use opens the live app without its draft,
   * which a copy would show) and the right to create apps.
   */
  duplicate: authedProcedure
    .input(
      z.object({
        id: Id,
        slug: Slug,
        name: Name,
        folderId: Id.nullish(),
        /** A version from the app's history (session 41) instead of its draft. */
        fromVersionId: Id.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, { id: input.id })
      requireLevel(access.appLevel(app), 'edit', 'this app')
      if (!access.canCreateApps) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to all apps to create one' })
      }
      const version = input.fromVersionId
        ? await getAppVersion(ctx.db, app.id, input.fromVersionId)
        : undefined
      if (input.fromVersionId && !version)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That version is no longer in the history' })
      const folderId = input.folderId === undefined ? app.folderId : input.folderId
      await checkFolderType(ctx.db, 'app', folderId)
      const [copy] = await uniqueOr('An app with that slug already exists', () =>
        ctx.db
          .insert(apps)
          .values({
            slug: input.slug,
            name: input.name,
            description: app.description,
            folderId,
            draftDefinition: version?.definition ?? app.draftDefinition,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'app.created',
        objectType: 'app',
        objectId: copy!.id,
        metadata: {
          slug: input.slug,
          duplicateOf: { id: app.id, slug: app.slug },
          ...(version && { fromVersion: { id: version.id, revision: version.revision } }),
        },
      })
      return summary(copy!, access)
    }),

  /**
   * The draft's history (session 41), newest first, a page at a time: each entry's label parts, who and when. Edit
   * access, as for the draft itself.
   */
  history: authedProcedure
    .input(
      z.object({
        appId: Id,
        before: z.object({ updatedAt: z.coerce.date(), id: Id }).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { access, app } = await visibleApp(ctx, { id: input.appId })
      requireLevel(access.appLevel(app), 'edit', 'this app')
      const page = await listAppVersions(ctx.db, app.id, input.before ? { before: input.before } : {})
      const authorIds = [...new Set(page.versions.flatMap((v) => (v.createdBy ? [v.createdBy] : [])))]
      const authors = authorIds.length
        ? await ctx.db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(inArray(users.id, authorIds))
        : []
      const byId = new Map(authors.map((a) => [a.id, a]))
      return {
        versions: page.versions.map((v) => ({
          ...v,
          author: v.createdBy ? (byId.get(v.createdBy) ?? null) : null,
        })),
        more: page.more,
      }
    }),

  /** One version of the draft (session 41), to compare with the draft or preview. */
  historyVersion: authedProcedure.input(z.object({ appId: Id, id: Id })).query(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, { id: input.appId })
    requireLevel(access.appLevel(app), 'edit', 'this app')
    const version = await getAppVersion(ctx.db, app.id, input.id)
    if (!version)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'That version is no longer in the history' })
    return {
      id: version.id,
      revision: version.revision,
      definition: version.definition,
      updatedAt: version.updatedAt,
    }
  }),

  /**
   * Makes a version the draft again (session 41): the draft is replaced (open editors fold it in, as after any save
   * from elsewhere) and the restore is a history entry of its own. Not on a Git-protected app's main draft.
   */
  restoreVersion: authedProcedure.input(z.object({ appId: Id, id: Id })).mutation(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, { id: input.appId })
    requireLevel(access.appLevel(app), 'edit', 'this app')
    requireUnprotected(app, 'app', 'restore a version')
    const revision = await ctx.db.transaction(async (tx) => {
      const version = await getAppVersion(tx, app.id, input.id)
      if (!version)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That version is no longer in the history' })
      const [locked] = await tx.select().from(apps).where(eq(apps.id, app.id)).for('update')
      if (!locked) throw new TRPCError({ code: 'NOT_FOUND', message: 'The app was deleted meanwhile' })
      const next = locked.draftRevision + 1
      await tx
        .update(apps)
        .set({ draftDefinition: version.definition, draftRevision: next, updatedBy: ctx.user.id })
        .where(eq(apps.id, app.id))
      await recordAppVersion(tx, {
        appId: app.id,
        definition: version.definition,
        revision: next,
        userId: ctx.user.id,
        restoredFrom: version.id,
      })
      return next
    })
    await ctx.audit({
      action: 'app.draft_restored',
      objectType: 'app',
      objectId: app.id,
      metadata: { slug: app.slug, version: input.id },
    })
    return { revision }
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
      /** Set on releases deployed from Git (made by Git sync: `createdBy` is null). */
      gitCommit: release.gitCommit,
      live: release.id === app.liveReleaseId,
    }))
  }),

  /** One release with its definition, to compare it with another or the draft (M24). */
  release: authedProcedure.input(z.object({ appId: Id, id: Id })).query(async ({ ctx, input }) => {
    const { access, app } = await visibleApp(ctx, { id: input.appId })
    requireLevel(access.appLevel(app), 'edit', 'this app')
    const [release] = await ctx.db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.id, input.id), eq(appReleases.appId, app.id)))
    if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
    return { id: release.id, version: release.version, definition: release.definition }
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
      requireUnprotected(app, 'app', 'publish it')
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
    requireRollbackAllowed(app, 'app', ctx.user)
    const release = await setLiveAppRelease(ctx.db, access, {
      app,
      releaseId: input.releaseId,
      actorUserId: ctx.user.id,
    })
    await ctx.audit({
      action: 'app.release_live',
      objectType: 'app',
      objectId: app.id,
      metadata: {
        releaseId: release.id,
        version: release.version,
        previousReleaseId: app.liveReleaseId,
        ...(app.gitProtected ? { emergency: true } : {}),
      },
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
        /** With `releaseId` null: a Git branch draft (M11) instead of the main draft. */
        branchDraftId: Id.optional(),
        query: QueryName,
        /**
         * A module instance's query (M14): the instances from the app to it, outermost first (M21: modules inside
         * modules), each with the module release the page runs.
         */
        module: z.array(instanceStepSchema).min(1).max(MAX_MODULE_DEPTH).optional(),
        environmentId: Id,
        values: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const { access, app } = await visibleApp(ctx, { id: input.appId })
      const { outcome, manual, version, library, module } = await runAppQuery(
        { db: ctx.db, keyring: ctx.config.keyring, pool: ctx.services.pool, sandbox: ctx.services.sandbox },
        access,
        ctx.user,
        {
          app,
          releaseId: input.releaseId,
          branchDraftId: input.branchDraftId,
          query: input.query,
          ...(input.module && { module: input.module }),
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
            ...(module && {
              module: `${input.module!.map((m) => m.instance).join('/')}: ${module.slug}@${module.version}`,
            }),
            ...(library && { library: `${library.slug}@${library.version}` }),
            ok: outcome.ok,
            errorCode: outcome.ok ? undefined : outcome.error.code,
            durationMs: outcome.durationMs,
          },
        })
      }
      return outcome
    }),
})

/** The module releases a definition's instances run, and the library releases its custom components (and its modules') run. */
async function placedReleases(db: Context['db'], definition: AppDefinition) {
  const modules = await moduleReleaseTree(db, instanceKeys(definition))
  const keys = [definition, ...Object.values(modules).map((m) => m.definition)].flatMap(customInstanceKeys)
  return { modules, libraries: await componentLibraryReleasesByKey(db, keys) }
}
