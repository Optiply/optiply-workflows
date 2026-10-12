import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  index,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
export type AuditEvent = typeof auditEvents.$inferSelect
