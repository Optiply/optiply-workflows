import { auditEvents, type Db, environments, users } from '@ow/db'
import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm'
import { z } from 'zod'

/** What the audit log can be filtered by, in the list and the CSV export. */
export const auditFilterSchema = z.object({
  action: z.string().max(100).optional(),
  objectType: z.string().max(100).optional(),
  objectId: z.string().max(200).optional(),
  actorUserId: z.uuid().optional(),
  /** ISO dates or date-times; `until` is exclusive. */
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
})
export type AuditFilter = z.output<typeof auditFilterSchema>

export function auditWhere(filter: AuditFilter, beforeId?: number): SQL | undefined {
  const conditions: SQL[] = []
  if (beforeId) conditions.push(lt(auditEvents.id, beforeId))
  if (filter.action) conditions.push(eq(auditEvents.action, filter.action))
  if (filter.objectType) conditions.push(eq(auditEvents.objectType, filter.objectType))
  if (filter.objectId) conditions.push(eq(auditEvents.objectId, filter.objectId))
  if (filter.actorUserId) conditions.push(eq(auditEvents.actorUserId, filter.actorUserId))
  if (filter.since) conditions.push(gte(auditEvents.at, filter.since))
  if (filter.until) conditions.push(lte(auditEvents.at, new Date(filter.until.getTime() - 1)))
  return conditions.length ? and(...conditions) : undefined
}

/** Newest first, `limit` at a time, before `beforeId` (the last id of the previous page). */
export function auditPage(db: Db, filter: AuditFilter, limit: number, beforeId?: number) {
  return db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      action: auditEvents.action,
      objectType: auditEvents.objectType,
      objectId: auditEvents.objectId,
      environment: environments.slug,
      metadata: auditEvents.metadata,
      ip: auditEvents.ip,
      userAgent: auditEvents.userAgent,
      actor: { id: users.id, email: users.email, name: users.name },
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .leftJoin(environments, eq(environments.id, auditEvents.environmentId))
    .where(auditWhere(filter, beforeId))
    .orderBy(desc(auditEvents.id))
    .limit(limit)
}

export const CSV_COLUMNS = [
  'id',
  'at',
  'actor_email',
  'actor_name',
  'action',
  'object_type',
  'object_id',
  'environment',
  'ip',
  'user_agent',
  'metadata',
] as const

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, quote or line break. A field a spreadsheet would read as a
 * formula (starting with =, +, -, @, tab or CR) gets a leading `'`, so opening the export can't run anything.
 */
export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvRow(row: Awaited<ReturnType<typeof auditPage>>[number]): string {
  return [
    row.id,
    row.at.toISOString(),
    row.actor?.email,
    row.actor?.name,
    row.action,
    row.objectType,
    row.objectId,
    row.environment,
    row.ip,
    row.userAgent,
    row.metadata ? JSON.stringify(row.metadata) : '',
  ]
    .map(csvField)
    .join(',')
}
