import { ConnectorError, connectors, getConnector, runQuery, testResource } from '@ow/connectors'
import { type Db, environments, permissions, type Resource, resourceConfigs, resources } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { type Access, loadAccess, requireLevel } from '../../services/permissions'
import { errorView, toJson } from '../../services/query-results'
import {
  applySecretPatch,
  decryptConfigSecrets,
  maskSecrets,
  patchedSecretFields,
  publicConfigVars,
  toResolved,
} from '../../services/resources'
import { encryptForRow } from '../../services/secrets'
import { invalidInput, uniqueOr } from '../errors'
import { authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
/** Workflow definitions reference resources by slug, so it must be a stable identifier. */
const Slug = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,62}$/,
    'Use 2–63 lowercase letters, digits or underscores, starting with a letter',
  )
const Name = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).nullish()
/** Write-only secret patch: string sets, null clears, absent keeps (see applySecretPatch). */
const SecretPatch = z.record(z.string(), z.unknown()).optional()

/** Each `{{ }}` in the playground gets this long in the sandbox. */
const EXPRESSION_TIMEOUT_MS = 5_000

type AuthedContext = Context & { user: NonNullable<Context['user']> }

async function environmentIds(db: Db): Promise<string[]> {
  return (await db.select({ id: environments.id }).from(environments)).map((e) => e.id)
}

async function getResource(db: Db, id: string): Promise<Resource> {
  const [resource] = await db.select().from(resources).where(eq(resources.id, id)).limit(1)
  if (!resource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' })
  return resource
}

/** Loads a resource the user can see in at least one environment; otherwise it doesn't exist for them. */
async function visibleResource(ctx: AuthedContext, id: string) {
  const access = await loadAccess(ctx.db, ctx.user)
  const resource = await getResource(ctx.db, id).catch(() => null)
  const envIds = await environmentIds(ctx.db)
  if (!resource || !envIds.some((e) => access.level(resource, e))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' })
  }
  return { access, resource, envIds }
}

async function getConfigRow(db: Db, resourceId: string, environmentId: string) {
  const [row] = await db
    .select()
    .from(resourceConfigs)
    .where(and(eq(resourceConfigs.resourceId, resourceId), eq(resourceConfigs.environmentId, environmentId)))
    .limit(1)
  return row
}

async function environmentSlug(db: Db, id: string): Promise<string> {
  const [env] = await db.select({ slug: environments.slug }).from(environments).where(eq(environments.id, id))
  if (!env) throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' })
  return env.slug
}

function connectorFor(type: string) {
  const connector = getConnector(type)
  if (!connector) throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown resource type "${type}"` })
  return connector
}

/** Built-in resources are provisioned by the platform: their settings, name and existence aren't anyone's to change. */
function assertNotBuiltIn(resource: Resource) {
  if (resource.systemKind) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This is a built-in resource: the platform manages its settings',
    })
  }
}

function levelsByEnv(access: Access, resource: Resource, envIds: string[]) {
  return Object.fromEntries(envIds.map((e) => [e, access.level(resource, e)]))
}

export const resourcesRouter = router({
  /** Connector types a resource can have. */
  types: authedProcedure.query(() =>
    Object.values(connectors).map((c) => ({ type: c.type, label: c.label })),
  ),

  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const envIds = await environmentIds(ctx.db)
    const [all, configs] = await Promise.all([
      // People's own resources first (the editor offers the first one for new queries), then built-in ones.
      ctx.db.select().from(resources).orderBy(sql`${resources.systemKind} is not null`, asc(resources.name)),
      ctx.db
        .select({ resourceId: resourceConfigs.resourceId, environmentId: resourceConfigs.environmentId })
        .from(resourceConfigs),
    ])
    const configured = new Set(configs.map((c) => `${c.resourceId}:${c.environmentId}`))
    const visible = all.flatMap((r) => {
      const levels = levelsByEnv(access, r, envIds)
      if (!Object.values(levels).some(Boolean)) return []
      return [
        {
          id: r.id,
          slug: r.slug,
          name: r.name,
          type: r.type,
          description: r.description,
          folderId: r.folderId,
          systemKind: r.systemKind,
          environments: envIds.map((e) => ({
            environmentId: e,
            level: levels[e] ?? null,
            configured: configured.has(`${r.id}:${e}`),
          })),
        },
      ]
    })
    return { resources: visible, canCreate: access.canCreateResources }
  }),

  /** A resource with its per-environment settings. Secrets come back only as `{ set: true }`. */
  get: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const { access, resource, envIds } = await visibleResource(ctx, input.id)
    const rows = await ctx.db
      .select()
      .from(resourceConfigs)
      .where(eq(resourceConfigs.resourceId, resource.id))
    const byEnv = new Map(rows.map((r) => [r.environmentId, r]))
    return {
      ...resource,
      level: access.levelEverywhere(resource, envIds),
      environments: envIds.flatMap((environmentId) => {
        const level = access.level(resource, environmentId)
        if (!level) return []
        const row = byEnv.get(environmentId)
        return [
          {
            environmentId,
            level,
            config: row ? row.config : null,
            secrets: row ? maskSecrets(decryptConfigSecrets(ctx.config.keyring, row)) : null,
            updatedAt: row?.updatedAt ?? null,
          },
        ]
      }),
    }
  }),

  create: authedProcedure
    .input(
      z.object({
        type: z.string(),
        name: Name,
        slug: Slug,
        description: Description,
        folderId: Id.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const access = await loadAccess(ctx.db, ctx.user)
      if (!access.canCreateResources) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need edit access to all resources to create one',
        })
      }
      connectorFor(input.type)
      const [resource] = await uniqueOr('A resource with that slug already exists', () =>
        ctx.db
          .insert(resources)
          .values({
            type: input.type,
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            createdBy: ctx.user.id,
          })
          .returning(),
      )
      await ctx.audit({
        action: 'resource.created',
        objectType: 'resource',
        objectId: resource!.id,
        metadata: { slug: input.slug, type: input.type },
      })
      return resource!
    }),

  update: authedProcedure
    .input(z.object({ id: Id, name: Name, description: Description, folderId: Id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const { access, resource, envIds } = await visibleResource(ctx, input.id)
      requireLevel(access.levelEverywhere(resource, envIds), 'edit', 'this resource in every environment')
      assertNotBuiltIn(resource)
      await ctx.db
        .update(resources)
        .set({ name: input.name, description: input.description ?? null, folderId: input.folderId ?? null })
        .where(eq(resources.id, resource.id))
      await ctx.audit({
        action: 'resource.updated',
        objectType: 'resource',
        objectId: resource.id,
        metadata: { from: { name: resource.name, folderId: resource.folderId }, to: input },
      })
    }),

  delete: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const { access, resource, envIds } = await visibleResource(ctx, input.id)
    requireLevel(access.levelEverywhere(resource, envIds), 'own', 'this resource in every environment')
    assertNotBuiltIn(resource)
    const configIds = await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: resourceConfigs.id })
        .from(resourceConfigs)
        .where(eq(resourceConfigs.resourceId, resource.id))
      await tx
        .delete(permissions)
        .where(and(eq(permissions.objectType, 'resource'), eq(permissions.objectId, resource.id)))
      await tx.delete(resources).where(eq(resources.id, resource.id))
      return rows.map((r) => r.id)
    })
    await ctx.services.pool.invalidate(configIds)
    await ctx.audit({
      action: 'resource.deleted',
      objectType: 'resource',
      objectId: resource.id,
      metadata: { slug: resource.slug, name: resource.name },
    })
  }),

  /**
   * Saves a resource's settings for one environment. `secrets` is a write-only patch: the browser sends only the
   * fields it changes and never receives stored values back.
   */
  saveConfig: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id, config: z.unknown(), secrets: SecretPatch }))
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'edit', 'this resource in this environment')
      assertNotBuiltIn(resource)
      const connector = connectorFor(resource.type)
      const envSlug = await environmentSlug(ctx.db, input.environmentId)

      const config = connector.configSchema.safeParse(input.config)
      if (!config.success) throw invalidInput('configuration', config.error.issues)

      const existing = await getConfigRow(ctx.db, resource.id, input.environmentId)
      const secrets = applySecretPatch(
        existing ? decryptConfigSecrets(ctx.config.keyring, existing) : {},
        input.secrets,
      )
      const parsedSecrets = connector.secretsSchema.safeParse(secrets)
      if (!parsedSecrets.success) {
        throw invalidInput('credentials', parsedSecrets.error.issues, { pathsOnly: true })
      }

      const row = { id: existing?.id ?? uuidv7(), environmentId: input.environmentId }
      const values = {
        config: config.data as Record<string, unknown>,
        secrets: Object.keys(secrets).length
          ? encryptForRow(ctx.config.keyring, 'resource_configs', row, secrets)
          : null,
        updatedBy: ctx.user.id,
        updatedAt: new Date(),
      }
      if (existing) {
        await ctx.db.update(resourceConfigs).set(values).where(eq(resourceConfigs.id, existing.id))
      } else {
        await ctx.db.insert(resourceConfigs).values({ ...row, resourceId: resource.id, ...values })
      }
      await ctx.services.pool.invalidate(row.id)
      await ctx.audit({
        action: 'resource.config_saved',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: { environment: envSlug, changedCredentials: patchedSecretFields(input.secrets) },
      })
      return { config: values.config, secrets: maskSecrets(secrets) }
    }),

  deleteConfig: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id }))
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'edit', 'this resource in this environment')
      assertNotBuiltIn(resource)
      const existing = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!existing) return
      await ctx.db.delete(resourceConfigs).where(eq(resourceConfigs.id, existing.id))
      await ctx.services.pool.invalidate(existing.id)
      await ctx.audit({
        action: 'resource.config_deleted',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: { environment: await environmentSlug(ctx.db, input.environmentId) },
      })
    }),

  /**
   * Tests settings without saving them. Omitted `config` uses the stored config; `secrets` patches the stored
   * credentials, so "test before save" works without re-typing passwords.
   */
  test: authedProcedure
    .input(
      z.object({ resourceId: Id, environmentId: Id, config: z.unknown().optional(), secrets: SecretPatch }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'edit', 'this resource in this environment')
      // Other settings with the stored password could send it anywhere: built-in resources test as they are.
      if (input.config !== undefined || input.secrets !== undefined) assertNotBuiltIn(resource)
      const connector = connectorFor(resource.type)
      const existing = await getConfigRow(ctx.db, resource.id, input.environmentId)
      const result = await testResource(connector, {
        id: existing?.id ?? 'unsaved',
        resourceId: resource.id,
        environmentId: input.environmentId,
        version: 'test',
        config: input.config ?? existing?.config ?? {},
        secrets: applySecretPatch(
          existing ? decryptConfigSecrets(ctx.config.keyring, existing) : {},
          input.secrets,
        ),
      })
      return result.ok
        ? { ok: true as const, message: result.message ?? null, durationMs: result.durationMs }
        : { ok: false as const, error: errorView(result.error) }
    }),

  /**
   * The query playground: runs a query against one environment, evaluating `{{ }}` in the sandbox against the
   * caller's test values plus `configVars` (non-secret) and `current_user`.
   */
  run: authedProcedure
    .input(
      z.object({
        resourceId: Id,
        environmentId: Id,
        query: z.unknown(),
        scope: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'use', 'this resource in this environment')
      const connector = connectorFor(resource.type)
      const row = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!row) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This resource is not configured in this environment',
        })
      }
      const scope = {
        ...input.scope,
        configVars: await publicConfigVars(ctx.db, input.environmentId),
        current_user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      }
      const started = performance.now()
      let outcome:
        | { ok: true; data: unknown; metadata: Record<string, unknown>; durationMs: number }
        | { ok: false; error: ReturnType<typeof errorView>; durationMs: number }
      try {
        const result = await runQuery(
          ctx.services.pool,
          connector,
          toResolved(ctx.config.keyring, row),
          input.query,
          {
            evaluate: (code) =>
              ctx.services.sandbox.evalExpression(code, scope, { timeoutMs: EXPRESSION_TIMEOUT_MS }),
            labels: { ow_source: 'playground', ow_user: ctx.user.id },
          },
        )
        outcome = {
          ok: true,
          data: toJson(result.data),
          metadata: toJson(result.metadata) as Record<string, unknown>,
          durationMs: Math.round(performance.now() - started),
        }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err
        outcome = { ok: false, error: errorView(err), durationMs: Math.round(performance.now() - started) }
      }
      await ctx.audit({
        action: 'resource.query_run',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: {
          ok: outcome.ok,
          errorCode: outcome.ok ? undefined : outcome.error.code,
          durationMs: outcome.durationMs,
        },
      })
      return outcome
    }),
})
