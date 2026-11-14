import { jdbcDrivers, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { recordAudit } from '../../audit'
import { jdbcDriverUsers } from '../../services/jdbc-drivers'
import { adminProcedure, authedProcedure, router } from '../init'

/**
 * JDBC drivers (M38): admins upload them (`POST /api/v1/jdbc-drivers`) and delete them here; anyone who edits
 * resources sees the list, to pick one for a JDBC resource. The jar itself never comes back.
 */
export const jdbcDriversRouter = router({
  list: authedProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        id: jdbcDrivers.id,
        name: jdbcDrivers.name,
        className: jdbcDrivers.className,
        fileName: jdbcDrivers.fileName,
        sha256: jdbcDrivers.sha256,
        size: jdbcDrivers.size,
        createdAt: jdbcDrivers.createdAt,
        uploadedBy: users.email,
      })
      .from(jdbcDrivers)
      .leftJoin(users, eq(users.id, jdbcDrivers.uploadedBy))
      .orderBy(asc(jdbcDrivers.name)),
  ),

  /** Refused while a resource uses it: its queries would stop working. */
  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const usedBy = await jdbcDriverUsers(ctx.db, input.id)
    if (usedBy.length) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `In use by ${usedBy.map((r) => r.name).join(', ')}: choose another driver there first`,
      })
    }
    const [gone] = await ctx.db
      .delete(jdbcDrivers)
      .where(eq(jdbcDrivers.id, input.id))
      .returning({ name: jdbcDrivers.name, sha256: jdbcDrivers.sha256 })
    if (!gone) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such driver' })
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: 'jdbc_driver.deleted',
      objectType: 'jdbc_driver',
      objectId: input.id,
      metadata: gone,
    })
    return { ok: true as const }
  }),
})
