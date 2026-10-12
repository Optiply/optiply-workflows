import { auditEvents, type Db } from '@ow/db'

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|private[-_]?key/i

/** Recursively replaces values under secret-looking keys. Audit metadata must never contain credentials. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redact(v)]),
    )
  }
  return value
}

export interface AuditInput {
  actorUserId: string | null
  action: string
  objectType?: string
  objectId?: string
  environmentId?: string
  metadata?: Record<string, unknown>
  ip?: string
  userAgent?: string
}

export async function recordAudit(db: Db, input: AuditInput) {
  await db.insert(auditEvents).values({
    actorUserId: input.actorUserId,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    environmentId: input.environmentId,
    metadata: input.metadata ? (redact(input.metadata) as Record<string, unknown>) : undefined,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 500),
  })
}
