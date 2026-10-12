import { auditEvents, users } from '@ow/db'
import { and, desc, eq, lt, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { adminProcedure, router } from '../init'

export const auditRouter = router({
  list: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        /** Id of the last event of the previous page. */
        cursor: z.number().int().optional(),
        action: z.string().optional(),
        objectType: z.string().optional(),
        objectId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters: SQL[] = []
      if (input.cursor) filters.push(lt(auditEvents.id, input.cursor))
      if (input.action) filters.push(eq(auditEvents.action, input.action))
      if (input.objectType) filters.push(eq(auditEvents.objectType, input.objectType))
      if (input.objectId) filters.push(eq(auditEvents.objectId, input.objectId))

      const rows = await ctx.db
        .select({
          id: auditEvents.id,
          at: auditEvents.at,
          action: auditEvents.action,
          objectType: auditEvents.objectType,
          objectId: auditEvents.objectId,
          metadata: auditEvents.metadata,
          ip: auditEvents.ip,
          actor: { id: users.id, email: users.email, name: users.name },
        })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditEvents.id))
        .limit(input.limit + 1)

      const hasMore = rows.length > input.limit
      const items = hasMore ? rows.slice(0, input.limit) : rows
      return { items, nextCursor: hasMore ? items.at(-1)!.id : undefined }
    }),
})
