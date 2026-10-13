import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  index,
  inet,
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

export const FOLDER_OBJECT_TYPES = ['resource', 'workflow'] as const

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
    check('folders_object_type_ck', sql`${t.objectType} in ('resource', 'workflow')`),
  ],
)

export const PERMISSION_OBJECT_TYPES = ['resource', 'workflow', 'folder'] as const
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
    check('permissions_object_type_ck', sql`${t.objectType} in ('resource', 'workflow', 'folder')`),
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
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('resources_slug_uq').on(t.slug), index('resources_folder_idx').on(t.folderId)],
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

/** Org-wide values referenced as `{{ configVars.NAME }}`, set per environment. */
export const configVars = pgTable(
  'config_vars',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    /** Secret values are encrypted at rest and never returned to the browser. */
    isSecret: boolean().notNull().default(false),
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
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('config_var_values_env_uq').on(t.configVarId, t.environmentId),
    check('config_var_values_one_value_ck', sql`num_nonnulls(${t.value}, ${t.valueEncrypted}) = 1`),
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
export type ConfigVar = typeof configVars.$inferSelect
export type ConfigVarValue = typeof configVarValues.$inferSelect
export type AuditEvent = typeof auditEvents.$inferSelect
