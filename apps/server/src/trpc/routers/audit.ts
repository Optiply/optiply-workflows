import { auditEvents, users } from '@ow/db'
import { asc, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { auditFilterSchema, auditPage } from '../../services/audit-log'
import { adminProcedure, router } from '../init'

export const auditRouter = router({
  list: adminProcedure
    .input(
      auditFilterSchema.extend({
        limit: z.number().int().min(1).max(200).default(50),
        /** Id of the last event of the previous page. */
        cursor: z.number().int().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, ...filter } = input
      const rows = await auditPage(ctx.db, filter, limit + 1, cursor)
      const hasMore = rows.length > limit
      const items = (hasMore ? rows.slice(0, limit) : rows).map(({ userAgent: _, ...row }) => row)
      return { items, nextCursor: hasMore ? items.at(-1)!.id : undefined }
    }),

  /** What the filters can choose from: the actions, object types and people that appear in the log. */
  facets: adminProcedure.query(async ({ ctx }) => {
    const [actions, objectTypes, actors] = await Promise.all([
      ctx.db.selectDistinct({ value: auditEvents.action }).from(auditEvents).orderBy(asc(auditEvents.action)),
      ctx.db
        .selectDistinct({ value: auditEvents.objectType })
        .from(auditEvents)
        .where(isNotNull(auditEvents.objectType))
        .orderBy(asc(auditEvents.objectType)),
      ctx.db
        .selectDistinct({ id: users.id, email: users.email, name: users.name })
        .from(auditEvents)
        .innerJoin(users, eq(users.id, auditEvents.actorUserId))
        .orderBy(asc(users.email)),
    ])
    return {
      actions: actions.map((a) => a.value),
      objectTypes: objectTypes.map((o) => o.value!),
      actors,
    }
  }),
})
