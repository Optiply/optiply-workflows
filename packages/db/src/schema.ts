import type { AppDefinition, LibraryQueryDefinition } from '@ow/app-definition'
import type { OpenTaskField, TaskOutcome, WorkflowDefinition } from '@ow/definition'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), uniqueIndex('users_oidc_subject_uq').on(t.oidcSubject)],
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
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('environments_slug_uq').on(t.slug)],
)

// ── Organisation ────────────────────────────────────────────────────────────

export const FOLDER_OBJECT_TYPES = ['resource', 'workflow', 'app', 'library_query', 'module'] as const

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
      sql`${t.objectType} in ('resource', 'workflow', 'app', 'library_query', 'module')`,
    ),
  ],
)

export const PERMISSION_OBJECT_TYPES = [
  'resource',
  'workflow',
  'app',
  'library_query',
  'module',
  'folder',
] as const
/** Ordered lowest to highest: each level includes the ones before it. */
export const PERMISSION_LEVELS = ['use', 'edit', 'own'] as const

/**
 * Grants to groups; a user's effective level is the highest grant across their groups. Admins implicitly own
 * everything. `objectId` null = every object of that type; `environmentId` null = every environment (environments
 * only matter for resources). `objectId` is polymorphic, so services delete grants when they delete an object.
 */
export const permissions = pgTable(
  'permissions',
  {
    id: id(),
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    objectType: text({ enum: PERMISSION_OBJECT_TYPES }).notNull(),
    objectId: uuid(),
    environmentId: uuid().references(() => environments.id, { onDelete: 'cascade' }),
    level: text({ enum: PERMISSION_LEVELS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('permissions_grant_uq')
      .on(t.groupId, t.objectType, t.objectId, t.environmentId)
      .nullsNotDistinct(),
    index('permissions_object_idx').on(t.objectType, t.objectId),
    check(
      'permissions_object_type_ck',
      sql`${t.objectType} in ('resource', 'workflow', 'app', 'library_query', 'module', 'folder')`,
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
    systemKind: text({ enum: ['database'] }),
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

export const TRIGGER_KINDS = ['webhook', 'schedule', 'pubsub'] as const

/** A Pub/Sub trigger's runtime state, as its consumer reports it (`workflow_triggers.state`). */
export interface PubSubTriggerState {
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
    /** The schedule's or Pub/Sub trigger's name from the definition; `webhook` for the webhook. */
    name: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** The trigger's settings from the definition (cron or interval, timezone, overlap). */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Schedules and Pub/Sub triggers: the environment their runs start in. */
    environmentId: uuid().references(() => environments.id, { onDelete: 'cascade' }),
    /**
     * An enabled webhook's alias with every param as `:` (`orders/:/refunds`). Unique, so two live webhooks can't
     * answer the same URLs.
     */
    aliasShape: text(),
    nextFireAt: timestamp({ withTimezone: true }),
    /** The fire time of the schedule's latest run; interval schedules keep to its grid. */
    lastFiredAt: timestamp({ withTimezone: true }),
    /** Pub/Sub triggers (M19): the worker pulling for it now, until its lease lapses (renewed while it pulls). */
    leaseOwner: text(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    /**
     * Pub/Sub triggers: what the worker pulling for it last reported (each lease tick), for the editor: messages in
     * flight, the last one, the last pull error and when it happened, when a pull last succeeded.
     */
    state: jsonb().$type<PubSubTriggerState>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workflow_triggers_name_uq').on(t.workflowId, t.kind, t.name),
    uniqueIndex('workflow_triggers_alias_uq').on(t.aliasShape).where(sql`${t.aliasShape} is not null`),
    index('workflow_triggers_due_idx').on(t.nextFireAt).where(sql`${t.kind} = 'schedule' and ${t.enabled}`),
    check('workflow_triggers_kind_ck', sql`${t.kind} in ('webhook', 'schedule', 'pubsub')`),
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
 * Pub/Sub messages a trigger has seen (M19, architecture §2.22): how many runs they started (each delivery is one,
 * idempotency key `pubsub:<trigger>:<message>:<n>`), the latest, and how it ended. A redelivery of a message whose run
 * succeeded is acked without a run; one whose run is still going is held, not run again. Retention prunes old ones.
 */
export const pubsubDeliveries = pgTable(
  'pubsub_deliveries',
  {
    triggerId: uuid()
      .notNull()
      .references(() => workflowTriggers.id, { onDelete: 'cascade' }),
    messageId: text().notNull(),
    runs: integer().notNull().default(0),
    lastRunId: uuid().references(() => workflowRuns.id, { onDelete: 'set null' }),
    /** Null while the latest run is under way; `released` when it was acked past `maxHoldMinutes`. */
    outcome: text({ enum: ['succeeded', 'failed', 'released'] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.triggerId, t.messageId] }),
    index('pubsub_deliveries_updated_idx').on(t.updatedAt),
    check('pubsub_deliveries_outcome_ck', sql`${t.outcome} in ('succeeded', 'failed', 'released')`),
  ],
)

// ── Runs ────────────────────────────────────────────────────────────────────

/** `queued` and `waiting` runs are claimable once `availableAt` passes; the last three are final. */
export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const
export const RUN_TRIGGER_TYPES = ['manual', 'webhook', 'schedule', 'workflow', 'pubsub'] as const
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
    uniqueIndex('workflow_runs_idempotency_uq')
      .on(t.workflowId, t.idempotencyKey)
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
      sql`${t.triggerType} in ('manual', 'webhook', 'schedule', 'workflow', 'pubsub')`,
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

export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024

/** A block's output data, kept apart so listing a run's blocks stays cheap. Capped at 10MB. */
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
  (t) => [check('block_run_payloads_size_ck', sql`${t.sizeBytes} between 0 and 10485760`)],
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
    /** Encrypted JSON `{ token?, webhookSecret? }` (`@ow/crypto` token). */
    secrets: text(),
    /** The branch commit the last deploy went through (null: never, or the repo or branch changed since). */
    deployedCommit: text(),
    /** When a deploy last checked the branch, and why it couldn't when it couldn't (cleared on success). */
    checkedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** A webhook or an admin asked for a deploy; the process holding the lease goes again when it's done. */
    deployRequestedAt: timestamp({ withTimezone: true }),
    deployRequestedBy: text({ enum: ['poll', 'webhook', 'manual'] }),
    /** One deploy at a time across processes: whoever moves this into the future runs it. */
    deployLeaseUntil: timestamp({ withTimezone: true }),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('git_settings_singleton_uq').on(t.singleton),
    check('git_settings_singleton_ck', sql`${t.singleton}`),
  ],
)

export type GitSettings = typeof gitSettings.$inferSelect

export const GIT_OBJECT_KINDS = ['workflow', 'app', 'library_query', 'module'] as const
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
      sql`${t.kind} in ('workflow', 'app', 'library_query', 'module', 'resource', 'config_var')`,
    ),
    check('git_objects_status_ck', sql`${t.status} in ('deployed', 'problem', 'missing')`),
  ],
)

export const GIT_DEPLOY_TRIGGERS = ['poll', 'webhook', 'manual'] as const

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
    branch: text().notNull(),
    /** A workflow, app, library query or module definition, as the object's kind says. */
    definition: jsonb().$type<WorkflowDefinition | AppDefinition | LibraryQueryDefinition>().notNull(),
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
      folder?: string
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
    check(
      'git_branch_drafts_object_ck',
      sql`num_nonnulls(${t.workflowId}, ${t.appId}, ${t.libraryQueryId}, ${t.moduleId}) = 1`,
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
      sql`num_nonnulls(${t.workflowId}, ${t.appId}, ${t.moduleId}, ${t.libraryQueryId}, ${t.branchDraftId}) = 1`,
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
