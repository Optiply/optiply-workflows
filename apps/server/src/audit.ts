import { redact } from '@ow/crypto'
import { auditEvents, type Db } from '@ow/db'

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
