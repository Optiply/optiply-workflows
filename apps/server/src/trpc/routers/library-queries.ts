import {
  emptyLibraryQuery,
  type LibraryQueryDefinition,
  libraryQueryDefinitionSchema,
  libraryQueryHash,
  validateLibraryQuery,
} from '@ow/app-definition'
import { type LibraryQuery, libraryQueries, libraryQueryReleases, permissions, users } from '@ow/db'
import { type LibraryInfo, workflowSlugSchema } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { inUseMessage, usedByView } from '../../services/dependents'
import { branchDraftDefinition } from '../../services/git/branch-drafts'
import { requireRollbackAllowed, requireUnprotected } from '../../services/git/protection'
import {
  checkLibraryQuery,
  libraryInfos,
  libraryUsers,
  publishLibraryRelease,
  runLibraryDraft,
  setLiveLibraryRelease,
} from '../../services/library-queries'
import {
  type Access,
  checkFolderMove,
  checkFolderType,
  loadAccess,
  requireLevel,
} from '../../services/permissions'
import { droppedUses } from '../../services/publish-impact'
import { invalidInput, uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
/** How apps reference it, so it's a stable identifier. */
const Slug = workflowSlugSchema
const Name = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).nullish()

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** The library query and the caller's access; ones the caller can't see are NOT_FOUND. */
async function visibleQuery(
  ctx: AuthedContext,
  where: { id: string } | { slug: string },
): Promise<{ access: Access; query: LibraryQuery }> {
  const access = await loadAccess(ctx.db, ctx.user)
  const [query] = await ctx.db
    .select()
    .from(libraryQueries)
    .where('id' in where ? eq(libraryQueries.id, where.id) : eq(libraryQueries.slug, where.slug))
  if (!query || access.libraryQueryLevel(query) === null) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Library query not found' })
  }
  return { access, query }
}

const summary = (q: LibraryQuery, access: Access) => ({
  id: q.id,
  slug: q.slug,
  name: q.name,
  description: q.description,
  folderId: q.folderId,
  liveReleaseId: q.liveReleaseId,
  gitProtected: q.gitProtected,
  updatedAt: q.updatedAt,
  level: access.libraryQueryLevel(q)!,
})

/**
 * The Query Library (M14): resource queries with parameters, written once and used by many apps. Built like apps:
 * a draft people with Edit change (autosaved, optimistic concurrency), semver releases, and the live release apps
 * following `latest` run. Use lets someone use it in an app; the draft runs from its editor (`run`).
 */
export const libraryQueriesRouter = router({
  /** Everyone sees the library queries they have any access to, with the live release's version. */
  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const rows = await ctx.db
      .select({ query: libraryQueries, liveVersion: libraryQueryReleases.version })
      .from(libraryQueries)
      .leftJoin(libraryQueryReleases, eq(libraryQueryReleases.id, libraryQueries.liveReleaseId))
      .orderBy(asc(libraryQueries.name))
    return rows
      .filter((r) => access.libraryQueryLevel(r.query) !== null)
      .map((r) => ({ ...summary(r.query, access), liveVersion: r.liveVersion }))
  }),

  /** For the editor: the draft with its diagnostics (the connector's checks included) and the live release. */
  get: authedProcedure
    .input(z.union([z.object({ id: Id }), z.object({ slug: Slug })]))
    .query(async ({ ctx, input }) => {
      const { access, query } = await visibleQuery(ctx, input)
      requireLevel(access.libraryQueryLevel(query), 'edit', 'this library query')
      const live = query.liveReleaseId
        ? (
            await ctx.db
              .select()
              .from(libraryQueryReleases)
              .where(eq(libraryQueryReleases.id, query.liveReleaseId))
          )[0]
        : undefined
      return {
        ...summary(query, access),
        draftDefinition: query.draftDefinition,
        draftRevision: query.draftRevision,
        draftHash: await libraryQueryHash(query.draftDefinition),
        diagnostics: (await checkLibraryQuery(ctx.db, query.draftDefinition)).diagnostics,
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
      if (!access.canCreateLibraryQueries) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all library queries to create one',
        })
      }
      await checkFolderType(ctx.db, 'library_query', input.folderId)
      const [query] = await uniqueOr('A library query with that slug already exists', () =>
        ctx.db
          .insert(libraryQueries)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: emptyLibraryQuery(),
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'library_query.created',
        objectType: 'library_query',
        objectId: query!.id,
        metadata: { slug: input.slug },
      })
      return summary(query!, access)
    }),

  update: authedProcedure
    .input(z.object({ id: Id, name: Name.optional(), description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, query } = await visibleQuery(ctx, input)
      requireLevel(access.libraryQueryLevel(query), 'edit', 'this library query')
      // The name, description and folder live in the repo (the folder since M22).
      if (input.name !== undefined || input.description !== undefined) {
        requireUnprotected(query, 'library_query', 'rename it or change its description')
      }
      if (input.folderId !== undefined && input.folderId !== query.folderId) {
        requireUnprotected(query, 'library_query', 'move it to another folder')
      }
      await checkFolderMove(ctx.db, {
        type: 'library_query',
        level: access.libraryQueryLevel(query),
        from: query.folderId,
        to: input.folderId,
      })
      const { id, ...changes } = input
      const [updated] = await ctx.db
        .update(libraryQueries)
        .set({ ...changes, updatedBy: ctx.user.id })
        .where(eq(libraryQueries.id, id))
        .returning()
      await ctx.audit({
        action: 'library_query.updated',
        objectType: 'library_query',
        objectId: id,
        metadata: changes,
      })
      return summary(updated!, access)
    }),

  /**
   * Saves the draft if nobody saved since `revision` (CONFLICT otherwise). It must match the schema but may be
   * invalid while it's being edited; the diagnostics come back (without the connector's: `get` and publishing).
   */
  saveDraft: authedProcedure
    .input(z.object({ id: Id, revision: z.number().int().positive(), definition: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const { access, query } = await visibleQuery(ctx, input)
      requireLevel(access.libraryQueryLevel(query), 'edit', 'this library query')
      requireUnprotected(query, 'library_query', 'edit it')
      const parsed = libraryQueryDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw invalidInput('library query', parsed.error.issues)
      const definition: LibraryQueryDefinition = parsed.data
      const [saved] = await ctx.db
        .update(libraryQueries)
        .set({ draftDefinition: definition, draftRevision: input.revision + 1, updatedBy: ctx.user.id })
        .where(and(eq(libraryQueries.id, input.id), eq(libraryQueries.draftRevision, input.revision)))
        .returning({ revision: libraryQueries.draftRevision })
      if (!saved) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Someone else saved this library query since revision ${input.revision}; reload to get their changes`,
        })
      }
      return {
        revision: saved.revision,
        draftHash: await libraryQueryHash(definition),
        diagnostics: validateLibraryQuery(definition).diagnostics,
      }
    }),

  /**
   * The apps using it (in their draft, live release or a Git branch draft): the ones the caller can see, and how
   * many others.
   */
  usedBy: authedProcedure.input(z.object({ libraryQueryId: Id })).query(async ({ ctx, input }) => {
    const { access, query } = await visibleQuery(ctx, { id: input.libraryQueryId })
    const users = await libraryUsers(ctx.db, query.slug)
    return usedByView(access, users)
  }),

  /**
   * For the publish dialog (M21): the parameters the live release declares and the draft doesn't, and the apps,
   * modules and workflows on `latest` passing them (a warning; publishing isn't refused).
   */
  publishImpact: authedProcedure.input(z.object({ libraryQueryId: Id })).query(async ({ ctx, input }) => {
    const { access, query } = await visibleQuery(ctx, { id: input.libraryQueryId })
    requireLevel(access.libraryQueryLevel(query), 'edit', 'this library query')
    const [live] = query.liveReleaseId
      ? await ctx.db
          .select()
          .from(libraryQueryReleases)
          .where(eq(libraryQueryReleases.id, query.liveReleaseId))
      : []
    return droppedUses(
      ctx.db,
      access,
      {
        kind: 'library',
        slug: query.slug,
        live: live ? live.definition.params.map((p) => p.name) : null,
        draft: query.draftDefinition.params.map((p) => p.name),
      },
      await libraryUsers(ctx.db, query.slug),
    )
  }),

  /**
   * What the app editor's validator needs for the library queries an app uses (`LibraryInfo` by slug: the live
   * version and each release's parameters), plus their names; the ones the caller can't see are left out.
   */
  resolve: authedProcedure
    // Whatever the draft holds: a malformed slug is just not found (the validator reports it), not a failed request.
    .input(z.object({ slugs: z.array(z.string().max(200)).max(200) }))
    .query(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      const infos = await libraryInfos(ctx.db, [...new Set(input.slugs)])
      // One the caller may not use says only that (M21): "needs use access", not "unknown", and nothing more.
      return Object.fromEntries(
        [...infos].map(([slug, { query, info }]): [string, LibraryInfo & { id?: string; name?: string }] =>
          access.libraryQueryLevel(query) !== null
            ? [slug, { id: query.id, name: query.name, ...info }]
            : [slug, { liveVersion: null, versions: {}, noUse: true }],
        ),
      )
    }),

  /** Deletes the library query with its releases and grants; refused while apps use it. */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, query } = await visibleQuery(ctx, input)
    requireLevel(access.libraryQueryLevel(query), 'own', 'this library query')
    const users = await libraryUsers(ctx.db, query.slug)
    if (users.length)
      throw new TRPCError({ code: 'CONFLICT', message: inUseMessage(access, users, 'library query') })
    await ctx.db.transaction(async (tx) => {
      await tx.delete(libraryQueries).where(eq(libraryQueries.id, input.id))
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'library_query'), eq(permissions.objectId, input.id)))
    })
    await ctx.audit({
      action: 'library_query.deleted',
      objectType: 'library_query',
      objectId: input.id,
      metadata: { slug: query.slug },
    })
    return { ok: true }
  }),

  /**
   * Releases, newest first, with their resource, query and parameters (what an app using one passes and shows).
   * Use is enough: picking a version in an app needs it.
   */
  releases: authedProcedure.input(z.object({ libraryQueryId: Id })).query(async ({ ctx, input }) => {
    const { query } = await visibleQuery(ctx, { id: input.libraryQueryId })
    const rows = await ctx.db
      .select({
        release: libraryQueryReleases,
        author: { id: users.id, name: users.name, email: users.email },
      })
      .from(libraryQueryReleases)
      .leftJoin(users, eq(users.id, libraryQueryReleases.createdBy))
      .where(eq(libraryQueryReleases.libraryQueryId, query.id))
      .orderBy(desc(libraryQueryReleases.createdAt), desc(libraryQueryReleases.id))
    return rows.map(({ release, author }) => ({
      id: release.id,
      version: release.version,
      notes: release.notes,
      resource: release.definition.resource,
      query: release.definition.query,
      params: release.definition.params.map(({ name, description }) => ({
        name,
        ...(description !== undefined && { description }),
      })),
      definitionHash: release.definitionHash,
      createdAt: release.createdAt,
      createdBy: author,
      gitCommit: release.gitCommit,
      live: release.id === query.liveReleaseId,
    }))
  }),

  /** Releases the draft at `draftRevision` and makes it live (`version`, or `bump` from the latest; first 1.0.0). */
  publish: authedProcedure
    .input(
      z.object({
        libraryQueryId: Id,
        draftRevision: z.number().int().positive(),
        version: z.string().max(40).optional(),
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, query } = await visibleQuery(ctx, { id: input.libraryQueryId })
      requireUnprotected(query, 'library_query', 'publish it')
      const release = await publishLibraryRelease(ctx.db, access, ctx.user, {
        query,
        draftRevision: input.draftRevision,
        version: input.version,
        bump: input.bump,
        notes: input.notes,
      })
      await ctx.audit({
        action: 'library_query.release_published',
        objectType: 'library_query',
        objectId: query.id,
        metadata: { releaseId: release.id, version: release.version, definitionHash: release.definitionHash },
      })
      return { id: release.id, version: release.version, definitionHash: release.definitionHash }
    }),

  /** Makes another release live (rollback, or forward again): apps following `latest` run it. */
  setLive: authedProcedure
    .input(z.object({ libraryQueryId: Id, releaseId: Id }))
    .mutation(async ({ ctx, input }) => {
      const { access, query } = await visibleQuery(ctx, { id: input.libraryQueryId })
      requireRollbackAllowed(query, 'library_query', ctx.user)
      const release = await setLiveLibraryRelease(ctx.db, access, { query, releaseId: input.releaseId })
      await ctx.audit({
        action: 'library_query.release_live',
        objectType: 'library_query',
        objectId: query.id,
        metadata: { releaseId: release.id, version: release.version, previousReleaseId: query.liveReleaseId },
      })
      return { id: release.id, version: release.version }
    }),

  /**
   * Runs the draft in one environment with `params` (the parameters' test values when missing): Edit on the library
   * query and Use on its resource there. Audited like the resource playground, without values.
   */
  run: authedProcedure
    .input(
      z.object({
        libraryQueryId: Id,
        /** A Git branch draft (M14) instead of the main draft. */
        branchDraftId: Id.optional(),
        environmentId: Id,
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const { access, query } = await visibleQuery(ctx, { id: input.libraryQueryId })
      const definition = input.branchDraftId
        ? ((await branchDraftDefinition(
            ctx.db,
            'library_query',
            query.id,
            input.branchDraftId,
          )) as LibraryQueryDefinition)
        : undefined
      const outcome = await runLibraryDraft(
        { db: ctx.db, keyring: ctx.config.keyring, pool: ctx.services.pool, sandbox: ctx.services.sandbox },
        access,
        ctx.user,
        {
          query,
          ...(definition && { definition }),
          environmentId: input.environmentId,
          ...(input.params && { params: input.params }),
          ...(signal && { signal }),
        },
      )
      await ctx.audit({
        action: 'library_query.query_run',
        objectType: 'library_query',
        objectId: query.id,
        environmentId: input.environmentId,
        metadata: {
          version: 'draft',
          ok: outcome.ok,
          errorCode: outcome.ok ? undefined : outcome.error.code,
          durationMs: outcome.durationMs,
        },
      })
      return outcome
    }),
})
