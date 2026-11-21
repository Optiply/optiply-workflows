import { createHash } from 'node:crypto'
import {
  type AuthFlowStep,
  ConnectorError,
  connectors,
  createHttpClient,
  describeSqlSchema,
  destroyHttpClient,
  exampleOf,
  FORM_VALUE_MAX,
  flowAsksEachPerson,
  getConnector,
  graphqlApiConnector,
  graphqlConnector,
  graphqlIntrospect,
  type HttpClient,
  type HubSpotProperty,
  httpConfigFor,
  httpRequest,
  hubspotConnector,
  hubspotProperties,
  introspectGraphqlApi,
  OPENAPI_MAX_SPEC,
  openApiDocument,
  restApiConnector,
  restConfigSchema,
  restConnector,
  runOperation,
  runQuery,
  type SqlSchema,
  SshSettingsError,
  testResource,
} from '@ow/connectors'
import { scrubSecrets, scrubSecretsDeep, secretStrings } from '@ow/crypto'
import {
  type Db,
  environments,
  GRAPHQL_RESOURCE_SLUG,
  oauthTokens,
  permissions,
  REST_API_RESOURCE_SLUG,
  type Resource,
  resourceConfigs,
  resources,
} from '@ow/db'
import { canonicalJson, parseJsPackage, parseRequirement } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { awsIdentityView, awsSettingsProblem } from '../../services/aws'
import {
  type CustomFlowStatus,
  countSignedInPeople,
  customFlowHash,
  customFlowStatus,
  signInCustomFlow,
  signOutCustomFlow,
} from '../../services/custom-auth'
import { requireSettingsUnprotected } from '../../services/git/settings-objects'
import {
  bigquerySettingsProblem,
  geminiSettingsProblem,
  gmailSettingsProblem,
  serverIdentityView,
  sheetsSettingsProblem,
} from '../../services/google'
import {
  type AccountKind,
  connectTarget,
  liveAppQueries,
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
  disconnectAccount,
  usesOwnCredentials,
} from '../../services/oauth-tokens'
import {
  type Access,
  atLeast,
  loadAccess,
  requireLevel,
  requireNoAdminOnlySettings,
} from '../../services/permissions'
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
import { groupsOf } from '../../services/tasks'
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
 * Whether a resource configured without secrets (deployed from Git, M22) needs some before it can sign in: its
 * connector requires them, or (BigQuery, whose key is optional since OAuth sign-in needs none) the sign-in it uses
 * does.
 */
function secretsMissing(type: string, config: unknown): boolean {
  if (!connectorFor(type).secretsSchema.safeParse({}).success) return true
  return type === 'bigquery' && bigquerySettingsProblem(config, {}) !== null
}

/**
 * Why a resource's settings couldn't sign in, checked on save (M26, M27): an AWS identity (S3), a service's token
 * or OAuth client secret, Google Sheets' key or the server's identity. Null when fine, or for other types.
 */
function settingsProblem(type: string, config: unknown, secrets: Record<string, unknown>): string | null {
  if (type === 'googlesheets') return sheetsSettingsProblem(config, secrets)
  if (type === 'bigquery') return bigquerySettingsProblem(config, secrets)
  if (type === 'gemini') return geminiSettingsProblem(config, secrets)
  if (type === 'gmail') return gmailSettingsProblem(config, secrets)
  if (type === 'sdk') {
    const c = (config ?? {}) as {
      language?: string
      packages?: string[]
      setup?: string
      auth?: { type?: string }
    }
    const language = c.language ?? 'python'
    for (const line of c.packages ?? []) {
      const parsed = language === 'python' ? parseRequirement(line) : parseJsPackage(line)
      if ('error' in parsed) return `Packages: "${line}": ${parsed.error}`
    }
    if (!c.setup?.trim()) return 'Write the setup code that makes the SDK’s client'
    const auth = c.auth?.type ?? 'bearer'
    if (auth === 'bearer' && !secrets.bearerToken) return 'Add the token'
    // OAuth sign-in may be a public client (PKCE, no secret), as REST's; client credentials always need one.
    if (auth === 'oauth2ClientCredentials' && !secrets.clientSecret)
      return 'Add the OAuth app’s client secret'
  }
  if (type === 'msteams') {
    const auth = ((config ?? {}) as { auth?: { type?: string; clientId?: string } }).auth ?? { type: 'oauth' }
    if (auth.type === 'webhook') return secrets.webhookUrl ? null : 'Add the webhook URL'
    if (!auth.clientId) return 'Add the app registration’s client (application) id'
    if (!secrets.clientSecret) return 'Add the app registration’s client secret'
  }
  if (type === 'slack' || type === 'hubspot' || type === 'sendgrid') {
    const auth = ((config ?? {}) as { auth?: { type?: string } }).auth?.type ?? 'token'
    if (auth === 'token' && !secrets.token) return type === 'sendgrid' ? 'Add the API key' : 'Add the token'
    if (auth === 'oauth' && !secrets.clientSecret) return 'Add the OAuth app’s client secret'
  }
  if (type === 'mssql') {
    const auth = ((config ?? {}) as { auth?: string }).auth ?? 'sql'
    if (auth === 'entra-service-principal') return secrets.clientSecret ? null : 'Add the app’s client secret'
    if (auth !== 'sql' && !secrets.password) return 'Add the password'
  }
  if (type === 'jdbc') {
    const c = (config ?? {}) as { auth?: string; wallet?: boolean }
    if (c.auth === 'keyPair' && !secrets.privateKey) return 'Add the private key'
    if (c.auth === 'oauth' && !secrets.clientSecret) return 'Add the OAuth app’s client secret'
    if (c.wallet && !secrets.wallet) return 'Add the wallet zip'
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
  if (type === 's3') return awsSettingsProblem(config, secrets)
  return null
}

/**
 * Settings that use the server's own Google identity (M18) or AWS credentials (M26) somewhere other than the
 * stored settings' need an admin, as does an S3 endpoint: editors may keep such settings (and change the rest), not
 * choose or move them. Returns the new target.
 */
function requireAdminForServerIdentity(
  user: { isAdmin: boolean },
  type: string,
  stored: unknown,
  next: unknown,
): string | null {
  // An S3 resource's own endpoint (M29) receives signed requests and the data: admins choose it.
  const endpoint = (c: unknown) => (c as { endpoint?: unknown } | null)?.endpoint ?? null
  if (type === 's3' && endpoint(next) && endpoint(next) !== endpoint(stored) && !user.isAdmin)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only admins can point an S3 resource at another endpoint',
    })
  // A custom flow with a form step sends what each person types (their own password) where its steps say: admins
  // choose its steps and hosts, or someone with Edit could point it at their own server and collect them.
  const formFlow = (c: unknown) => {
    const http = c ? httpConfigFor(type, c) : null
    return http?.auth.type === 'custom' && flowAsksEachPerson(http.auth.steps) ? customFlowHash(http) : null
  }
  const nextForm = formFlow(next)
  if (nextForm && nextForm !== formFlow(stored) && !user.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Only admins can set up or change the sign-in of a flow with a form step (its steps, base URL or allowed hosts): it sends what each person types',
    })
  }
  const target = serverIdentityTarget(next, type)
  if (target && target !== serverIdentityTarget(stored, type) && !user.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: target.startsWith('aws:')
        ? "Only admins can use this server's own AWS credentials, or change the region or role used with them"
        : "Only admins can point an SSH tunnel at a VM with this server's own Google identity",
    })
  }
  return target
}

/** Each `{{ }}` in the playground gets this long in the sandbox. */
const EXPRESSION_TIMEOUT_MS = 5_000
/** How long the built-in GraphQL resource's schema may take (an introspection answer can be large). */
const GRAPHQL_API_SCHEMA_TIMEOUT_MS = 30_000

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

/** A resource's custom auth flow in one environment, from its saved settings; null when it signs in otherwise. */
async function customFlowConfig(db: Db, resourceType: string, resourceId: string, environmentId: string) {
  const row = await getConfigRow(db, resourceId, environmentId)
  const http = row && httpConfigFor(resourceType, effectiveConfig(row))
  if (!row || http?.auth.type !== 'custom') return null
  return { row, http, auth: http.auth }
}

/** What a form step asks for, as the sign-in dialog shows it. */
interface FormView {
  step: string
  title: string
  fields: { name: string; label: string; kind: 'text' | 'password' }[]
}

const formView = (steps: readonly AuthFlowStep[]): FormView[] =>
  steps.flatMap((s) =>
    s.type === 'form'
      ? [
          {
            step: s.name,
            title: s.title,
            fields: s.fields.map(({ name, label, kind }) => ({ name, label, kind })),
          },
        ]
      : [],
  )

/** What a person typed into a flow's form steps: by step, then field (a handful of each, each value bounded). */
const formValuesInput = z
  .record(z.string().max(100), z.record(z.string().max(100), z.string().max(FORM_VALUE_MAX)))
  .refine(
    (form) => Object.keys(form).length <= 20 && Object.values(form).every((f) => Object.keys(f).length <= 50),
    {
      message: 'Too many form values',
    },
  )

/**
 * The custom flow a person may sign in (or out) of in one environment. A shared flow needs Edit (it acts for
 * everyone). A flow with a form step is each person's own: any access to the resource, or through an app whose live
 * release queries it (`appId`: app viewers run its queries without access to the resource, as with OAuth accounts).
 */
async function customFlowAccess(
  ctx: AuthedContext,
  input: { resourceId: string; environmentId: string; appId?: string | undefined },
) {
  const access = await loadAccess(ctx.db, ctx.user)
  const resource = await getResource(ctx.db, input.resourceId).catch(() => null)
  const level = resource ? access.level(resource, input.environmentId) : null
  const flow = resource && (await customFlowConfig(ctx.db, resource.type, resource.id, input.environmentId))
  const perUser = !!flow && flowAsksEachPerson(flow.auth.steps)
  const throughApp =
    !!resource &&
    !level &&
    perUser &&
    !!input.appId &&
    (await liveAppQueries(ctx.db, access, input.appId, resource.slug, input.environmentId))
  if (!resource || (!level && !throughApp)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Resource not found' })
  }
  if (!flow) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "This resource doesn't sign in with a custom auth flow in this environment",
    })
  }
  if (!perUser) requireLevel(level, 'edit', 'this resource in this environment')
  return { resource, flow, perUser }
}

/** How long Sign in now may take (the flow's steps have 30 s each). */
const SIGN_IN_NOW_TIMEOUT_MS = 120_000

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
  /** The types people can create, grouped for the picker (M27); the built-in REST API's and GraphQL's aren't. */
  types: authedProcedure.query(() =>
    Object.values(connectors)
      .filter((c) => c.type !== restApiConnector.type && c.type !== graphqlApiConnector.type)
      .map((c) => ({ type: c.type, label: c.label, group: TYPE_GROUPS[c.type] ?? 'APIs' })),
  ),

  list: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    // The environments only admins may use don't show for anyone else.
    const envIds = (await environmentIds(ctx.db)).filter((e) => access.canUseEnvironment(e))
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
            needsSecrets: !!row && !row.secrets && secretsMissing(resource.type, effectiveConfig(row)),
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
   * Whether AWS resources (S3) may use this server's own AWS credentials (M26, AWS_SERVER_IDENTITY),
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
      if (input.type === graphqlApiConnector.type) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The GraphQL resource for any endpoint is built in: use ${GRAPHQL_RESOURCE_SLUG}`,
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
    await requireNoAdminOnlySettings(ctx.db, access, resource.id, 'delete')
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
      // Checked as it will run: with this instance's overrides (M22), e.g. a BigQuery project set only here.
      const problem = settingsProblem(
        resource.type,
        existing ? applyOverrides(settled.config, existing.overrides) : settled.config,
        secrets,
      )
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
   * Disconnects the shared account (Edit) or the user's own (Use, or through `appId` like connecting): revoked at the
   * provider when the settings have a revocation URL (`revoked`: yes, none, or failed with the reason), and
   * forgotten here either way.
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
      const { removed, ...revocation } = await disconnectAccount(ctx.db, ctx.config.keyring, {
        resourceConfigId: target.config.id,
        userId: target.userId,
        auth: target.auth,
        clientSecret: target.clientSecret,
        allowPrivateNetwork: target.allowPrivateNetwork,
        consent: authFingerprint(target.resource.type, effectiveConfig(target.config)),
      })
      if (removed) {
        await ctx.audit({
          action: 'resource.oauth_disconnected',
          objectType: 'resource',
          objectId: target.resource.id,
          environmentId: input.environmentId,
          metadata: { account: target.userId === null ? 'shared' : 'user', revoked: revocation.revoked },
        })
      }
      return { disconnected: removed > 0, ...(removed > 0 && revocation) }
    }),

  /**
   * The Sign-in card of a resource signing in with a custom auth flow, per environment the user can see (never the
   * variables, only their names). A shared flow shows its sign-in, and `canSignIn` (Edit) offers Sign in now and Sign
   * out. A flow with a form step (`perUser`) shows the user's own sign-in, which anyone who sees the resource may
   * sign in or out of, with the form's fields; people with Edit also see how many people signed in
   * (`signedInPeople`). `status` is null where the resource signs in otherwise.
   */
  customAuthStatus: authedProcedure.input(z.object({ resourceId: Id })).query(async ({ ctx, input }) => {
    const { access, resource, envIds } = await visibleResource(ctx, input.resourceId)
    const environments: {
      environmentId: string
      status: CustomFlowStatus | null
      variables: string[]
      perUser: boolean
      form: FormView[]
      signedInPeople: number | null
      canSignIn: boolean
    }[] = []
    for (const environmentId of envIds) {
      const level = access.level(resource, environmentId)
      if (!level) continue
      const flow = await customFlowConfig(ctx.db, resource.type, resource.id, environmentId)
      if (!flow) {
        environments.push({
          environmentId,
          status: null,
          variables: [],
          perUser: false,
          form: [],
          signedInPeople: null,
          canSignIn: false,
        })
        continue
      }
      const perUser = flowAsksEachPerson(flow.auth.steps)
      environments.push({
        environmentId,
        status: await customFlowStatus(
          ctx.db,
          flow.row.id,
          customFlowHash(flow.http),
          perUser ? ctx.user.id : null,
        ),
        variables: [...new Set(flow.auth.steps.filter((s) => s.type === 'variable').map((s) => s.name))],
        perUser,
        form: formView(flow.auth.steps),
        signedInPeople:
          perUser && atLeast(level, 'edit') ? await countSignedInPeople(ctx.db, flow.row.id) : null,
        canSignIn: perUser || atLeast(level, 'edit'),
      })
    }
    return { environments }
  }),

  /**
   * What the sign-in form asks for, and the user's own sign-in, on a resource whose custom flow has a form step:
   * for the dialog a query's "sign in" opens, also for app viewers without access to the resource (`appId`, as
   * connecting an OAuth account).
   */
  customAuthForm: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id, appId: Id.optional() }))
    .query(async ({ ctx, input }) => {
      const target = await customFlowAccess(ctx, input)
      if (!target.perUser) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: "This resource's sign-in doesn't ask for a form",
        })
      }
      return {
        resourceName: target.resource.name,
        // Where what people type may go: the flow's requests reach only the base URL's host and the allowed hosts.
        sendsTo: [
          ...new Set([
            new URL(target.flow.http.baseUrl).host,
            ...target.flow.http.allowedHosts.map((h) => h.trim()),
          ]),
        ].filter(Boolean),
        form: formView(target.flow.auth.steps),
        status: await customFlowStatus(
          ctx.db,
          target.flow.row.id,
          customFlowHash(target.flow.http),
          ctx.user.id,
        ),
      }
    }),

  /**
   * Signs a custom flow in now and stores the variables for the queries that follow. A shared flow (Edit): its
   * sign-in steps run at once, even during a back-off. A flow with a form step: the user's own sign-in, with what
   * they typed (`form`, never stored or logged), by anyone who sees the resource or uses an app that queries it
   * (`appId`); failures back off per person. A failure comes back as `error` (secret values and what was typed
   * scrubbed) and shows on the card; variables stored before stay in use.
   */
  customAuthSignIn: authedProcedure
    .input(
      z.object({
        resourceId: Id,
        environmentId: Id,
        appId: Id.optional(),
        form: formValuesInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { resource, flow, perUser } = await customFlowAccess(ctx, input)
      const secrets = restConnector.secretsSchema.parse(decryptConfigSecrets(ctx.config.keyring, flow.row))
      const signal = AbortSignal.timeout(SIGN_IN_NOW_TIMEOUT_MS)
      try {
        await signInCustomFlow(
          { db: ctx.db, keyring: ctx.config.keyring, sandbox: ctx.services.sandbox },
          {
            resourceId: resource.id,
            resourceConfigId: flow.row.id,
            environmentId: input.environmentId,
            config: flow.http,
            secrets,
            userId: perUser ? ctx.user.id : null,
          },
          signal,
          perUser ? (input.form ?? {}) : undefined,
        )
      } catch (err) {
        const failure =
          err instanceof ConnectorError
            ? err
            : signal.aborted
              ? new ConnectorError(
                  'timeout',
                  `Signing in took longer than ${SIGN_IN_NOW_TIMEOUT_MS / 1000} s`,
                )
              : null
        if (!failure) throw err
        // Failed attempts leave a trail (who, where, which step; never what was typed): guesses show in the audit.
        if (failure.details?.reason !== 'form_needed') {
          await ctx.audit({
            action: 'resource.custom_auth_sign_in_failed',
            objectType: 'resource',
            objectId: resource.id,
            environmentId: input.environmentId,
            metadata: {
              account: perUser ? 'user' : 'shared',
              ...(typeof failure.details?.step === 'string' && { step: failure.details.step }),
            },
          })
        }
        // Every secret of the resource: its secret headers go out with the flow's requests too, and an API may echo them.
        const scrub = [...secretStrings(secrets), ...secretStrings(input.form ?? {})]
        return {
          ok: false as const,
          error: errorView(
            new ConnectorError(
              failure.code,
              scrubSecrets(failure.message, scrub),
              failure.details && scrubSecretsDeep(failure.details, scrub),
            ),
          ),
        }
      }
      await ctx.audit({
        action: 'resource.custom_auth_signed_in',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: { account: perUser ? 'user' : 'shared' },
      })
      return { ok: true as const }
    }),

  /**
   * Sign out: forgets the shared sign-in (Edit; the next query signs in again), or on a flow with a form step the
   * user's own (they sign in again).
   */
  customAuthSignOut: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id, appId: Id.optional() }))
    .mutation(async ({ ctx, input }) => {
      const { resource, flow, perUser } = await customFlowAccess(ctx, input)
      const signedOut = await signOutCustomFlow(ctx.db, flow.row.id, perUser ? ctx.user.id : null)
      if (signedOut) {
        await ctx.audit({
          action: 'resource.custom_auth_signed_out',
          objectType: 'resource',
          objectId: resource.id,
          environmentId: input.environmentId,
          metadata: { account: perUser ? 'user' : 'shared' },
        })
      }
      return { signedOut }
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
        current_user: {
          id: ctx.user.id,
          email: ctx.user.email,
          name: ctx.user.name,
          groups: await groupsOf(ctx.db, ctx.user.id),
        },
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
      const key = `${row.id}:${resolved.version}:${usesOwnCredentials(resource.type, resolved.config) ? ctx.user.id : ''}`
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
   * The built-in GraphQL resource's schema for one query's endpoint (session 57), asked with the query's own URL,
   * headers and auth, for the editor's completions. Needs Use. A mutation (POST), as Run: the query's credentials stay
   * out of URLs and access logs. Its templates get what the playground's do: the editor's scope, `current_user` and the
   * non-secret config vars (a secret one could otherwise be sent to any host). Kept 10 minutes per person,
   * environment and query, in a small cache of its own; audited, as Run is (it reaches a host the editor chose).
   */
  graphqlApiSchema: authedProcedure
    .input(
      z.object({
        resourceId: Id,
        environmentId: Id,
        query: z.object({ url: z.string(), auth: z.unknown(), headers: z.unknown() }),
        scope: z.record(z.string(), z.unknown()).default({}),
        refresh: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'use', 'this resource in this environment')
      if (resource.type !== graphqlApiConnector.type) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only the built-in GraphQL resource reads a schema per query',
        })
      }
      const row = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!row) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This resource is not configured in this environment',
        })
      }
      const parsed = graphqlApiConnector.querySchema.safeParse({ ...input.query, query: '' })
      if (!parsed.success) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The URL, headers or auth are not valid' })
      }
      const scope = {
        ...input.scope,
        configVars: await publicConfigVars(ctx.db, input.environmentId),
        current_user: {
          id: ctx.user.id,
          email: ctx.user.email,
          name: ctx.user.name,
          groups: await groupsOf(ctx.db, ctx.user.id),
        },
      }
      const key = createHash('sha256')
        .update(
          canonicalJson([
            input.environmentId,
            parsed.data.url,
            parsed.data.auth,
            parsed.data.headers,
            scope,
          ] as never),
        )
        .digest('hex')
      const cached = graphqlApiSchemas.get(key)
      if (cached && !input.refresh && cached.at > Date.now() - GRAPHQL_SCHEMA_TTL_MS) {
        return { ok: true as const, schema: cached.schema }
      }
      let outcome: { ok: true; schema: unknown } | { ok: false; error: ReturnType<typeof errorView> }
      try {
        const schema = toJson(
          await runOperation(
            ctx.services.pool,
            graphqlApiConnector,
            toResolved(ctx.config.keyring, row),
            (client, opts) =>
              introspectGraphqlApi(client as HttpClient, parsed.data, {
                ...opts,
                timeoutMs: GRAPHQL_API_SCHEMA_TIMEOUT_MS,
                evaluate: (code) =>
                  ctx.services.sandbox.evalExpression(code, scope, { timeoutMs: EXPRESSION_TIMEOUT_MS }),
              }),
            { timeoutMs: GRAPHQL_API_SCHEMA_TIMEOUT_MS },
          ),
        )
        if (graphqlApiSchemas.size >= GRAPHQL_API_SCHEMAS_KEPT) {
          graphqlApiSchemas.delete(graphqlApiSchemas.keys().next().value!)
        }
        graphqlApiSchemas.set(key, { at: Date.now(), schema })
        outcome = { ok: true, schema }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err
        outcome = { ok: false, error: errorView(err) }
      }
      await ctx.audit({
        action: 'resource.graphql_schema_read',
        objectType: 'resource',
        objectId: resource.id,
        environmentId: input.environmentId,
        metadata: { ok: outcome.ok, ...(!outcome.ok && { errorCode: outcome.error.code }) },
      })
      return outcome
    }),

  /**
   * A SQL resource's tables and columns (session 57), by its connector's catalog query, for the editor's browser and
   * completions. Needs Use; read as any query of the resource is (its tunnels, sign-in, read-only mode). Kept 10
   * minutes per settings version (and per person, where each signs in with their own account); the built-in Database's
   * is read every time. `supported: false`
   * for a resource whose dialect has no catalog query (an uploaded JDBC driver).
   */
  sqlSchema: authedProcedure
    .input(z.object({ resourceId: Id, environmentId: Id, refresh: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const { access, resource } = await visibleResource(ctx, input.resourceId)
      requireLevel(access.level(resource, input.environmentId), 'use', 'this resource in this environment')
      const connector = connectorFor(resource.type)
      if (!connector.schemaSql) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only database resources have tables to list' })
      }
      const row = await getConfigRow(ctx.db, resource.id, input.environmentId)
      if (!row) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This resource is not configured in this environment',
        })
      }
      const resolved = toResolved(ctx.config.keyring, row)
      const key = `${row.id}:${resolved.version}:${usesOwnCredentials(resource.type, resolved.config) ? ctx.user.id : ''}`
      // The built-in Database's tables change on the Database page: read every time (a quick local query).
      const keep = resource.systemKind !== 'database'
      const cached = keep ? sqlSchemas.get(key) : undefined
      if (cached && !input.refresh && cached.at > Date.now() - SQL_SCHEMA_TTL_MS) {
        return { ok: true as const, supported: true as const, schema: cached.schema }
      }
      const credentials = credentialsFor(
        { db: ctx.db, keyring: ctx.config.keyring, sandbox: ctx.services.sandbox },
        resource.type,
        resolved,
        ctx.user.id,
      )
      try {
        const schema = await describeSqlSchema(ctx.services.pool, connector, resolved, {
          timeoutMs: SQL_SCHEMA_TIMEOUT_MS,
          ...(credentials && { credentials }),
        })
        if (!schema) return { ok: true as const, supported: false as const, schema: null }
        if (keep) {
          if (sqlSchemas.size >= SQL_SCHEMAS_KEPT) sqlSchemas.delete(sqlSchemas.keys().next().value!)
          sqlSchemas.set(key, { at: Date.now(), schema })
        }
        return { ok: true as const, supported: true as const, schema }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err
        return { ok: false as const, error: errorView(err) }
      }
    }),

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
        // Bodies get an example (the document's, or one built from the schema) for the form's "Use the example".
        const operations = doc.operations.map((op) => {
          if (!op.body) return op
          const { schema: _schema, ...body } = op.body
          return { ...op, body: { ...body, example: op.body.example ?? exampleOf(op.body.schema) } }
        })
        return { ok: true as const, title: doc.title, version: doc.version, servers: doc.servers, operations }
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

  /**
   * A HubSpot object type's properties (M27), for the query forms' pickers. Needs Use; kept like a GraphQL schema.
   */
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
      const own = usesOwnCredentials(resource.type, resolved.config)
      const key = `hubspot:${row.id}:${resolved.version}:${own ? ctx.user.id : ''}:${input.objectType}`
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
  mssql: 'Databases',
  jdbc: 'Databases',
  bigquery: 'Databases',
  rest: 'APIs',
  graphql: 'APIs',
  openapi: 'APIs',
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
  gmail: 'Services',
  msteams: 'Services',
  sdk: 'APIs',
  anthropic: 'AI',
  openai_compatible: 'AI',
  gemini: 'AI',
}

const GRAPHQL_SCHEMA_TTL_MS = 10 * 60_000
/**
 * GraphQL schemas and HubSpot properties by config row, settings version, (per-user accounts) person and object type;
 * oldest dropped past 200.
 */
const graphqlSchemas = new Map<string, { at: number; schema: unknown }>()
/** The built-in GraphQL resource's schemas (session 57), apart: their keys are what editors type, so fewer are kept. */
const graphqlApiSchemas = new Map<string, { at: number; schema: unknown }>()
const GRAPHQL_API_SCHEMAS_KEPT = 30
/** SQL resources' tables and columns (session 57); up to 20,000 columns each, so fewer are kept than GraphQL's. */
const sqlSchemas = new Map<string, { at: number; schema: SqlSchema }>()
const SQL_SCHEMAS_KEPT = 50
const SQL_SCHEMA_TTL_MS = 10 * 60_000
/** A catalog read of a large database (or one far away through a tunnel) can take a while. */
const SQL_SCHEMA_TIMEOUT_MS = 60_000
