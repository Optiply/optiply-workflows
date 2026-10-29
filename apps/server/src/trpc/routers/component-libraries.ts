import {
  type ComponentLibraryDefinition,
  type ComponentLibraryInfo,
  componentLibraryDefinitionSchema,
  componentLibraryHash,
  componentLibraryInterface,
  emptyComponentLibrary,
  validateComponentLibrary,
} from '@ow/app-definition'
import {
  type ComponentLibrary,
  componentLibraries,
  componentLibraryReleases,
  permissions,
  users,
} from '@ow/db'
import { workflowSlugSchema } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { componentLibraryInfos, componentLibraryUsers } from '../../services/component-libraries'
import { inUseMessage, usedByView } from '../../services/dependents'
import { requireUnprotected } from '../../services/git/protection'
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
      return {
        revision: saved.revision,
        draftHash: await componentLibraryHash(definition),
        diagnostics: validateComponentLibrary(definition).diagnostics,
      }
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
