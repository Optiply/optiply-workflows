import {
  ConnectorError,
  connectors,
  createHttpClient,
  destroyHttpClient,
  getConnector,
  graphqlConnector,
  graphqlIntrospect,
  type HttpClient,
  type HubSpotProperty,
  httpRequest,
  hubspotConnector,
  hubspotProperties,
  type KafkaConfig,
  type KafkaSecrets,
  kafkaSettingsProblem,
  OPENAPI_MAX_SPEC,
  openApiDocument,
  restApiConnector,
  restConfigSchema,
  runOperation,
  runQuery,
  SshSettingsError,
  testResource,
} from '@ow/connectors'
import {
  type Db,
  environments,
  oauthTokens,
  permissions,
  REST_API_RESOURCE_SLUG,
  type Resource,
  resourceConfigs,
  resources,
} from '@ow/db'
import { canonicalJson } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { awsIdentityView, awsSettingsProblem } from '../../services/aws'
import { requireSettingsUnprotected } from '../../services/git/settings-objects'
import { pubsubSettingsProblem, serverIdentityView, sheetsSettingsProblem } from '../../services/google'
import {
  type AccountKind,
  connectTarget,
  OAuthConnectError,
  oauthRedirectUri,
} from '../../services/oauth-connect'
import {
  authFingerprint,
  authorizationCode,
  type ConnectionStatus,
  connectionStatus,
  credentialsFor,
  deleteTokens,
} from '../../services/oauth-tokens'
import { type Access, atLeast, loadAccess, requireLevel } from '../../services/permissions'
import { errorView, toJson } from '../../services/query-results'
import {
  applyOverrides,
  applySecretPatch,
  decryptConfigSecrets,
  effectiveConfig,
  iapKeyInfo,
  isOverridePath,
  maskSecrets,
  patchedSecretFields,
  publicConfigVars,
  serverIdentityTarget,
  settleSsh,
  sshKeyInfo,
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

/** Runs `settle`, turning wrong SSH settings into a bad request that says what's wrong (never a secret). */
function sshSettled<T>(settle: () => T): T {
  try {
    return settle()
  } catch (err) {
    if (err instanceof SshSettingsError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    throw err
  }
}

/**
 * Why a resource's settings couldn't sign in, checked on save (M19, M26, M27): Pub/Sub's key or project, SQS's AWS
 * identity, what a Kafka auth mode needs (and MSK IAM's AWS identity), a service's token or OAuth client secret, Google
 * Sheets' key or the server's identity. Null when fine, or for other types.
 */
function settingsProblem(type: string, config: unknown, secrets: Record<string, unknown>): string | null {
  if (type === 'pubsub') return pubsubSettingsProblem(config, secrets)
  if (type === 'googlesheets') return sheetsSettingsProblem(config, secrets)
  if (type === 'slack' || type === 'hubspot' || type === 'sendgrid') {
    const auth = ((config ?? {}) as { auth?: { type?: string } }).auth?.type ?? 'token'
    if (auth === 'token' && !secrets.token) return type === 'sendgrid' ? 'Add the API key' : 'Add the token'
    if (auth === 'oauth' && !secrets.clientSecret) return 'Add the OAuth app’s client secret'
  }
  if (type === 'stripe' && !secrets.token) return 'Add the secret key'
  if ((type === 'airtable' || type === 'notion') && !secrets.token) return 'Add the token'
  if (type === 'openapi') {
    const spec = ((config ?? {}) as { spec?: unknown }).spec
    if (typeof spec !== 'string' || !spec.trim())
      return 'Add the OpenAPI document (paste it, or fetch it from its URL)'
    try {
      openApiDocument(spec)
    } catch (err) {
      return err instanceof ConnectorError ? err.message : 'The OpenAPI document doesn’t parse'
    }
  }
  if (type === 'salesforce') {
    const auth = ((config ?? {}) as { auth?: { clientId?: string } }).auth
    if (!auth?.clientId) return 'Add the connected app’s consumer key'
    if (!secrets.clientSecret) return 'Add the connected app’s consumer secret'
  }
  if (type === 'jira') {
    const c = (config ?? {}) as { deployment?: string; email?: string }
    const cloudSite = (c.deployment ?? 'cloud') === 'cloud'
    if (cloudSite && !c.email) return 'Add the email of the account the API token belongs to'
    if (!secrets.token) return cloudSite ? 'Add the API token' : 'Add the personal access token'
  }
  if (type === 'sqs' || type === 's3') return awsSettingsProblem(config, secrets)
  if (type === 'kafka') {
    const c = (config ?? {}) as KafkaConfig
    return (
      kafkaSettingsProblem(c, secrets as KafkaSecrets) ??
      (c.auth === 'aws-msk-iam' ? awsSettingsProblem(config, secrets) : null)
    )
  }
  return null
}

/**
 * Settings that use the server's own Google identity (M18, M19) or AWS credentials (M26) somewhere other than the
 * stored settings' need an admin, as does an SQS endpoint: editors may keep such settings (and change the rest), not
 * choose or move them. Returns the new target.
 */
function requireAdminForServerIdentity(
  user: { isAdmin: boolean },
  type: string,
  stored: unknown,
  next: unknown,
): string | null {
  // An SQS (M26) or S3 (M29) resource's own endpoint receives signed requests and the data: admins choose it.
  const endpoint = (c: unknown) => (c as { endpoint?: unknown } | null)?.endpoint ?? null
  if (
    (type === 'sqs' || type === 's3') &&
    endpoint(next) &&
    endpoint(next) !== endpoint(stored) &&
    !user.isAdmin
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Only admins can point an ${type === 's3' ? 'S3' : 'SQS'} resource at another endpoint`,
    })
  const target = serverIdentityTarget(next, type)
  if (target && target !== serverIdentityTarget(stored, type) && !user.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        type === 'pubsub'
          ? "Only admins can use this server's own Google identity for a Pub/Sub project"
          : target.startsWith('aws:')
            ? "Only admins can use this server's own AWS credentials, or change the region, role or brokers used with them"
            : "Only admins can point an SSH tunnel at a VM with this server's own Google identity",
    })
  }
  return target
}

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

/** The connect checks (shared with the OAuth routes) as tRPC errors. */
async function oauthTarget(
  ctx: AuthedContext,
  input: { resourceId: string; environmentId: string; account: AccountKind; appId?: string | undefined },
) {
  try {
    return await connectTarget(ctx.db, ctx.config.keyring, ctx.user, input)
  } catch (err) {
    if (!(err instanceof OAuthConnectError)) throw err
    const code = ({ 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND' } as const)[
      err.status
    ]
    throw new TRPCError({ code, message: err.message })
  }
}

function levelsByEnv(access: Access, resource: Resource, envIds: string[]) {
  return Object.fromEntries(envIds.map((e) => [e, access.level(resource, e)]))
}

export const resourcesRouter = router({
  /** Connector types a resource can have. */
  /** The types people can create, grouped for the picker (M27); the built-in REST API's isn't one of them. */
  types: authedProcedure.query(() =>
    Object.values(connectors)
      .filter((c) => c.type !== restApiConnector.type)
      .map((c) => ({ type: c.type, label: c.label, group: TYPE_GROUPS[c.type] ?? 'APIs' })),
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
          gitProtected: r.gitProtected,
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
        const secrets = row ? decryptConfigSecrets(ctx.config.keyring, row) : null
        return [
          {
            environmentId,
            level,
            config: row ? row.config : null,
            /** This instance's own values over `config` (M22), by path. */
            overrides: row ? row.overrides : null,
            /** Configured from Git without the secrets its connector needs yet (M22): an admin fills them in. */
            secretsSet: !!row?.secrets,
            needsSecrets:
              !!row && !row.secrets && !connectorFor(resource.type).secretsSchema.safeParse({}).success,
            secrets: secrets ? maskSecrets(secrets) : null,
            sshKeys: secrets ? sshKeyInfo(secrets) : null,
            iapKeys: secrets ? iapKeyInfo(secrets) : null,
            updatedAt: row?.updatedAt ?? null,
          },
        ]
      }),
    }
  }),

  /**
   * Whether SSH tunnels may open Google Cloud IAP with this server's own identity (M18, GOOGLE_SERVER_IDENTITY), whose
   * it is, and whether this user may choose it (admins only).
   */
  serverIdentity: authedProcedure.query(({ ctx }) => serverIdentityView(ctx.user)),

  /**
   * Whether SQS resources and Kafka's MSK IAM may use this server's own AWS credentials (M26, AWS_SERVER_IDENTITY),
   * whose they are, and whether this user may choose them (admins only).
   */
  awsIdentity: authedProcedure.query(({ ctx }) => awsIdentityView(ctx.user)),

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
      if (input.type === restApiConnector.type) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The REST API resource is built in: use ${REST_API_RESOURCE_SLUG}`,
        })
      }
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
      requireSettingsUnprotected(resource, 'resource', 'its name, description and folder change')
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
    if (resource.gitProtected) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This resource is kept in Git: unprotect it before deleting it',
      })
    }
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
      // A protected resource's settings are Git's (M22): here only its secrets change (and overrides, apart).
      if (resource.gitProtected) {
        const stored = existing && connector.configSchema.safeParse(existing.config)
        if (
          !stored ||
          canonicalJson(stored.success ? stored.data : existing.config) !== canonicalJson(config.data)
        ) {
          requireSettingsUnprotected(
            resource,
            'resource',
            existing
              ? 'its settings change (secrets and overrides here)'
              : 'it gets settings in a new environment',
          )
        }
      }
      const settled = sshSettled(() =>
        settleSsh(
          config.data as Record<string, unknown>,
          applySecretPatch(existing ? decryptConfigSecrets(ctx.config.keyring, existing) : {}, input.secrets),
        ),
      )
      const iapTarget = requireAdminForServerIdentity(
        ctx.user,
        resource.type,
        existing?.config,
        settled.config,
      )
      const secrets = settled.secrets
      const problem = settingsProblem(resource.type, settled.config, secrets)
      if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem })
      const parsedSecrets = connector.secretsSchema.safeParse(secrets)
      if (!parsedSecrets.success) {
        throw invalidInput('credentials', parsedSecrets.error.issues, { pathsOnly: true })
      }

      const row = { id: existing?.id ?? uuidv7(), environmentId: input.environmentId }
      const values = {
        config: resource.gitProtected ? existing!.config : settled.config,
        secrets: Object.keys(secrets).length
          ? encryptForRow(ctx.config.keyring, 'resource_configs', row, secrets)
          : null,
        updatedBy: ctx.user.id,
        updatedAt: new Date(),
      }
      // Accounts connected under other OAuth settings (client, URLs, scopes) would need a new consent anyway.
      const before = existing ? authFingerprint(resource.type, effectiveConfig(existing)) : null
      const consentChanged =
        before !== null &&
        before !== authFingerprint(resource.type, applyOverrides(values.config, existing!.overrides))
      let disconnectedAccounts = 0
      if (existing) {
        disconnectedAccounts = await ctx.db.transaction(async (tx) => {
          await tx.update(resourceConfigs).set(values).where(eq(resourceConfigs.id, existing.id))
          return consentChanged ? deleteTokens(tx, existing.id) : 0
        })
      } else {
        await ctx.db.insert(resourceConfigs).values({ ...row, resourceId: resource.id, ...values })
      }
      await ctx.services.pool.invalidate(row.id)
      await ctx.audit({
        action: 'resource.config_saved',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: {
          environment: envSlug,
          changedCredentials: patchedSecretFields(input.secrets),
          ...(iapTarget &&
            iapTarget !== serverIdentityTarget(existing?.config, resource.type) && {
              serverIdentityTarget: iapTarget,
            }),
          ...(disconnectedAccounts && { disconnectedAccounts }),
        },
      })
      return {
        config: values.config,
        secrets: maskSecrets(secrets),
        sshKeys: sshKeyInfo(secrets),
        iapKeys: iapKeyInfo(secrets),
      }
    }),

  /**
   * This instance's own values for single non-secret fields of a protected resource (M22), by path (`host`,
   * `ssh.host`): applied over Git's settings wherever they're read, never touched by a deploy. Replaces the
   * environment's overrides; `{}` clears them.
   */
  setOverrides: authedProcedure
    .input(
      z.object({
        resourceId: Id,
        environmentId: Id,
        overrides: z
          .record(
            z.string().refine(isOverridePath, "Expected a setting's path, such as host or ssh.host"),
            z.unknown(),
          )
          .refine((o) => Object.keys(o).length <= 50, 'At most 50 overrides'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'edit', 'this resource in this environment')
      assertNotBuiltIn(resource)
      if (!resource.gitProtected) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: "Overrides are for resources kept in Git: change this one's settings instead",
        })
      }
      const existing = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!existing) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: "This resource isn't configured in this environment: its settings come from Git",
        })
      }
      const connector = connectorFor(resource.type)
      const next = connector.configSchema.safeParse(applyOverrides(existing.config, input.overrides))
      if (!next.success) throw invalidInput('configuration', next.error.issues)
      // A path the connector doesn't keep would be dropped silently: say so instead.
      for (const [path, value] of Object.entries(input.overrides)) {
        const kept = path
          .split('.')
          .reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], next.data)
        if (canonicalJson(kept ?? null) !== canonicalJson(value ?? null)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `"${path}" isn't a setting of this resource` })
        }
      }
      const secrets = decryptConfigSecrets(ctx.config.keyring, existing)
      sshSettled(() => settleSsh(next.data as Record<string, unknown>, secrets))
      const iapTarget = requireAdminForServerIdentity(
        ctx.user,
        resource.type,
        effectiveConfig(existing),
        next.data,
      )
      const consentChanged =
        authFingerprint(resource.type, effectiveConfig(existing)) !==
        authFingerprint(resource.type, next.data)
      const disconnectedAccounts = await ctx.db.transaction(async (tx) => {
        await tx
          .update(resourceConfigs)
          .set({ overrides: input.overrides, updatedBy: ctx.user.id, updatedAt: new Date() })
          .where(eq(resourceConfigs.id, existing.id))
        return consentChanged ? deleteTokens(tx, existing.id) : 0
      })
      await ctx.services.pool.invalidate(existing.id)
      await ctx.audit({
        action: 'resource.overrides_saved',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: {
          environment: await environmentSlug(ctx.db, input.environmentId),
          paths: Object.keys(input.overrides).sort(),
          ...(iapTarget &&
            iapTarget !== serverIdentityTarget(effectiveConfig(existing), resource.type) && {
              serverIdentityTarget: iapTarget,
            }),
          ...(disconnectedAccounts && { disconnectedAccounts }),
        },
      })
      return { overrides: input.overrides, config: next.data as Record<string, unknown> }
    }),

  deleteConfig: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id }))
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'edit', 'this resource in this environment')
      assertNotBuiltIn(resource)
      requireSettingsUnprotected(resource, 'resource', 'its settings in an environment are removed')
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
      const tested = {
        id: existing?.id ?? 'unsaved',
        resourceId: resource.id,
        environmentId: input.environmentId,
        version: 'test',
        config:
          input.config === undefined
            ? existing
              ? effectiveConfig(existing)
              : {}
            : // A protected resource runs here with this instance's overrides on Git's settings (M22): tested so too.
              resource.gitProtected && existing && typeof input.config === 'object' && input.config !== null
              ? applyOverrides(input.config as Record<string, unknown>, existing.overrides)
              : input.config,
        secrets: applySecretPatch(
          existing ? decryptConfigSecrets(ctx.config.keyring, existing) : {},
          input.secrets,
        ),
      }
      // The SSH part as it would be saved; a key that can't be used fails the test with why (M17).
      const parsedConfig = connector.configSchema.safeParse(tested.config)
      if (parsedConfig.success) {
        try {
          Object.assign(tested, settleSsh(parsedConfig.data as Record<string, unknown>, tested.secrets))
        } catch (err) {
          if (!(err instanceof SshSettingsError)) throw err
          return { ok: false as const, error: errorView(new ConnectorError('invalid_config', err.message)) }
        }
      }
      // Testing opens the tunnel too: the server's identity goes only where an admin pointed it (M18).
      requireAdminForServerIdentity(ctx.user, resource.type, existing?.config, tested.config)
      // Connected accounts belong to the saved settings: changed consent settings need a reconnect first. A custom
      // auth flow signs in afresh for the test, without storing what it gets (`store: false`).
      const custom = (tested.config as { auth?: { type?: unknown } }).auth?.type === 'custom'
      const credentials =
        existing || custom
          ? credentialsFor(
              { db: ctx.db, keyring: ctx.config.keyring, sandbox: ctx.services.sandbox },
              resource.type,
              tested,
              ctx.user.id,
              { store: false },
            )
          : undefined
      const result = await testResource(connector, tested, credentials ? { credentials } : {})
      // Each SSH hop's own result and host key (M17): the browser offers Trust for an untrusted or changed key.
      const ssh = result.ssh ?? null
      return result.ok
        ? { ok: true as const, message: result.message ?? null, durationMs: result.durationMs, ssh }
        : { ok: false as const, error: errorView(result.error), ssh }
    }),

  /**
   * OAuth connections of a REST resource, per environment the user can see: the shared account (with whether the
   * user may connect it) or, on per-user resources, the user's own; never tokens. Also the redirect URI to
   * register with the provider.
   */
  oauthConnections: authedProcedure.input(z.object({ resourceId: Id })).query(async ({ ctx, input }) => {
    const { access, resource, envIds } = await visibleResource(ctx, input.resourceId)
    const environments: {
      environmentId: string
      /** Null when the resource doesn't use the authorization code in this environment. */
      tokens: 'shared' | 'perUser' | null
      connection: ConnectionStatus | null
      canConnect: boolean
      /** Per-user resources, for people with Edit: how many people have connected. */
      connectedPeople: number | null
    }[] = []
    for (const environmentId of envIds) {
      const level = access.level(resource, environmentId)
      if (!level) continue
      const row = await getConfigRow(ctx.db, resource.id, environmentId)
      const auth = row && authorizationCode(resource.type, effectiveConfig(row))
      if (!row || !auth) {
        environments.push({
          environmentId,
          tokens: null,
          connection: null,
          canConnect: false,
          connectedPeople: null,
        })
        continue
      }
      const shared = auth.tokens === 'shared'
      const consent = authFingerprint(resource.type, effectiveConfig(row))!
      let connectedPeople: number | null = null
      if (!shared && atLeast(level, 'edit')) {
        const [counted] = await ctx.db
          .select({ n: count() })
          .from(oauthTokens)
          .where(and(eq(oauthTokens.resourceConfigId, row.id), isNotNull(oauthTokens.userId)))
        connectedPeople = counted?.n ?? 0
      }
      environments.push({
        environmentId,
        tokens: shared ? 'shared' : 'perUser',
        connection: await connectionStatus(ctx.db, row.id, shared ? null : ctx.user.id, consent),
        canConnect: shared ? atLeast(level, 'edit') : true,
        connectedPeople,
      })
    }
    return { redirectUri: oauthRedirectUri(ctx.config), environments }
  }),

  /**
   * Disconnects the shared account (Edit) or the user's own (Use, or through `appId` like connecting). The provider
   * isn't told (no revocation).
   */
  oauthDisconnect: authedProcedure
    .input(
      z.object({
        resourceId: Id,
        environmentId: Id,
        account: z.enum(['shared', 'mine']),
        appId: Id.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = await oauthTarget(ctx, input)
      const removed = await deleteTokens(ctx.db, target.config.id, target.userId)
      if (removed) {
        await ctx.audit({
          action: 'resource.oauth_disconnected',
          objectType: 'resource',
          objectId: target.resource.id,
          environmentId: input.environmentId,
          metadata: { account: target.userId === null ? 'shared' : 'user' },
        })
      }
      return { disconnected: removed > 0 }
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
      const resolved = toResolved(ctx.config.keyring, row)
      const credentials = credentialsFor(
        { db: ctx.db, keyring: ctx.config.keyring, sandbox: ctx.services.sandbox },
        resource.type,
        resolved,
        ctx.user.id,
      )
      const started = performance.now()
      let outcome:
        | { ok: true; data: unknown; metadata: Record<string, unknown>; durationMs: number }
        | { ok: false; error: ReturnType<typeof errorView>; durationMs: number }
      try {
        const result = await runQuery(ctx.services.pool, connector, resolved, input.query, {
          ...(credentials && { credentials }),
          evaluate: (code) =>
            ctx.services.sandbox.evalExpression(code, scope, { timeoutMs: EXPRESSION_TIMEOUT_MS }),
          labels: { ow_source: 'playground', ow_user: ctx.user.id },
        })
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

  /**
   * A GraphQL resource's schema (M27), by introspection through the resource, for the editor's completions and
   * checks. Needs Use; kept 10 minutes per settings version (and per person, where each connects their own account).
   */
  graphqlSchema: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id, refresh: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'use', 'this resource in this environment')
      if (resource.type !== graphqlConnector.type) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only GraphQL resources have a schema' })
      }
      const row = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!row) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This resource is not configured in this environment',
        })
      }
      const resolved = toResolved(ctx.config.keyring, row)
      const perUser = authorizationCode(resource.type, resolved.config)?.tokens === 'perUser'
      const key = `${row.id}:${resolved.version}:${perUser ? ctx.user.id : ''}`
      const cached = graphqlSchemas.get(key)
      if (cached && !input.refresh && cached.at > Date.now() - GRAPHQL_SCHEMA_TTL_MS) {
        return { ok: true as const, schema: cached.schema }
      }
      const credentials = credentialsFor(
        { db: ctx.db, keyring: ctx.config.keyring, sandbox: ctx.services.sandbox },
        resource.type,
        resolved,
        ctx.user.id,
      )
      try {
        const schema = toJson(
          await runOperation(
            ctx.services.pool,
            graphqlConnector,
            resolved,
            (client, opts) => graphqlIntrospect(client as HttpClient, opts),
            { ...(credentials && { credentials }) },
          ),
        )
        if (graphqlSchemas.size >= 200) graphqlSchemas.delete(graphqlSchemas.keys().next().value!)
        graphqlSchemas.set(key, { at: Date.now(), schema })
        return { ok: true as const, schema }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err
        return { ok: false as const, error: errorView(err) }
      }
    }),
  /**
   * A HubSpot object type's properties (M27), for the query forms' pickers. Needs Use; kept like a GraphQL schema.
   */
  /** An OpenAPI resource's operations, from its saved document (M29), for the query form. Needs Use. */
  openapiOperations: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id }))
    .query(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'use', 'this resource in this environment')
      if (resource.type !== 'openapi')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only OpenAPI resources have operations' })
      const row = await getConfigRow(ctx.db, resource.id, input.environmentId)
      const spec = (row?.config as { spec?: unknown } | undefined)?.spec
      if (typeof spec !== 'string')
        return { ok: false as const, message: 'This resource has no OpenAPI document in this environment' }
      try {
        const doc = openApiDocument(spec)
        return {
          ok: true as const,
          title: doc.title,
          version: doc.version,
          servers: doc.servers,
          operations: doc.operations,
        }
      } catch (err) {
        return {
          ok: false as const,
          message: err instanceof ConnectorError ? err.message : 'The OpenAPI document doesn’t parse',
        }
      }
    }),

  /**
   * Fetches an OpenAPI document from a public URL (M29) for the settings form, which keeps its text in the settings:
   * through the HTTP core's guard (no private addresses, redirects re-checked, 5 MB). Needs Edit on the resource.
   */
  openapiFetch: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id, url: z.url({ protocol: /^https?$/ }) }))
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'edit', 'this resource in this environment')
      if (resource.type !== 'openapi')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only OpenAPI resources have a document' })
      const client = createHttpClient(
        restConfigSchema.parse({ baseUrl: input.url, maxResponseBytes: OPENAPI_MAX_SPEC }),
        { headers: {}, values: {} },
      )
      try {
        const res = await httpRequest(
          client,
          { method: 'GET', url: new URL(input.url) },
          { signal: AbortSignal.timeout(20_000) },
        )
        if (!res.ok) return { ok: false as const, message: `The URL answered HTTP ${res.status}` }
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
        const doc = openApiDocument(text)
        return {
          ok: true as const,
          spec: text,
          title: doc.title,
          version: doc.version,
          servers: doc.servers,
          operations: doc.operations.length,
        }
      } catch (err) {
        return {
          ok: false as const,
          message: err instanceof ConnectorError ? err.message : (err as Error).message,
        }
      } finally {
        await destroyHttpClient(client)
      }
    }),

  hubspotProperties: authedProcedure
    .input(
      z.object({
        resourceId: Id,
        environmentId: Id,
        objectType: z
          .string()
          .regex(/^[\w-]+$/)
          .max(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'use', 'this resource in this environment')
      if (resource.type !== hubspotConnector.type) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only HubSpot resources have properties' })
      }
      const row = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!row) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This resource is not configured in this environment',
        })
      }
      const resolved = toResolved(ctx.config.keyring, row)
      const perUser = authorizationCode(resource.type, resolved.config)?.tokens === 'perUser'
      const key = `hubspot:${row.id}:${resolved.version}:${perUser ? ctx.user.id : ''}:${input.objectType}`
      const cached = graphqlSchemas.get(key)
      if (cached && cached.at > Date.now() - GRAPHQL_SCHEMA_TTL_MS) {
        return { ok: true as const, properties: cached.schema as HubSpotProperty[] }
      }
      const credentials = credentialsFor(
        { db: ctx.db, keyring: ctx.config.keyring, sandbox: ctx.services.sandbox },
        resource.type,
        resolved,
        ctx.user.id,
      )
      try {
        const properties = await runOperation(
          ctx.services.pool,
          hubspotConnector,
          resolved,
          (client, opts) => hubspotProperties(client as HttpClient, input.objectType, opts),
          { ...(credentials && { credentials }) },
        )
        if (graphqlSchemas.size >= 200) graphqlSchemas.delete(graphqlSchemas.keys().next().value!)
        graphqlSchemas.set(key, { at: Date.now(), schema: properties })
        return { ok: true as const, properties }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err
        return { ok: false as const, error: errorView(err) }
      }
    }),
})

/** How the new-resource picker groups the types. */
const TYPE_GROUPS: Record<string, string> = {
  postgres: 'Databases',
  mysql: 'Databases',
  bigquery: 'Databases',
  rest: 'APIs',
  graphql: 'APIs',
  openapi: 'APIs',
  pubsub: 'Messaging',
  sqs: 'Messaging',
  kafka: 'Messaging',
  slack: 'Services',
  hubspot: 'Services',
  sendgrid: 'Services',
  googlesheets: 'Services',
  s3: 'Storage',
  stripe: 'Services',
  airtable: 'Services',
  jira: 'Services',
  notion: 'Services',
  salesforce: 'Services',
}

const GRAPHQL_SCHEMA_TTL_MS = 10 * 60_000
/**
 * GraphQL schemas and HubSpot properties by config row, settings version, (per-user accounts) person and object type;
 * oldest dropped past 200.
 */
const graphqlSchemas = new Map<string, { at: number; schema: unknown }>()
