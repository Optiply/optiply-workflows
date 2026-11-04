import {
  type ComponentLibraryDefinition,
  type ComponentLibraryInfo,
  componentLibraryDefinitionSchema,
  componentLibraryHash,
  componentLibraryInterface,
  customComponentSchema,
  emptyComponentLibrary,
  validateComponentLibrary,
} from '@ow/app-definition'
import {
  auditEvents,
  type ComponentLibrary,
  type ComponentLibraryRelease,
  componentLibraries,
  componentLibraryReleases,
  permissions,
  users,
} from '@ow/db'
import { workflowSlugSchema } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  componentLibraryInfos,
  componentLibraryReleasesByKey,
  componentLibraryUsers,
  componentNames,
  originsChanged,
  publishComponentLibraryRelease,
  setLiveComponentLibraryRelease,
  uploadComponentLibraryBuild,
} from '../../services/component-libraries'
import { buildComponentLibrary, componentBuildConfig } from '../../services/components/build'
import { inUseMessage, usedByView } from '../../services/dependents'
import { branchDraftDefinition } from '../../services/git/branch-drafts'
import { requireRollbackAllowed, requireUnprotected } from '../../services/git/protection'
import {
  type Access,
  atLeast,
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

/** The library and the caller's access; ones the caller can't see are NOT_FOUND. */
export async function visibleLibrary(
  ctx: AuthedContext,
  where: { id: string } | { slug: string },
): Promise<{ access: Access; library: ComponentLibrary }> {
  const access = await loadAccess(ctx.db, ctx.user)
  const [library] = await ctx.db
    .select()
    .from(componentLibraries)
    .where('id' in where ? eq(componentLibraries.id, where.id) : eq(componentLibraries.slug, where.slug))
  if (!library || access.componentLibraryLevel(library) === null) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Component library not found' })
  }
  return { access, library }
}

const summary = (l: ComponentLibrary, access: Access) => ({
  id: l.id,
  slug: l.slug,
  name: l.name,
  description: l.description,
  folderId: l.folderId,
  liveReleaseId: l.liveReleaseId,
  gitProtected: l.gitProtected,
  updatedAt: l.updatedAt,
  level: access.componentLibraryLevel(l)!,
})

/** Audits a new release, and an origins change apart (admins look for those). */
async function auditRelease(
  ctx: AuthedContext,
  libraryId: string,
  release: ComponentLibraryRelease,
  originsChanged: boolean,
  extra: Record<string, unknown> = {},
) {
  await ctx.audit({
    action: 'component_library.release_published',
    objectType: 'component_library',
    objectId: libraryId,
    metadata: {
      releaseId: release.id,
      version: release.version,
      definitionHash: release.definitionHash,
      bundleHash: release.bundleHash,
      ...extra,
    },
  })
  if (originsChanged) {
    await ctx.audit({
      action: 'component_library.origins_changed',
      objectType: 'component_library',
      objectId: libraryId,
      metadata: {
        releaseId: release.id,
        version: release.version,
        allowedOrigins: release.definition.allowedOrigins,
      },
    })
  }
}

/**
 * Component libraries (M25): React components written here, built on the server, placed in apps and modules.
 * Built like modules: a draft people with Edit change (autosaved, optimistic concurrency, multiplayer), semver
 * releases with their build, and the live release apps following `latest` run. Use lets someone place them.
 */
export const componentLibrariesRouter = router({
  /** Everyone sees the libraries they have any access to, with the live release's version. */
  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const rows = await ctx.db
      .select({ library: componentLibraries, liveVersion: componentLibraryReleases.version })
      .from(componentLibraries)
      .leftJoin(componentLibraryReleases, eq(componentLibraryReleases.id, componentLibraries.liveReleaseId))
      .orderBy(asc(componentLibraries.name))
    return rows
      .filter((r) => access.componentLibraryLevel(r.library) !== null)
      .map((r) => ({ ...summary(r.library, access), liveVersion: r.liveVersion }))
  }),

  /** For the editor: the draft with its diagnostics, the draft's lock, and the live release. */
  get: authedProcedure
    .input(z.union([z.object({ id: Id }), z.object({ slug: Slug })]))
    .query(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, input)
      requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
      const [live] = library.liveReleaseId
        ? await ctx.db
            .select()
            .from(componentLibraryReleases)
            .where(eq(componentLibraryReleases.id, library.liveReleaseId))
        : []
      return {
        ...summary(library, access),
        draftDefinition: library.draftDefinition,
        draftRevision: library.draftRevision,
        draftHash: await componentLibraryHash(library.draftDefinition),
        draftLock: library.draftLock,
        diagnostics: validateComponentLibrary(library.draftDefinition).diagnostics,
        liveRelease: live
          ? {
              id: live.id,
              version: live.version,
              definitionHash: live.definitionHash,
              allowedOrigins: live.definition.allowedOrigins,
              createdAt: live.createdAt,
            }
          : null,
      }
    }),

  create: authedProcedure
    .input(z.object({ slug: Slug, name: Name, description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateComponentLibraries) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all component libraries to create one',
        })
      }
      await checkFolderType(ctx.db, 'component_library', input.folderId)
      const [library] = await uniqueOr('A component library with that slug already exists', () =>
        ctx.db
          .insert(componentLibraries)
          .values({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            draftDefinition: emptyComponentLibrary(),
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'component_library.created',
        objectType: 'component_library',
        objectId: library!.id,
        metadata: { slug: input.slug },
      })
      return summary(library!, access)
    }),

  update: authedProcedure
    .input(z.object({ id: Id, name: Name.optional(), description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, input)
      requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
      if (input.name !== undefined || input.description !== undefined) {
        requireUnprotected(library, 'component_library', 'rename it or change its description')
      }
      if (input.folderId !== undefined && input.folderId !== library.folderId) {
        requireUnprotected(library, 'component_library', 'move it to another folder')
      }
      await checkFolderMove(ctx.db, {
        type: 'component_library',
        level: access.componentLibraryLevel(library),
        from: library.folderId,
        to: input.folderId,
      })
      const { id, ...changes } = input
      const [updated] = await ctx.db
        .update(componentLibraries)
        .set({ ...changes, updatedBy: ctx.user.id })
        .where(eq(componentLibraries.id, id))
        .returning()
      await ctx.audit({
        action: 'component_library.updated',
        objectType: 'component_library',
        objectId: id,
        metadata: changes,
      })
      return summary(updated!, access)
    }),

  /**
   * Saves the draft if nobody saved since `revision` (CONFLICT otherwise). It must match the schema but may be
   * invalid while it's being edited; the diagnostics come back. Allowed origins may change here: publishing a
   * release whose origins differ from the live one's needs an admin.
   */
  saveDraft: authedProcedure
    .input(z.object({ id: Id, revision: z.number().int().positive(), definition: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, input)
      requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
      requireUnprotected(library, 'component_library', 'edit it')
      const parsed = componentLibraryDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw invalidInput('component library', parsed.error.issues)
      const definition: ComponentLibraryDefinition = parsed.data
      const [saved] = await ctx.db
        .update(componentLibraries)
        .set({ draftDefinition: definition, draftRevision: input.revision + 1, updatedBy: ctx.user.id })
        .where(and(eq(componentLibraries.id, input.id), eq(componentLibraries.draftRevision, input.revision)))
        .returning({ revision: componentLibraries.draftRevision })
      if (!saved) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Someone else saved this component library since revision ${input.revision}; reload to get their changes`,
        })
      }
      // A push from the components CLI (M33: a token's save): open editors say so and rebuild their Preview.
      if (ctx.token) {
        await ctx.audit({
          action: 'component_library.draft_pushed',
          objectType: 'component_library',
          objectId: library.id,
          metadata: { revision: saved.revision },
        })
      }
      return {
        revision: saved.revision,
        draftHash: await componentLibraryHash(definition),
        diagnostics: validateComponentLibrary(definition).diagnostics,
      }
    }),

  /** The draft's last push from the components CLI (M33): when, by whom, at which revision; null if none. */
  lastPush: authedProcedure.input(z.object({ componentLibraryId: Id })).query(async ({ ctx, input }) => {
    const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
    requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
    const [row] = await ctx.db
      .select({ at: auditEvents.at, name: users.name, email: users.email, metadata: auditEvents.metadata })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(
        and(
          eq(auditEvents.action, 'component_library.draft_pushed'),
          eq(auditEvents.objectType, 'component_library'),
          eq(auditEvents.objectId, library.id),
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(1)
    if (!row) return null
    const revision = typeof row.metadata?.revision === 'number' ? row.metadata.revision : null
    return { at: row.at, by: row.name || row.email || 'someone', revision }
  }),

  /**
   * Builds the draft (or a Git branch draft): Edit. The packages are installed from the lock the draft's last build
   * left, which the build then replaces; a build of the same files, dependencies and lock is found, not redone.
   * Problems come back with their file, line and column.
   */
  build: authedProcedure
    .input(z.object({ componentLibraryId: Id, branchDraftId: Id.optional() }))
    .mutation(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
      requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
      const definition = input.branchDraftId
        ? ((await branchDraftDefinition(
            ctx.db,
            'component_library',
            library.id,
            input.branchDraftId,
          )) as ComponentLibraryDefinition)
        : library.draftDefinition
      const outcome = await buildComponentLibrary(
        ctx.db,
        componentBuildConfig(ctx.config),
        definition,
        library.draftLock,
      )
      if (outcome.ok && !input.branchDraftId && outcome.lock !== library.draftLock) {
        await ctx.db
          .update(componentLibraries)
          .set({ draftLock: outcome.lock })
          .where(eq(componentLibraries.id, library.id))
      }
      return outcome
    }),

  /**
   * For the publish dialog: the components and props the live release has and the draft doesn't, and the apps and
   * modules on `latest` placing or setting them (a warning), plus whether the allowed origins change (an admin's).
   */
  publishImpact: authedProcedure.input(z.object({ componentLibraryId: Id })).query(async ({ ctx, input }) => {
    const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
    requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
    const [live] = library.liveReleaseId
      ? await ctx.db
          .select()
          .from(componentLibraryReleases)
          .where(eq(componentLibraryReleases.id, library.liveReleaseId))
      : []
    const impact = await droppedUses(
      ctx.db,
      access,
      {
        kind: 'components',
        slug: library.slug,
        live: live ? componentNames(live.definition) : null,
        draft: componentNames(library.draftDefinition),
      },
      await componentLibraryUsers(ctx.db, library.slug),
    )
    return {
      ...impact,
      originsChanged: originsChanged(
        library.draftDefinition.allowedOrigins,
        live?.definition.allowedOrigins ?? [],
      ),
    }
  }),

  /** Builds the draft at `draftRevision`, releases it and makes it live (`version`, or `bump`; first 1.0.0). */
  publish: authedProcedure
    .input(
      z.object({
        componentLibraryId: Id,
        draftRevision: z.number().int().positive(),
        version: z.string().max(40).optional(),
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
      requireUnprotected(library, 'component_library', 'publish it')
      const { release, originsChanged } = await publishComponentLibraryRelease(
        ctx.db,
        componentBuildConfig(ctx.config),
        access,
        ctx.user,
        {
          library,
          draftRevision: input.draftRevision,
          version: input.version,
          bump: input.bump,
          notes: input.notes,
        },
      )
      await auditRelease(ctx, library.id, release, originsChanged)
      return {
        id: release.id,
        version: release.version,
        definitionHash: release.definitionHash,
        bundleHash: release.bundleHash,
      }
    }),

  /**
   * A release from a bundle built elsewhere (a CLI): its JS, CSS and declared components. Edit; changing the allowed
   * origins needs an admin, as for publishing.
   */
  uploadBuild: authedProcedure
    .input(
      z.object({
        componentLibraryId: Id,
        js: z.string().min(1),
        css: z.string().default(''),
        components: z.array(customComponentSchema).min(1).max(100),
        allowedOrigins: z.array(z.string().max(300)).max(50).optional(),
        version: z.string().max(40).optional(),
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
      requireUnprotected(library, 'component_library', 'upload a build')
      const { componentLibraryId: _, ...rest } = input
      const { release, originsChanged } = await uploadComponentLibraryBuild(ctx.db, access, ctx.user, {
        library,
        ...rest,
      })
      await auditRelease(ctx, library.id, release, originsChanged, { uploaded: true })
      return { id: release.id, version: release.version, bundleHash: release.bundleHash }
    }),

  /** Makes another release live (rollback, or forward again): apps following `latest` run it. */
  setLive: authedProcedure
    .input(z.object({ componentLibraryId: Id, releaseId: Id }))
    .mutation(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
      requireRollbackAllowed(library, 'component_library', ctx.user)
      const release = await setLiveComponentLibraryRelease(ctx.db, access, {
        library,
        releaseId: input.releaseId,
      })
      await ctx.audit({
        action: 'component_library.release_live',
        objectType: 'component_library',
        objectId: library.id,
        metadata: {
          releaseId: release.id,
          version: release.version,
          previousReleaseId: library.liveReleaseId,
        },
      })
      return { id: release.id, version: release.version }
    }),

  /** The apps and modules placing its components: the ones the caller can see, and how many others. */
  usedBy: authedProcedure.input(z.object({ componentLibraryId: Id })).query(async ({ ctx, input }) => {
    const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
    return usedByView(access, await componentLibraryUsers(ctx.db, library.slug))
  }),

  /**
   * What the app editor needs for the libraries an app uses (`ComponentLibraryInfo` by slug: the live version and
   * each release's components), plus their names; one the caller may not use says only that.
   */
  resolve: authedProcedure
    .input(z.object({ slugs: z.array(z.string().max(200)).max(200) }))
    .query(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      const infos = await componentLibraryInfos(ctx.db, [...new Set(input.slugs)])
      return Object.fromEntries(
        [...infos].map(
          ([slug, { library, info }]): [string, ComponentLibraryInfo & { id?: string; name?: string }] =>
            access.componentLibraryLevel(library) !== null
              ? [slug, { id: library.id, name: library.name, ...info }]
              : [slug, { liveVersion: null, versions: {}, noUse: true }],
        ),
      )
    }),

  /**
   * The library releases named by `slug@version` keys, for running an app's or module's draft in its editor; only
   * libraries the caller may use, others are left out (their components don't run).
   */
  instanceReleases: authedProcedure
    .input(z.object({ keys: z.array(z.string().max(200)).max(200) }))
    .query(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      return componentLibraryReleasesByKey(ctx.db, input.keys, (l) =>
        atLeast(access.componentLibraryLevel(l), 'use'),
      )
    }),

  /** Deletes the library with its releases and grants; refused while apps or modules use it. */
  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, library } = await visibleLibrary(ctx, input)
    requireLevel(access.componentLibraryLevel(library), 'own', 'this component library')
    const used = await componentLibraryUsers(ctx.db, library.slug)
    if (used.length) {
      throw new TRPCError({ code: 'CONFLICT', message: inUseMessage(access, used, 'component library') })
    }
    await ctx.db.transaction(async (tx) => {
      await tx.delete(componentLibraries).where(eq(componentLibraries.id, input.id))
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'component_library'), eq(permissions.objectId, input.id)))
    })
    await ctx.audit({
      action: 'component_library.deleted',
      objectType: 'component_library',
      objectId: input.id,
      metadata: { slug: library.slug },
    })
    return { ok: true }
  }),

  /** Releases, newest first, with their components (what picking a version in an app shows). Use is enough. */
  releases: authedProcedure.input(z.object({ componentLibraryId: Id })).query(async ({ ctx, input }) => {
    const { library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
    const rows = await ctx.db
      .select({
        release: componentLibraryReleases,
        author: { id: users.id, name: users.name, email: users.email },
      })
      .from(componentLibraryReleases)
      .leftJoin(users, eq(users.id, componentLibraryReleases.createdBy))
      .where(eq(componentLibraryReleases.componentLibraryId, library.id))
      .orderBy(desc(componentLibraryReleases.createdAt), desc(componentLibraryReleases.id))
    return rows.map(({ release, author }) => ({
      id: release.id,
      version: release.version,
      notes: release.notes,
      components: componentLibraryInterface(release.definition),
      allowedOrigins: release.definition.allowedOrigins,
      definitionHash: release.definitionHash,
      bundleHash: release.bundleHash,
      uploaded: release.uploaded,
      createdAt: release.createdAt,
      createdBy: author,
      gitCommit: release.gitCommit,
      live: release.id === library.liveReleaseId,
    }))
  }),

  /** One release with its definition (and lock), to compare it with another or the draft. */
  release: authedProcedure
    .input(z.object({ componentLibraryId: Id, id: Id }))
    .query(async ({ ctx, input }) => {
      const { access, library } = await visibleLibrary(ctx, { id: input.componentLibraryId })
      requireLevel(access.componentLibraryLevel(library), 'edit', 'this component library')
      const [release] = await ctx.db
        .select()
        .from(componentLibraryReleases)
        .where(
          and(
            eq(componentLibraryReleases.id, input.id),
            eq(componentLibraryReleases.componentLibraryId, library.id),
          ),
        )
      if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
      return { id: release.id, version: release.version, definition: release.definition, lock: release.lock }
    }),
})
