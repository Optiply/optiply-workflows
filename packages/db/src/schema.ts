import type {
  AppChangeSummary,
  AppDefinition,
  ComponentLibraryDefinition,
  LibraryQueryDefinition,
} from '@ow/app-definition'
import type { OpenTaskField, PythonLock, TaskOutcome, WorkflowDefinition } from '@ow/definition'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { v7 as uuidv7 } from 'uuid'

// IDs are generated app-side as UUIDv7 (time-ordered → index-friendly) so we don't depend on Postgres 18's
// native uuidv7() and can run against any Postgres ≥ 14.
const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7())
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
/** Binary data: postgres.js reads a Buffer and sends one as bytea. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
})

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * `active` can sign in; `pending` signed in once and waits for an admin; `invited` was invited by an admin (any
 * domain) and becomes active at their first sign-in; `rejected` was turned down by an admin.
 */
export const USER_STATUSES = ['active', 'pending', 'invited', 'rejected'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/**
 * What a person may reach: `full` is the platform (as far as their grants go); `apps_only` is only the apps shared with
 * them, used through their own page, never the platform around them. Admins are always `full`.
 */
export const USER_ACCESS = ['full', 'apps_only'] as const
export type UserAccess = (typeof USER_ACCESS)[number]

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Always stored lowercased. */
    email: text().notNull(),
    name: text().notNull(),
    avatarUrl: text(),
    /** `sub` claim from the OIDC provider (Google). Null for local-only accounts. */
    oidcSubject: text(),
    /** scrypt hash for the break-glass local login. Null for SSO-only accounts. */
    passwordHash: text(),
    disabledAt: timestamp({ withTimezone: true }),
    lastLoginAt: timestamp({ withTimezone: true }),
    /** Whether they may sign in yet: see `USER_STATUSES`. Accounts from before approval existed are `active`. */
    status: text({ enum: USER_STATUSES }).notNull().default('active'),
    /** Platform or only their apps: see `USER_ACCESS`. */
    access: text({ enum: USER_ACCESS }).notNull().default('full'),
    /** When a `pending` person first asked to get in. */
    requestedAt: timestamp({ withTimezone: true }),
    /** When an admin approved or rejected them, and who. */
    decidedAt: timestamp({ withTimezone: true }),
    decidedBy: uuid().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    /** The admin who invited them. */
    invitedBy: uuid().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_oidc_subject_uq').on(t.oidcSubject),
    check('users_status_ck', sql`${t.status} in ('active', 'pending', 'invited', 'rejected')`),
    check('users_access_ck', sql`${t.access} in ('full', 'apps_only')`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the opaque session token; the token itself only lives in the cookie. */
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ip: inet(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
)

export const groups = pgTable(
  'groups',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    /** Built-in groups that cannot be renamed or deleted. */
    systemKind: text({ enum: ['admins', 'all_users'] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('groups_name_uq').on(t.name),
    uniqueIndex('groups_system_kind_uq').on(t.systemKind).where(sql`${t.systemKind} is not null`),
  ],
)

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user_idx').on(t.userId)],
)

export const environments = pgTable(
  'environments',
  {
    id: id(),
    slug: text().notNull(),
    name: text().notNull(),
    color: text().notNull().default('#64748b'),
    isDefault: boolean().notNull().default(false),
    /**
     * Only admins may use it (session 56: Staging). Everyone else doesn't see it and is refused it: no runs, app
     * queries or credentials there. The default environment can't be admins-only, so everyone always has one.
     */
    adminOnly: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('environments_slug_uq').on(t.slug),
    check('environments_default_not_admin_only_ck', sql`not (${t.isDefault} and ${t.adminOnly})`),
  ],
)

// ── Organisation ────────────────────────────────────────────────────────────

export const FOLDER_OBJECT_TYPES = [
  'resource',
  'workflow',
  'app',
  'library_query',
  'module',
  'component_library',
] as const

export const folders = pgTable(
  'folders',
  {
    id: id(),
    /** A folder holds one kind of object. */
    objectType: text({ enum: FOLDER_OBJECT_TYPES }).notNull(),
    name: text().notNull(),
    /** Null for top-level folders. Deleting a non-empty folder is refused rather than cascaded. */
    parentId: uuid().references((): AnyPgColumn => folders.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('folders_name_uq').on(t.objectType, t.parentId, t.name).nullsNotDistinct(),
    check(
      'folders_object_type_ck',
      sql`${t.objectType} in ('resource', 'workflow', 'app', 'library_query', 'module', 'component_library')`,
    ),
  ],
)

export const PERMISSION_OBJECT_TYPES = [
  'resource',
  'workflow',
  'app',
  'library_query',
  'module',
  'component_library',
  'folder',
] as const
/** Ordered lowest to highest: each level includes the ones before it. */
export const PERMISSION_LEVELS = ['use', 'edit', 'own'] as const

/**
 * Grants to a group or to one person (exactly one of `groupId`, `userId`); a user's effective level is the highest
 * grant across their own and their groups'. Admins implicitly own everything. `objectId` null = every object of that type; `environmentId` null = every environment (environments
 * only matter for resources). `objectId` is polymorphic, so services delete grants when they delete an object.
 */
export const permissions = pgTable(
  'permissions',
  {
    id: id(),
    groupId: uuid().references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    objectType: text({ enum: PERMISSION_OBJECT_TYPES }).notNull(),
    objectId: uuid(),
    environmentId: uuid().references(() => environments.id, { onDelete: 'cascade' }),
    level: text({ enum: PERMISSION_LEVELS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('permissions_grant_uq')
      .on(t.groupId, t.userId, t.objectType, t.objectId, t.environmentId)
      .nullsNotDistinct(),
    index('permissions_object_idx').on(t.objectType, t.objectId),
    index('permissions_user_idx').on(t.userId),
    check('permissions_subject_ck', sql`(${t.groupId} is null) <> (${t.userId} is null)`),
    check(
      'permissions_object_type_ck',
      sql`${t.objectType} in ('resource', 'workflow', 'app', 'library_query', 'module', 'component_library', 'folder')`,
    ),
    check('permissions_level_ck', sql`${t.level} in ('use', 'edit', 'own')`),
  ],
)

// ── Resources ───────────────────────────────────────────────────────────────

export const resources = pgTable(
  'resources',
  {
    id: id(),
    /** Stable identifier that workflow definitions reference (renaming keeps the slug). */
    slug: text().notNull(),
    name: text().notNull(),
    /** Connector type, e.g. `postgres` or `rest`; validated against the connector registry, not the DB. */
    type: text().notNull(),
    description: text(),
    folderId: uuid().references(() => folders.id, { onDelete: 'set null' }),
    /** Built-in resources the platform provisions and keeps up to date; their settings can't be edited. */
    systemKind: text({ enum: ['database', 'rest'] }),
    /** Kept in the Git repo (M22): its settings change through Git, its secrets and overrides here. */
    gitProtected: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('resources_slug_uq').on(t.slug),
    index('resources_folder_idx').on(t.folderId),
    uniqueIndex('resources_system_kind_uq').on(t.systemKind).where(sql`${t.systemKind} is not null`),
  ],
)

/**
 * The managed database's home in one environment: a schema in the platform database, owned by a login role that
 * can reach nothing else. Workflows reach it through the built-in database resource, which logs in as the role.
 */
export const managedDatabases = pgTable(
  'managed_databases',
  {
    environmentId: uuid()
      .primaryKey()
      .references(() => environments.id, { onDelete: 'cascade' }),
    schemaName: text().notNull(),
    /** Roles are shared by every database on the server, so the name carries a tag of this database's name. */
    roleName: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Two environments must never share a schema or a role.
    uniqueIndex('managed_databases_schema_uq').on(t.schemaName),
    uniqueIndex('managed_databases_role_uq').on(t.roleName),
  ],
)

/** A resource's settings in one environment. No row = the resource isn't configured there. */
export const resourceConfigs = pgTable(
  'resource_configs',
  {
    id: id(),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /** Non-secret settings (host, base URL, options), shaped by the connector's configSchema. */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * This instance's own values for single non-secret fields, by path (`host`, `ssh.host`), applied over `config`
     * (M22). For a protected resource, `config` is Git's and a deploy never touches these.
     */
    overrides: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Encrypted JSON of the connector's secretsSchema (`@ow/crypto` token, AAD `resource_configs:<id>:<envId>`).
     * Never returned to the browser.
     */
    secrets: text(),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('resource_configs_env_uq').on(t.resourceId, t.environmentId)],
)

/**
 * An account connected to a resource in one environment through OAuth (authorization code): the shared one
 * (`user_id` null) or one person's. Tokens go with the settings they were granted under (`consent_hash`): once the
 * client ID, URLs or scopes change, the account must be connected again.
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: id(),
    resourceConfigId: uuid()
      .notNull()
      .references(() => resourceConfigs.id, { onDelete: 'cascade' }),
    /** The config's environment, part of the encryption AAD (`oauth_tokens:<id>:<envId>`). */
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /** Null for the shared account. */
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** Encrypted JSON `{ accessToken, refreshToken }` (`@ow/crypto` token). Never returned to the browser. */
    tokens: text().notNull(),
    /** When the access token expires; null when the provider didn't say. */
    expiresAt: timestamp({ withTimezone: true }),
    /** The scopes the provider says it granted. */
    scope: text(),
    /** Who was connected (an email, a workspace), for display. */
    account: text(),
    /** `reconnect`: the provider refused a refresh (revoked, expired); only connecting again helps. */
    status: text({ enum: ['active', 'reconnect'] })
      .notNull()
      .default('active'),
    /** Why the last refresh was refused (the provider's error code), for the UI. */
    lastError: text(),
    consentHash: text().notNull(),
    connectedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    refreshedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('oauth_tokens_owner_uq').on(t.resourceConfigId, t.userId).nullsNotDistinct(),
    index('oauth_tokens_user_idx').on(t.userId),
    check('oauth_tokens_status_ck', sql`${t.status} in ('active', 'reconnect')`),
  ],
)

/** Org-wide values referenced as `{{ configVars.NAME }}`, set per environment. */
export const configVars = pgTable(
  'config_vars',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    /** Secret values are encrypted at rest and never returned to the browser. */
    isSecret: boolean().notNull().default(false),
    /** Kept in the Git repo (M22): its description and non-secret values change through Git. */
    gitProtected: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('config_vars_name_uq').on(t.name)],
)

export const configVarValues = pgTable(
  'config_var_values',
  {
    id: id(),
    configVarId: uuid()
      .notNull()
      .references(() => configVars.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /** Set for non-secret vars. */
    value: text(),
    /** Set for secret vars (`@ow/crypto` token, AAD `config_var_values:<id>:<envId>`). */
    valueEncrypted: text(),
    /** This instance's own value (M22): a deploy of a protected config var leaves it. */
    local: boolean().notNull().default(false),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('config_var_values_env_uq').on(t.configVarId, t.environmentId),
    check('config_var_values_one_value_ck', sql`num_nonnulls(${t.value}, ${t.valueEncrypted}) = 1`),
  ],
)

// ── API keys ────────────────────────────────────────────────────────────────

/**
 * Keys for calling webhooks (and reading the runs they start) from other systems. Only the sha256 of a key is
 * stored; the key itself is shown once, when it's created. A key can be limited to some workflows and some
 * environments (null = all).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    name: text().notNull(),
    /** `ow_` plus the key's first 8 characters, to tell keys apart. */
    prefix: text().notNull(),
    /** sha256 hex of the key. */
    hash: text().notNull(),
    workflowIds: uuid().array(),
    environmentIds: uuid().array(),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    /** Updated at most once a minute. */
    lastUsedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('api_keys_hash_uq').on(t.hash),
    check('api_keys_hash_ck', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
)

// ── Workflows ───────────────────────────────────────────────────────────────

export const workflows = pgTable(
  'workflows',
  {
    id: id(),
    /** Stable identifier for webhook URLs and child-workflow calls (renaming keeps the slug). */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    folderId: uuid().references(() => folders.id, { onDelete: 'set null' }),
    /** What the editor autosaves; validated by `@ow/definition` before it's stored. */
    draftDefinition: jsonb().$type<WorkflowDefinition>().notNull(),
    /** Bumped on every draft save; a save names the revision it started from (optimistic concurrency). */
    draftRevision: integer().notNull().default(1),
    /** The release that schedules and webhooks run. Null until the first release. */
    liveReleaseId: uuid().references((): AnyPgColumn => workflowReleases.id, { onDelete: 'set null' }),
    /** Null = no limit. Enforced by the dispatcher (M4). */
    maxConcurrentRuns: integer(),
    /** Protected (M11): edited on Git branches and deployed from the repo's branch; read-only on the instance. */
    gitProtected: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workflows_slug_uq').on(t.slug),
    index('workflows_folder_idx').on(t.folderId),
    check(
      'workflows_max_concurrent_runs_ck',
      sql`${t.maxConcurrentRuns} is null or ${t.maxConcurrentRuns} > 0`,
    ),
  ],
)

/**
 * Frozen copies of the draft: kept as history, and pinned by editor runs so a run keeps executing the
 * definition it started with while the draft changes underneath it.
 */
export const workflowDraftSnapshots = pgTable(
  'workflow_draft_snapshots',
  {
    id: id(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** The `draftRevision` this copies; one snapshot per revision. */
    revision: integer().notNull(),
    /**
     * A Git branch draft's snapshot (M11): its `git_branch_drafts` id and revision. No foreign key: runs keep their
     * snapshot after the draft is discarded (retention removes it once no run uses it).
     */
    branchDraftId: uuid(),
    definition: jsonb().$type<WorkflowDefinition>().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('workflow_draft_snapshots_revision_uq')
      .on(t.workflowId, t.revision)
      .where(sql`${t.branchDraftId} is null`),
    uniqueIndex('workflow_draft_snapshots_branch_revision_uq')
      .on(t.branchDraftId, t.revision)
      .where(sql`${t.branchDraftId} is not null`),
  ],
)

/** Published, immutable versions. Only the live release runs from schedules and webhooks. */
export const workflowReleases = pgTable(
  'workflow_releases',
  {
    id: id(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** SemVer `major.minor.patch`. */
    version: text().notNull(),
    /** Canonical form (`canonicalize` from `@ow/definition`). */
    definition: jsonb().$type<WorkflowDefinition>().notNull(),
    /** `definitionHash`: SHA-256 of the canonical definition without layout. */
    definitionHash: text().notNull(),
    notes: text(),
    /** The commit a release deployed from Git came from (M11); null for releases published on the instance. */
    gitCommit: text(),
    /**
     * The Python packages' lock (M23), when the definition declares packages: built when it was published, so live
     * runs install exactly these.
     */
    pythonLock: jsonb().$type<PythonLock>(),
    /**
     * The JavaScript packages' npm lock (`package-lock.json`) and bundle, when the definition declares packages:
     * built when it was published, so live runs load exactly this bundle (`js_bundles.bundle_hash`), rebuilt from
     * the lock if it's gone.
     */
    jsLock: text(),
    jsBundleHash: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('workflow_releases_version_uq').on(t.workflowId, t.version),
    index('workflow_releases_workflow_idx').on(t.workflowId, t.createdAt.desc()),
    check(
      'workflow_releases_version_ck',
      sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check('workflow_releases_hash_ck', sql`${t.definitionHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

// The queue trigger kinds (pubsub, sqs, kafka, rabbitmq, kinesis) were removed in session 54: rows kept, none created.
export const TRIGGER_KINDS = ['webhook', 'schedule', 'pubsub', 'sqs', 'kafka', 'rabbitmq', 'kinesis'] as const

/** A queue trigger's runtime state (Pub/Sub, SQS, Kafka), as its consumer reports it (`workflow_triggers.state`). */
export interface QueueTriggerState {
  inFlight: number
  lastMessageAt: string | null
  lastPullAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

/**
 * The runtime projection of the live release's triggers, rewritten when a release goes live: rows are matched by
 * kind and name, so a trigger keeps its id (and its runs' `ON CONFLICT (trigger_id, scheduled_for)` guard) across
 * releases. Schedules are ticked off `nextFireAt`.
 */
export const workflowTriggers = pgTable(
  'workflow_triggers',
  {
    id: id(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    releaseId: uuid()
      .notNull()
      .references(() => workflowReleases.id, { onDelete: 'cascade' }),
    kind: text({ enum: TRIGGER_KINDS }).notNull(),
    /** The schedule's or queue trigger's name from the definition; `webhook` for the webhook. */
    name: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** The trigger's settings from the definition (cron or interval, timezone, overlap). */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Schedules and queue triggers: the environment their runs start in. */
    environmentId: uuid().references(() => environments.id, { onDelete: 'cascade' }),
    /**
     * An enabled webhook's alias with every param as `:` (`orders/:/refunds`). Unique, so two live webhooks can't
     * answer the same URLs.
     */
    aliasShape: text(),
    nextFireAt: timestamp({ withTimezone: true }),
    /** The fire time of the schedule's latest run; interval schedules keep to its grid. */
    lastFiredAt: timestamp({ withTimezone: true }),
    /** Queue triggers (Pub/Sub, SQS, Kafka): the worker receiving for it now, until its lease lapses (renewed meanwhile). */
    leaseOwner: text(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    /**
     * Queue triggers: what the worker receiving for it last reported (each lease tick), for the editor: messages in
     * flight, the last one, the last pull error and when it happened, when a pull last succeeded.
     */
    state: jsonb().$type<QueueTriggerState>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workflow_triggers_name_uq').on(t.workflowId, t.kind, t.name),
    uniqueIndex('workflow_triggers_alias_uq').on(t.aliasShape).where(sql`${t.aliasShape} is not null`),
    index('workflow_triggers_due_idx').on(t.nextFireAt).where(sql`${t.kind} = 'schedule' and ${t.enabled}`),
    check(
      'workflow_triggers_kind_ck',
      sql`${t.kind} in ('webhook', 'schedule', 'pubsub', 'sqs', 'kafka', 'rabbitmq', 'kinesis')`,
    ),
  ],
)

/**
 * Webhook rate limits (M15): one row per webhook and fixed window, counted on the database clock so every API
 * process shares the limit. Windows past `expires_at` are deleted by retention.
 */
export const webhookRateWindows = pgTable(
  'webhook_rate_windows',
  {
    triggerId: uuid()
      .notNull()
      .references(() => workflowTriggers.id, { onDelete: 'cascade' }),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.triggerId, t.windowStart] }),
    index('webhook_rate_windows_expires_idx').on(t.expiresAt),
  ],
)

/**
 * Calls a live webhook refused (M15): 4xx answers, for the editor's webhook panel. Never the body or a signature.
 * Retention keeps 7 days and the latest 200 per webhook.
 */
export const webhookRejections = pgTable(
  'webhook_rejections',
  {
    id: id(),
    triggerId: uuid()
      .notNull()
      .references(() => workflowTriggers.id, { onDelete: 'cascade' }),
    /** Null when the call was refused before its environment was known. */
    environmentId: uuid().references(() => environments.id, { onDelete: 'set null' }),
    status: integer().notNull(),
    /** A code such as `signature_mismatch` or `rate_limited`. */
    reason: text().notNull(),
    message: text().notNull(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_rejections_trigger_idx').on(t.triggerId, t.createdAt)],
)

/**
 * Messages a queue trigger has seen (Pub/Sub M19, SQS and Kafka M26; architecture §2.22, §2.29): how many runs they
 * started (each delivery is one, idempotency key `<kind>:<trigger>:<message>:<n>`), the latest, and how it ended. A
 * redelivery of a message whose run succeeded is answered without a run; one whose run is still going is held, not run
 * again. The message id is Pub/Sub's or SQS's, or Kafka's `<topic>/<partition>/<offset>@<timestamp>`. Retention prunes old ones.
 */
/**
 * Where a Kinesis trigger (M30) has got to in each shard: the sequence number of the last record whose run ended
 * (succeeded, or given up on after its attempts). A shard without a row starts where the trigger says (latest or
 * trim horizon); a closed shard whose last record is done is `finished`, and its children start then.
 */
export const kinesisCheckpoints = pgTable(
  'kinesis_checkpoints',
  {
    triggerId: uuid()
      .notNull()
      .references(() => workflowTriggers.id, { onDelete: 'cascade' }),
    shardId: text().notNull(),
    sequenceNumber: text(),
    finished: boolean().notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.triggerId, t.shardId] })],
)

export const queueDeliveries = pgTable(
  'queue_deliveries',
  {
    triggerId: uuid()
      .notNull()
      .references(() => workflowTriggers.id, { onDelete: 'cascade' }),
    messageId: text().notNull(),
    runs: integer().notNull().default(0),
    lastRunId: uuid().references(() => workflowRuns.id, { onDelete: 'set null' }),
    /**
     * Null while the latest run is under way; `released` when it was acked past `maxHoldMinutes`; Kafka's
     * `dead_lettered` (sent to the dead-letter topic) and `dropped` (no dead-letter topic) after its last attempt.
     */
    outcome: text({ enum: ['succeeded', 'failed', 'released', 'dead_lettered', 'dropped'] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.triggerId, t.messageId] }),
    index('queue_deliveries_updated_idx').on(t.updatedAt),
    check(
      'queue_deliveries_outcome_ck',
      sql`${t.outcome} in ('succeeded', 'failed', 'released', 'dead_lettered', 'dropped')`,
    ),
  ],
)

// ── Runs ────────────────────────────────────────────────────────────────────

/** `queued` and `waiting` runs are claimable once `availableAt` passes; the last three are final. */
export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const
/**
 * `git` (M22): Settings → Git's notify workflow, run when a deploy's problems change. `app` (M36): an app's "Run
 * workflow" query, as the person using the app.
 */
// Queue trigger runs (pubsub, sqs, kafka, rabbitmq, kinesis; removed in session 54) are kept; none are started.
export const RUN_TRIGGER_TYPES = [
  'manual',
  'webhook',
  'schedule',
  'workflow',
  'pubsub',
  'git',
  'sqs',
  'kafka',
  'rabbitmq',
  'kinesis',
  'app',
] as const
export const BLOCK_STATUSES = [
  'pending',
  'running',
  'succeeded',
  /** Failed with `finally: continue`: the error port fired and the run went on. */
  'errored',
  /** Failed with `finally: stop`: the run failed. */
  'failed',
  'skipped',
  'waiting',
  'cancelled',
  /** Its worker died mid-block; the next lease runs it again. */
  'interrupted',
] as const

/**
 * One execution of a workflow, and the job queue. Workers claim `queued`/`waiting` rows whose `availableAt` has
 * passed with `FOR UPDATE SKIP LOCKED`, which sets the lease and bumps `epoch`. Every write a worker makes
 * afterwards is conditional on the epoch it claimed with, so a worker whose lease expired (a "zombie") can't
 * overwrite the work of the one that took over.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: id(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** What runs: exactly one of a release or a draft snapshot (editor runs). */
    releaseId: uuid().references(() => workflowReleases.id),
    draftSnapshotId: uuid().references(() => workflowDraftSnapshots.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    triggerType: text({ enum: RUN_TRIGGER_TYPES }).notNull(),
    triggerId: uuid().references(() => workflowTriggers.id, { onDelete: 'set null' }),
    status: text({ enum: RUN_STATUSES }).notNull().default('queued'),
    /** What the start trigger receives: `{ data, headers, pathParams, urlParams }`. */
    input: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** The first Response block's reply: `{ status, headers, body }`. */
    response: jsonb().$type<Record<string, unknown>>(),
    /** Why the run failed: `{ message, code?, block? }`, redacted. */
    error: jsonb().$type<Record<string, unknown>>(),

    // Queue and lease.
    /** Not claimable before this (retry backoff, durable waits). */
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    /** Fencing token, incremented by every claim. */
    epoch: integer().notNull().default(0),
    /** Claims after a lost lease; the run fails after 3. */
    recoveries: integer().notNull().default(0),
    /** Run timeout. Set when the run first starts; a resumed run moves it on by the time it spent waiting. */
    deadlineAt: timestamp({ withTimezone: true }),
    /** When the run paused (`waiting`, M5); cleared when it resumes and its deadline moves on. */
    suspendedAt: timestamp({ withTimezone: true }),
    /** Someone cancelled the run while it was running; the process holding it stops it as `cancelled`. */
    cancelRequestedAt: timestamp({ withTimezone: true }),

    /** From the webhook's `Idempotency-Key` header: a repeat returns the existing run. */
    idempotencyKey: text(),
    /** The schedule fire time this run is for, so each fire runs once. */
    scheduledFor: timestamp({ withTimezone: true }),
    parentRunId: uuid().references((): AnyPgColumn => workflowRuns.id, { onDelete: 'set null' }),
    /** The editor's "Run block": only these blocks (and ancestors without a seeded result) run. Null = all. */
    targetBlocks: text().array(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** The API key a webhook call presented. */
    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('workflow_runs_claim_idx').on(t.availableAt).where(sql`${t.status} in ('queued', 'waiting')`),
    index('workflow_runs_lease_idx').on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
    index('workflow_runs_workflow_idx').on(t.workflowId, t.createdAt.desc()),
    // Concurrency gates and schedule overlap checks count a workflow's or trigger's active runs.
    index('workflow_runs_running_idx').on(t.workflowId).where(sql`${t.status} = 'running'`),
    index('workflow_runs_trigger_active_idx')
      .on(t.triggerId)
      .where(sql`${t.triggerId} is not null and ${t.status} in ('queued', 'running', 'waiting')`),
    // Foreign keys that deletes have to check or clear (retention deletes runs in bulk).
    index('workflow_runs_parent_idx').on(t.parentRunId).where(sql`${t.parentRunId} is not null`),
    index('workflow_runs_trigger_idx').on(t.triggerId).where(sql`${t.triggerId} is not null`),
    index('workflow_runs_draft_snapshot_idx')
      .on(t.draftSnapshotId)
      .where(sql`${t.draftSnapshotId} is not null`),
    // Retention finds old finished runs by when they finished.
    index('workflow_runs_finished_idx').on(t.finishedAt).where(sql`${t.finishedAt} is not null`),
    // Per environment (session 40; per workflow before 0040): a key used in staging doesn't replay in production.
    uniqueIndex('workflow_runs_idempotency_uq')
      .on(t.workflowId, t.environmentId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex('workflow_runs_schedule_uq')
      .on(t.triggerId, t.scheduledFor)
      .where(sql`${t.triggerId} is not null and ${t.scheduledFor} is not null`),
    check(
      'workflow_runs_status_ck',
      sql`${t.status} in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'workflow_runs_trigger_type_ck',
      sql`${t.triggerType} in ('manual', 'webhook', 'schedule', 'workflow', 'pubsub', 'git', 'sqs', 'kafka', 'rabbitmq', 'kinesis', 'app')`,
    ),
    check('workflow_runs_source_ck', sql`num_nonnulls(${t.releaseId}, ${t.draftSnapshotId}) = 1`),
    check(
      'workflow_runs_lease_ck',
      sql`${t.status} <> 'running' or (${t.leaseOwner} is not null and ${t.leaseExpiresAt} is not null)`,
    ),
    check(
      'workflow_runs_finished_ck',
      sql`(${t.status} in ('succeeded', 'failed', 'cancelled')) = (${t.finishedAt} is not null)`,
    ),
  ],
)

/**
 * One block's execution in a run, keyed by block name (later also `loop1[17]` for loop iterations). The unique
 * key plus the run's epoch check make each block's result commit exactly once, even though a block can execute
 * more than once when a worker dies.
 */
export const blockRuns = pgTable(
  'block_runs',
  {
    id: id(),
    runId: uuid()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    blockKey: text().notNull(),
    status: text({ enum: BLOCK_STATUSES }).notNull(),
    /** 1 for the first try; retries count up. */
    attempt: integer().notNull().default(1),
    /** The run epoch of the lease that wrote this row. */
    epoch: integer().notNull(),
    /** The output that fired (`out`, `error`, `cond:<id>`, `else`); null while running or when none did. */
    port: text(),
    /** `{ message, code? }`, redacted. */
    error: jsonb().$type<Record<string, unknown>>(),
    /** Connector metadata, row counts, loop iterations… Small; the data itself is in `block_run_payloads`. */
    metadata: jsonb().$type<Record<string, unknown>>(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('block_runs_key_uq').on(t.runId, t.blockKey),
    check(
      'block_runs_status_ck',
      sql`${t.status} in ('pending', 'running', 'succeeded', 'errored', 'failed', 'skipped', 'waiting', 'cancelled', 'interrupted')`,
    ),
    check('block_runs_attempt_ck', sql`${t.attempt} >= 1`),
  ],
)

/** A block's data at most (session 40: 50 MB, was 10 MB; the user's word). */
export const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024

/** A block's output data, kept apart so listing a run's blocks stays cheap. Capped at `MAX_PAYLOAD_BYTES`. */
export const blockRunPayloads = pgTable(
  'block_run_payloads',
  {
    blockRunId: uuid()
      .primaryKey()
      .references(() => blockRuns.id, { onDelete: 'cascade' }),
    data: jsonb().$type<unknown>(),
    /** Size of the data as JSON text, checked by the engine before writing. */
    sizeBytes: integer().notNull(),
  },
  (t) => [check('block_run_payloads_size_ck', sql`${t.sizeBytes} between 0 and 52428800`)],
)

export const TASK_STATUSES = ['open', 'completed', 'expired', 'cancelled'] as const

/**
 * A User Task block's task: what the assignees see in their inbox, and what they answered. One per run and block,
 * so a block that runs again finds its task. Titles, fields and assignees are stored as they were when it opened.
 */
export const userTasks = pgTable(
  'user_tasks',
  {
    id: id(),
    runId: uuid()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    blockKey: text().notNull(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    status: text({ enum: TASK_STATUSES }).notNull().default('open'),
    title: text().notNull(),
    description: text(),
    /** The block's fields with their defaults evaluated. */
    fields: jsonb().$type<OpenTaskField[]>().notNull().default([]),
    outcomes: jsonb().$type<TaskOutcome[]>().notNull(),
    assigneeUserIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    assigneeGroupIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    dueAt: timestamp({ withTimezone: true }),
    outcome: text(),
    values: jsonb().$type<Record<string, unknown>>(),
    completedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_tasks_block_uq').on(t.runId, t.blockKey),
    index('user_tasks_open_idx').on(t.createdAt).where(sql`${t.status} = 'open'`),
    check('user_tasks_status_ck', sql`${t.status} in ('open', 'completed', 'expired', 'cancelled')`),
    check(
      'user_tasks_completed_ck',
      sql`(${t.status} = 'completed') = (${t.outcome} is not null and ${t.completedAt} is not null)`,
    ),
  ],
)

export const LOG_LEVELS = ['log', 'info', 'warn', 'error'] as const

/** `console.*` from code and engine messages, redacted before insert. */
export const runLogs = pgTable(
  'run_logs',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    runId: uuid()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** Null for run-level messages. */
    blockKey: text(),
    level: text({ enum: LOG_LEVELS }).notNull(),
    message: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('run_logs_run_idx').on(t.runId, t.id),
    check('run_logs_level_ck', sql`${t.level} in ('log', 'info', 'warn', 'error')`),
  ],
)

// ── Apps ────────────────────────────────────────────────────────────────────

export const apps = pgTable(
  'apps',
  {
    id: id(),
    /** Stable identifier in the app's URL (renaming keeps it). */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    folderId: uuid().references(() => folders.id, { onDelete: 'set null' }),
    /** What the editor autosaves; it must match `@ow/app-definition`'s schema but may otherwise be invalid. */
    draftDefinition: jsonb().$type<AppDefinition>().notNull(),
    /** Bumped on every draft save; a save names the revision it started from (optimistic concurrency). */
    draftRevision: integer().notNull().default(1),
    /** The release people using the app see. Null until the first release. */
    liveReleaseId: uuid().references((): AnyPgColumn => appReleases.id, { onDelete: 'set null' }),
    /** Protected (M11): edited on Git branches and deployed from the repo's branch; read-only on the instance. */
    gitProtected: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('apps_slug_uq').on(t.slug), index('apps_folder_idx').on(t.folderId)],
)

/** Published, immutable versions of an app. People with Use see the live one. */
export const appReleases = pgTable(
  'app_releases',
  {
    id: id(),
    appId: uuid()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** SemVer `major.minor.patch`. */
    version: text().notNull(),
    /** Canonical form (`canonicalizeApp`). */
    definition: jsonb().$type<AppDefinition>().notNull(),
    /** `appDefinitionHash`: SHA-256 of the canonical definition, layout included. */
    definitionHash: text().notNull(),
    notes: text(),
    /** The commit a release deployed from Git came from (M11); null for releases published on the instance. */
    gitCommit: text(),
    /** The JavaScript packages' npm lock and bundle, as on `workflow_releases`. */
    jsLock: text(),
    jsBundleHash: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('app_releases_version_uq').on(t.appId, t.version),
    index('app_releases_app_idx').on(t.appId, t.createdAt.desc()),
    check(
      'app_releases_version_ck',
      sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check('app_releases_hash_ck', sql`${t.definitionHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

/**
 * An app's draft as it was (session 41, the editor's History, after Retool's save log). Every save of the main draft
 * records one; a save by the same person within minutes of their last updates that entry instead, so a burst of
 * edits is one entry. The newest 200 per app are kept. Branch drafts have Git's history instead.
 */
export const appDraftVersions = pgTable(
  'app_draft_versions',
  {
    id: id(),
    appId: uuid()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** The draft revision this version was saved as (its last save, for an entry several saves updated). */
    revision: integer().notNull(),
    definition: jsonb().$type<AppDefinition>().notNull(),
    /** What changed since the version before (`summarizeAppChange`), for the entry's label. */
    summary: jsonb().$type<AppChangeSummary>().notNull(),
    /** Set when this version restored an older one. */
    restoredFrom: uuid(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** When the entry last took a save. */
    updatedAt: updatedAt(),
  },
  (t) => [index('app_draft_versions_app_idx').on(t.appId, t.updatedAt.desc())],
)

// ── Query Library (M14) ─────────────────────────────────────────────────────

/** Library queries: one resource query used by many apps, built like apps (a draft, releases, the live one). */
export const libraryQueries = pgTable(
  'library_queries',
  {
    id: id(),
    /** How apps reference it (with a version or `latest`); renaming keeps it. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    folderId: uuid().references(() => folders.id, { onDelete: 'set null' }),
    /** What the editor autosaves; it must match the schema but may otherwise be invalid. */
    draftDefinition: jsonb().$type<LibraryQueryDefinition>().notNull(),
    draftRevision: integer().notNull().default(1),
    /** The release apps following `latest` run. Null until the first release. */
    liveReleaseId: uuid().references((): AnyPgColumn => libraryQueryReleases.id, { onDelete: 'set null' }),
    /** Protected in Git (M14 step 7), like apps. */
    gitProtected: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('library_queries_slug_uq').on(t.slug),
    index('library_queries_folder_idx').on(t.folderId),
  ],
)

/** Published, immutable versions of a library query; apps pin one or follow the live one. */
export const libraryQueryReleases = pgTable(
  'library_query_releases',
  {
    id: id(),
    libraryQueryId: uuid()
      .notNull()
      .references(() => libraryQueries.id, { onDelete: 'cascade' }),
    version: text().notNull(),
    definition: jsonb().$type<LibraryQueryDefinition>().notNull(),
    /** `libraryQueryHash`. */
    definitionHash: text().notNull(),
    notes: text(),
    gitCommit: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('library_query_releases_version_uq').on(t.libraryQueryId, t.version),
    index('library_query_releases_query_idx').on(t.libraryQueryId, t.createdAt.desc()),
    check(
      'library_query_releases_version_ck',
      sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check('library_query_releases_hash_ck', sql`${t.definitionHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

// ── Modules (M14) ───────────────────────────────────────────────────────────

/** Modules: reusable pieces of app placed in apps, built like apps (a draft, releases, the live one). */
export const modules = pgTable(
  'modules',
  {
    id: id(),
    /** How apps place it (with a version or `latest`); renaming keeps it. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    folderId: uuid().references(() => folders.id, { onDelete: 'set null' }),
    /** An app definition with its `module` part; must match the schema but may otherwise be invalid. */
    draftDefinition: jsonb().$type<AppDefinition>().notNull(),
    draftRevision: integer().notNull().default(1),
    /** The release instances following `latest` run. Null until the first release. */
    liveReleaseId: uuid().references((): AnyPgColumn => moduleReleases.id, { onDelete: 'set null' }),
    /** Protected in Git (M14 step 7), like apps. */
    gitProtected: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('modules_slug_uq').on(t.slug), index('modules_folder_idx').on(t.folderId)],
)

/** Published, immutable versions of a module; instances pin one or follow the live one. */
export const moduleReleases = pgTable(
  'module_releases',
  {
    id: id(),
    moduleId: uuid()
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    version: text().notNull(),
    /** Canonical form (`canonicalizeApp`). */
    definition: jsonb().$type<AppDefinition>().notNull(),
    /** `appDefinitionHash`. */
    definitionHash: text().notNull(),
    notes: text(),
    gitCommit: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('module_releases_version_uq').on(t.moduleId, t.version),
    index('module_releases_module_idx').on(t.moduleId, t.createdAt.desc()),
    check(
      'module_releases_version_ck',
      sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check('module_releases_hash_ck', sql`${t.definitionHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

// ── Component libraries (M25) ───────────────────────────────────────────────

/**
 * Component libraries: React components apps place, written in the platform and built on the server (architecture
 * §2.28), built like modules (a draft, releases, the live one).
 */
export const componentLibraries = pgTable(
  'component_libraries',
  {
    id: id(),
    /** How apps reference it (with a version or `latest`); renaming keeps it. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    folderId: uuid().references(() => folders.id, { onDelete: 'set null' }),
    /** Must match the schema but may otherwise be invalid. */
    draftDefinition: jsonb().$type<ComponentLibraryDefinition>().notNull(),
    draftRevision: integer().notNull().default(1),
    /** The `package-lock.json` the draft's last build made or followed; the next build starts from it. */
    draftLock: text(),
    /** The release apps following `latest` run. Null until the first release. */
    liveReleaseId: uuid().references((): AnyPgColumn => componentLibraryReleases.id, {
      onDelete: 'set null',
    }),
    gitProtected: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('component_libraries_slug_uq').on(t.slug),
    index('component_libraries_folder_idx').on(t.folderId),
  ],
)

/**
 * Built bundles (M25): one ESM file exporting each component by name and its CSS, by the SHA-256 of both (served at
 * an immutable URL). `inputHash` (the files, dependencies and lock) finds a draft's earlier build; null for an
 * uploaded bundle. Releases keep theirs; the others go after a while (retention).
 */
export const componentBundles = pgTable(
  'component_bundles',
  {
    hash: text().primaryKey(),
    inputHash: text(),
    js: text().notNull(),
    css: text().notNull(),
    /** The lock the build installed from. */
    lock: text(),
    sizeBytes: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('component_bundles_input_uq').on(t.inputHash),
    check('component_bundles_hash_ck', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
)

/** Published, immutable versions of a component library, with their build. */
export const componentLibraryReleases = pgTable(
  'component_library_releases',
  {
    id: id(),
    componentLibraryId: uuid()
      .notNull()
      .references(() => componentLibraries.id, { onDelete: 'cascade' }),
    version: text().notNull(),
    /** Canonical form (`canonicalizeComponentLibrary`); an uploaded release has no files. */
    definition: jsonb().$type<ComponentLibraryDefinition>().notNull(),
    /** `componentLibraryHash`. */
    definitionHash: text().notNull(),
    bundleHash: text()
      .notNull()
      .references(() => componentBundles.hash, { onDelete: 'restrict' }),
    lock: text(),
    /** Made from a bundle built elsewhere (`componentLibraries.uploadBuild`), not from files. */
    uploaded: boolean().notNull().default(false),
    notes: text(),
    gitCommit: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('component_library_releases_version_uq').on(t.componentLibraryId, t.version),
    index('component_library_releases_library_idx').on(t.componentLibraryId, t.createdAt.desc()),
    index('component_library_releases_bundle_idx').on(t.bundleHash),
    check(
      'component_library_releases_version_ck',
      sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check('component_library_releases_hash_ck', sql`${t.definitionHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

// ── Audit ───────────────────────────────────────────────────────────────────

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Dotted verb, e.g. `auth.login`, `group.member_added`, `resource.update`. */
    action: text().notNull(),
    objectType: text(),
    objectId: text(),
    environmentId: uuid().references(() => environments.id, { onDelete: 'set null' }),
    ip: inet(),
    userAgent: text(),
    /** Redacted before insert — never contains secrets. */
    metadata: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_events_object_idx').on(t.objectType, t.objectId, t.at.desc()),
    index('audit_events_actor_idx').on(t.actorUserId, t.at.desc()),
    index('audit_events_at_idx').on(t.at.desc()),
  ],
)

export type User = typeof users.$inferSelect
export type Group = typeof groups.$inferSelect
export type Environment = typeof environments.$inferSelect
export type Folder = typeof folders.$inferSelect
export type Permission = typeof permissions.$inferSelect
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
export type PermissionObjectType = (typeof PERMISSION_OBJECT_TYPES)[number]
export type Resource = typeof resources.$inferSelect
export type ResourceConfig = typeof resourceConfigs.$inferSelect
export type ManagedDatabase = typeof managedDatabases.$inferSelect
export type LibraryQuery = typeof libraryQueries.$inferSelect
export type LibraryQueryRelease = typeof libraryQueryReleases.$inferSelect
export type Module = typeof modules.$inferSelect
export type ModuleRelease = typeof moduleReleases.$inferSelect
export type ComponentLibrary = typeof componentLibraries.$inferSelect
export type ComponentLibraryRelease = typeof componentLibraryReleases.$inferSelect
export type ComponentBundle = typeof componentBundles.$inferSelect
export type OAuthToken = typeof oauthTokens.$inferSelect
export type ConfigVar = typeof configVars.$inferSelect
export type ConfigVarValue = typeof configVarValues.$inferSelect
export type Workflow = typeof workflows.$inferSelect
export type WorkflowDraftSnapshot = typeof workflowDraftSnapshots.$inferSelect
export type WorkflowRelease = typeof workflowReleases.$inferSelect
export type WorkflowTrigger = typeof workflowTriggers.$inferSelect
export type WebhookRejection = typeof webhookRejections.$inferSelect
export type WorkflowRun = typeof workflowRuns.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect

/** What a personal access token may do (M33): one scope for now. */
export const ACCESS_TOKEN_SCOPES = ['component-libraries'] as const
export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number]

/**
 * Personal access tokens (M33, docs/architecture.md §2.36): a user's own, acting as them within their scopes
 * (`Authorization: Bearer owpat_…` on tRPC). Only the sha256 is kept.
 */
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** `owpat_` plus the token's first 8 characters. */
    prefix: text().notNull(),
    /** sha256 hex of the token. */
    hash: text().notNull(),
    scopes: text().array().$type<AccessTokenScope[]>().notNull(),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    /** Updated at most once a minute. */
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('personal_access_tokens_hash_uq').on(t.hash),
    index('personal_access_tokens_user_idx').on(t.userId),
    check('personal_access_tokens_hash_ck', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
)

export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect

/**
 * npm registries an admin defines for component libraries' builds (M33, docs/architecture.md §2.36): one per scope
 * (`@acme`), or one without a scope replacing NPM_REGISTRY_URL. The token is a secret config var's name, read in the
 * default environment by the build. Not in Git.
 */
export const npmRegistries = pgTable(
  'npm_registries',
  {
    id: id(),
    /** `@acme`, or null for every package without a registry of its own. */
    scope: text(),
    url: text().notNull(),
    tokenConfigVar: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('npm_registries_scope_uq').on(t.scope).nullsNotDistinct()],
)

export type NpmRegistry = typeof npmRegistries.$inferSelect

/**
 * Apps and workflows imported from Retool (M36): which Retool app or workflow each came from (`retool_key`: an app's
 * uuid; a workflow's webhook trigger uuid, else its name, as workflow exports carry no uuid), so importing it again
 * saves a new draft of the same one. Keeps the import's report, never the export.
 */
export const retoolImports = pgTable(
  'retool_imports',
  {
    id: id(),
    kind: text({ enum: ['app', 'workflow'] }).notNull(),
    retoolKey: text().notNull(),
    retoolName: text().notNull(),
    appId: uuid().references(() => apps.id, { onDelete: 'cascade' }),
    workflowId: uuid().references(() => workflows.id, { onDelete: 'cascade' }),
    report: jsonb().notNull(),
    importedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('retool_imports_key_uq').on(t.kind, t.retoolKey),
    check(
      'retool_imports_target_ck',
      sql`(${t.kind} = 'app' and ${t.appId} is not null and ${t.workflowId} is null) or (${t.kind} = 'workflow' and ${t.workflowId} is not null and ${t.appId} is null)`,
    ),
  ],
)

/**
 * What a Retool resource or workflow is here (M36), remembered from the last import that mapped it: a Retool resource
 * (by name or uuid) → a resource; a Retool workflow (by uuid) → a workflow.
 */
export const retoolMappings = pgTable(
  'retool_mappings',
  {
    id: id(),
    kind: text({ enum: ['resource', 'workflow'] }).notNull(),
    retoolKey: text().notNull(),
    resourceId: uuid().references(() => resources.id, { onDelete: 'cascade' }),
    workflowId: uuid().references(() => workflows.id, { onDelete: 'cascade' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('retool_mappings_key_uq').on(t.kind, t.retoolKey),
    check(
      'retool_mappings_target_ck',
      sql`(${t.kind} = 'resource' and ${t.resourceId} is not null and ${t.workflowId} is null) or (${t.kind} = 'workflow' and ${t.workflowId} is not null and ${t.resourceId} is null)`,
    ),
  ],
)

/**
 * JDBC drivers admins uploaded (M38): a jar each, by its SHA-256, with the class that is its `java.sql.Driver`. JDBC
 * resources pick one by id; the JDBC runner gets the jar the first time it needs it.
 */
export const jdbcDrivers = pgTable(
  'jdbc_drivers',
  {
    id: id(),
    name: text().notNull(),
    className: text().notNull(),
    fileName: text().notNull(),
    sha256: text().notNull(),
    size: integer().notNull(),
    jar: bytea().notNull(),
    uploadedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('jdbc_drivers_name_uq').on(t.name)],
)

export type JdbcDriverRow = typeof jdbcDrivers.$inferSelect
export type RetoolImport = typeof retoolImports.$inferSelect
export type RetoolMapping = typeof retoolMappings.$inferSelect
export type RunStatus = (typeof RUN_STATUSES)[number]
export type RunTriggerType = (typeof RUN_TRIGGER_TYPES)[number]
export type BlockRun = typeof blockRuns.$inferSelect
export type BlockStatus = (typeof BLOCK_STATUSES)[number]
export type BlockRunPayload = typeof blockRunPayloads.$inferSelect
export type RunLog = typeof runLogs.$inferSelect
export type LogLevel = (typeof LOG_LEVELS)[number]
export type AuditEvent = typeof auditEvents.$inferSelect
export type App = typeof apps.$inferSelect
export type AppRelease = typeof appReleases.$inferSelect

/**
 * Periodic housekeeping (retention). A worker claims a job by moving `lastStartedAt` on, so each one runs once per
 * period across all workers without holding a lock while it works.
 */
export const maintenanceJobs = pgTable('maintenance_jobs', {
  name: text().primaryKey(),
  lastStartedAt: timestamp({ withTimezone: true }),
  lastFinishedAt: timestamp({ withTimezone: true }),
  /** What the last run did (counts, duration) or why it failed. */
  lastResult: jsonb().$type<Record<string, unknown>>(),
})

/**
 * The instance's Git repo (M11): one row at most. The token and webhook secret are one encrypted JSON value
 * (`git_settings:<id>:-`), never returned to the browser.
 */
/** The Git hosts sync works with (M31). */
export const GIT_HOSTS = ['github', 'gitlab'] as const
export type GitHostKind = (typeof GIT_HOSTS)[number]

export const gitSettings = pgTable(
  'git_settings',
  {
    id: id(),
    /** Always true: the unique constraint keeps the table to one row. */
    singleton: boolean().notNull().default(true),
    /** `https://github.com/<owner>/<repo>.git`, without credentials. */
    repoUrl: text().notNull(),
    /** The branch deploys come from. */
    branch: text().notNull().default('main'),
    /** Where the repo is hosted (M31): its pull or merge requests, webhook and sign-in. */
    host: text({ enum: GIT_HOSTS }).notNull().default('github'),
    /** GitHub's sign-in (M31): a token, or a GitHub App (its id here, its private key a secret). */
    githubAuth: text({ enum: ['token', 'app'] })
      .notNull()
      .default('token'),
    githubAppId: text(),
    /** GitLab's API for an instance under a path (M31); null: `<origin>/api/v4`. */
    apiUrl: text(),
    /** Encrypted JSON `{ token?, webhookSecret?, appPrivateKey? }` (`@ow/crypto` token). */
    secrets: text(),
    /** The branch commit the last deploy went through (null: never, or the repo or branch changed since). */
    deployedCommit: text(),
    /** When a deploy last checked the branch, and why it couldn't when it couldn't (cleared on success). */
    checkedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** A webhook or an admin asked for a deploy; the process holding the lease goes again when it's done. */
    deployRequestedAt: timestamp({ withTimezone: true }),
    deployRequestedBy: text({ enum: ['poll', 'webhook', 'manual', 'retry'] }),
    /** One deploy at a time across processes: whoever moves this into the future runs it. */
    deployLeaseUntil: timestamp({ withTimezone: true }),
    /**
     * Something a problem object may have been waiting for changed (a resource, config var, library query or module;
     * M22): the next poll re-checks the last deploy's problem objects without a new commit.
     */
    retryRequestedAt: timestamp({ withTimezone: true }),
    /** Its live release runs when a deploy ends with different problems than last time (M22). */
    notifyWorkflowId: uuid().references((): AnyPgColumn => workflows.id, { onDelete: 'set null' }),
    /** The problems the last notification was about (null: none yet), to tell when they change. */
    notifiedProblems: jsonb().$type<GitHealthProblem[]>(),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('git_settings_singleton_uq').on(t.singleton),
    check('git_settings_singleton_ck', sql`${t.singleton}`),
    check('git_settings_host_ck', sql`${t.host} in ('github', 'gitlab')`),
    check('git_settings_github_auth_ck', sql`${t.githubAuth} in ('token', 'app')`),
  ],
)

export type GitSettings = typeof gitSettings.$inferSelect

export const GIT_OBJECT_KINDS = ['workflow', 'app', 'library_query', 'module', 'component_library'] as const
/** Kept in Git beside them (M22), without drafts or releases. */
export const GIT_SETTINGS_KINDS = ['resource', 'config_var'] as const
export const GIT_OBJECT_STATUSES = ['deployed', 'problem', 'missing'] as const

/** A problem with an object's files or definition, by path from the repo's root (`@ow/git-format`'s shape). */
export interface GitProblem {
  path: string
  code: string
  message: string
}

/**
 * Each workflow and app directory on the deploy branch, as the last deploy left it (M11): the tree it deployed (so
 * an unchanged directory is skipped), and its problems, or `missing` once the directory left the branch.
 */
export const gitObjects = pgTable(
  'git_objects',
  {
    id: id(),
    kind: text({ enum: [...GIT_OBJECT_KINDS, ...GIT_SETTINGS_KINDS] }).notNull(),
    /** A config var's name. */
    slug: text().notNull(),
    /** The object on the instance; null when none could be made. */
    objectId: uuid(),
    /** The directory's tree when it last deployed (or failed to). */
    treeSha: text(),
    /** The branch commit it was last seen at. */
    commit: text().notNull(),
    status: text({ enum: GIT_OBJECT_STATUSES }).notNull(),
    problems: jsonb().$type<GitProblem[]>().notNull().default([]),
    /** The version the last deploy made live, if it made one. */
    version: text(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('git_objects_kind_slug_uq').on(t.kind, t.slug),
    check(
      'git_objects_kind_ck',
      sql`${t.kind} in ('workflow', 'app', 'library_query', 'module', 'component_library', 'resource', 'config_var')`,
    ),
    check('git_objects_status_ck', sql`${t.status} in ('deployed', 'problem', 'missing')`),
  ],
)

/** `retry` (M22): the deployed commit again, for its problem objects. */
/** A deploy problem as `git.health` and the notify workflow see it (M22); `kind` and `slug` are null for the repo's. */
export interface GitHealthProblem {
  kind: string | null
  slug: string | null
  path: string
  message: string
}

export const GIT_DEPLOY_TRIGGERS = ['poll', 'webhook', 'manual', 'retry'] as const

/** What each deploy of a new branch commit (or an admin's Deploy now) did. */
export const gitDeploys = pgTable(
  'git_deploys',
  {
    id: id(),
    commit: text().notNull(),
    previousCommit: text(),
    trigger: text({ enum: GIT_DEPLOY_TRIGGERS }).notNull(),
    /** `ok`: every object deployed or was unchanged; `problems`: some didn't (see `summary`). */
    status: text({ enum: ['ok', 'problems'] }).notNull(),
    /** The commit's subject, author and per-object outcomes; repo-wide problems. */
    summary: jsonb().$type<Record<string, unknown>>().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    finishedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index('git_deploys_started_idx').on(t.startedAt)],
)

export type GitObject = typeof gitObjects.$inferSelect
export type GitDeploy = typeof gitDeploys.$inferSelect

/**
 * A protected workflow's or app's draft on a Git branch (M11): edited and run like the main draft, committed onto
 * the branch. One per object and branch.
 */
export const gitBranchDrafts = pgTable(
  'git_branch_drafts',
  {
    id: id(),
    workflowId: uuid().references(() => workflows.id, { onDelete: 'cascade' }),
    appId: uuid().references(() => apps.id, { onDelete: 'cascade' }),
    libraryQueryId: uuid().references(() => libraryQueries.id, { onDelete: 'cascade' }),
    moduleId: uuid().references(() => modules.id, { onDelete: 'cascade' }),
    componentLibraryId: uuid().references(() => componentLibraries.id, { onDelete: 'cascade' }),
    branch: text().notNull(),
    /** A workflow, app, library query or module definition, as the object's kind says. */
    definition: jsonb()
      .$type<WorkflowDefinition | AppDefinition | LibraryQueryDefinition | ComponentLibraryDefinition>()
      .notNull(),
    name: text().notNull(),
    description: text(),
    /** The folder path the repo keeps for the object, `Finance/Reports` (M22); null at the top level. */
    folder: text(),
    /** Bumped on every save (optimistic concurrency, and draft snapshots for runs). */
    revision: integer().notNull().default(1),
    /** The commit the draft's files came from (or that it last committed): what a commit goes on top of. */
    baseCommit: text().notNull(),
    /** False until the first commit makes the branch (it starts from the deploy branch). */
    branchExists: boolean().notNull(),
    /** The draft's last commit. */
    committedCommit: text(),
    /**
     * What the draft started from where its base commit had no files for the object (created protected, or its protect
     * pull request not merged when it was opened): the merge base (M20) until a commit or an update gives it files.
     */
    baseValue: jsonb().$type<{
      name: string
      description: string | null
      folder?: string | null
      definition: unknown
    }>(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('git_branch_drafts_workflow_uq')
      .on(t.workflowId, t.branch)
      .where(sql`${t.workflowId} is not null`),
    uniqueIndex('git_branch_drafts_app_uq').on(t.appId, t.branch).where(sql`${t.appId} is not null`),
    uniqueIndex('git_branch_drafts_library_query_uq')
      .on(t.libraryQueryId, t.branch)
      .where(sql`${t.libraryQueryId} is not null`),
    uniqueIndex('git_branch_drafts_module_uq').on(t.moduleId, t.branch).where(sql`${t.moduleId} is not null`),
    uniqueIndex('git_branch_drafts_component_library_uq')
      .on(t.componentLibraryId, t.branch)
      .where(sql`${t.componentLibraryId} is not null`),
    check(
      'git_branch_drafts_object_ck',
      sql`num_nonnulls(${t.workflowId}, ${t.appId}, ${t.libraryQueryId}, ${t.moduleId}, ${t.componentLibraryId}) = 1`,
    ),
  ],
)

export type GitBranchDraft = typeof gitBranchDrafts.$inferSelect

// ── Multiplayer editing (M16) ───────────────────────────────────────────────

/**
 * A draft open for editing together: its Yjs document (architecture §2.19). The key names what it edits:
 * `workflow:<id>`, `app:<id>`, `module:<id>` or `branch:<git branch draft id>`, and the row goes with that object.
 */
export const collabDocuments = pgTable(
  'collab_documents',
  {
    key: text().primaryKey(),
    workflowId: uuid().references(() => workflows.id, { onDelete: 'cascade' }),
    appId: uuid().references(() => apps.id, { onDelete: 'cascade' }),
    moduleId: uuid().references(() => modules.id, { onDelete: 'cascade' }),
    /** A library query's main draft (M21: the library query editor is multiplayer too). */
    libraryQueryId: uuid().references(() => libraryQueries.id, { onDelete: 'cascade' }),
    /** A component library's main draft (M25). */
    componentLibraryId: uuid().references(() => componentLibraries.id, { onDelete: 'cascade' }),
    branchDraftId: uuid().references(() => gitBranchDrafts.id, { onDelete: 'cascade' }),
    /** The document as one Yjs update, with `collab_updates` folded in so far. */
    state: bytea().notNull(),
    /** The draft revision the document last matched (it was made from it, or written to it). */
    revision: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'collab_documents_object_ck',
      sql`num_nonnulls(${t.workflowId}, ${t.appId}, ${t.moduleId}, ${t.libraryQueryId}, ${t.componentLibraryId}, ${t.branchDraftId}) = 1`,
    ),
  ],
)

/** Yjs updates to a document since its state was last compacted; applied in any order, any number of times. */
export const collabUpdates = pgTable(
  'collab_updates',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    documentKey: text()
      .notNull()
      .references(() => collabDocuments.key, { onDelete: 'cascade' }),
    update: bytea().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('collab_updates_document_idx').on(t.documentKey, t.id)],
)

export type CollabDocument = typeof collabDocuments.$inferSelect

/**
 * Python package sets the builder resolved (M23, docs/architecture.md §2.26): a workflow draft's requirements → their
 * lock and env. Draft runs reuse the lock while the requirements stay the same; releases keep theirs in
 * `workflow_releases.python_lock`.
 */
/**
 * Package indexes an admin defines (M32, docs/architecture.md §2.35), picked by a workflow's
 * `settings.python.index` (its slug). Not in Git: the instance's own settings, like Git's.
 */
export const pythonIndexes = pgTable(
  'python_indexes',
  {
    id: id(),
    /** What workflows name it by (`settings.python.index`, the lock's packages). */
    slug: text().notNull(),
    name: text().notNull(),
    /** The simple index's URL (PEP 503), without credentials. */
    url: text().notNull(),
    username: text(),
    /** A secret config var's name holding the password, read in the default environment when a build needs it. */
    passwordConfigVar: text(),
    /** `primary` replaces the builder's default index; `extra` is searched with it. */
    mode: text().$type<'primary' | 'extra'>().notNull(),
    /**
     * A package Test asks for instead of the root page (session 57): some indexes, Google's Artifact Registry among
     * them, list nothing at their root and answer 404 there. Only Test reads it.
     */
    testPackage: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('python_indexes_slug_uq').on(t.slug),
    check('python_indexes_mode_ck', sql`${t.mode} in ('primary', 'extra')`),
  ],
)

export type PythonIndex = typeof pythonIndexes.$inferSelect

export const pythonEnvs = pgTable('python_envs', {
  /**
   * `requirementsHash`: the requirements' SHA-256, sorted; with a package index (M32), of the requirements and
   * the index's id.
   */
  requirementsHash: text().primaryKey(),
  requirements: jsonb().$type<string[]>().notNull(),
  /** The package index the requirements resolve from (M32); null for the builder's default. */
  indexId: uuid().references(() => pythonIndexes.id, { onDelete: 'cascade' }),
  /** `ready` (the lock and env below) or `failed` (the error and log; the next run tries again). */
  state: text().$type<'ready' | 'failed'>().notNull(),
  lock: jsonb().$type<PythonLock>(),
  envId: text(),
  sizeBytes: bigint({ mode: 'number' }),
  error: jsonb().$type<{ kind: string; message: string }>(),
  /** pip's output from the last build (cut to 64 kB by the builder). */
  log: text(),
  builtAt: timestamp({ withTimezone: true }),
  lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
})

export type PythonEnv = typeof pythonEnvs.$inferSelect

/**
 * Bundles of JavaScript packages for workflows' and apps' code: their npm dependencies installed (no install scripts)
 * and bundled by esbuild into one script setting `globalThis.__owModules`, which the sandboxes load before the code.
 * Kept by what went in (`inputHash`: the dependencies, the registries they resolve from, and the lock a release
 * builds from, if any), found by what came out (`bundleHash`, what a release names). A failure is kept too (the
 * editor shows it); the next build tries again.
 */
export const jsBundles = pgTable(
  'js_bundles',
  {
    inputHash: text().primaryKey(),
    /** npm's `dependencies`: name → range (`*` for any). */
    dependencies: jsonb().$type<Record<string, string>>().notNull(),
    /** `ready` (the bundle below) or `failed` (the error and log). */
    state: text().$type<'ready' | 'failed'>().notNull(),
    /** SHA-256 of `js`. */
    bundleHash: text(),
    js: text(),
    /** `package-lock.json` as the install ended with it. */
    lock: text(),
    /** The installed version of each dependency, for the editor. */
    versions: jsonb().$type<Record<string, string>>(),
    sizeBytes: integer(),
    /** Node built-ins some package reaches for: they throw when used. */
    warnings: jsonb().$type<string[]>(),
    error: jsonb().$type<{ kind: string; message: string }>(),
    /** npm's output from the last install (its end). */
    log: text(),
    builtAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('js_bundles_bundle_hash_ix').on(t.bundleHash),
    check('js_bundles_state_ck', sql`${t.state} in ('ready', 'failed')`),
  ],
)

export type JsBundle = typeof jsBundles.$inferSelect
