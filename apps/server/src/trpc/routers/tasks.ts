import { userTasks } from '@ow/db'
import { completeTask } from '@ow/engine'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { loadAccess } from '../../services/permissions'
import { assignedTo, assigneeNames, groupIdsOf, loadTasks, taskAccess, taskView } from '../../services/tasks'
import { invalidInput } from '../errors'
import { authedProcedure, router } from '../init'

const Id = z.uuid()

/** User Tasks: the inbox (tasks assigned to me, or every task for admins), one task, and completing it. */
export const tasksRouter = router({
  list: authedProcedure
    .input(
      z.object({
        status: z.enum(['open', 'closed']).default('open'),
        /** `all`: every task (admins); otherwise those assigned to me. */
        scope: z.enum(['mine', 'all']).default('mine'),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const groupIds = await groupIdsOf(ctx.db, ctx.user.id)
      const filters: SQL[] = [
        input.status === 'open'
          ? eq(userTasks.status, 'open')
          : inArray(userTasks.status, ['completed', 'expired', 'cancelled']),
      ]
      if (input.scope === 'mine' || !ctx.user.isAdmin) filters.push(assignedTo(ctx.user.id, groupIds))
      const rows = await loadTasks(ctx.db, and(...filters), input.status, input.limit)
      const [access, names] = await Promise.all([loadAccess(ctx.db, ctx.user), assigneeNames(ctx.db, rows)])
      return rows.map((row) => taskView(row, names, taskAccess(row, ctx.user, groupIds, access)))
    }),

  /** Open tasks assigned to me, for the sidebar's badge. */
  openCount: authedProcedure.query(async ({ ctx }) => {
    const groupIds = await groupIdsOf(ctx.db, ctx.user.id)
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(userTasks)
      .where(and(eq(userTasks.status, 'open'), assignedTo(ctx.user.id, groupIds)))
    return row?.n ?? 0
  }),

  get: authedProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
    const [row] = await loadTasks(ctx.db, eq(userTasks.id, input.id), 'open', 1)
    const groupIds = await groupIdsOf(ctx.db, ctx.user.id)
    const access = await loadAccess(ctx.db, ctx.user)
    const can = row && taskAccess(row, ctx.user, groupIds, access)
    // Tasks the caller can't see don't exist for them.
    if (!row || !can?.see) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
    return taskView(row, await assigneeNames(ctx.db, [row]), can, true)
  }),

  complete: authedProcedure
    .input(
      z.object({
        id: Id,
        outcome: z.string().min(1).max(64),
        values: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await loadTasks(ctx.db, eq(userTasks.id, input.id), 'open', 1)
      const groupIds = await groupIdsOf(ctx.db, ctx.user.id)
      const access = await loadAccess(ctx.db, ctx.user)
      const can = row && taskAccess(row, ctx.user, groupIds, access)
      if (!row || !can?.see) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      if (row.task.status !== 'open') {
        throw new TRPCError({ code: 'CONFLICT', message: `This task is already ${row.task.status}` })
      }
      if (!can.complete) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: ['succeeded', 'failed', 'cancelled'].includes(row.runStatus)
            ? 'Its run has already ended'
            : "This task isn't assigned to you",
        })
      }
      const result = await completeTask(ctx.db, {
        taskId: input.id,
        userId: ctx.user.id,
        outcome: input.outcome,
        values: input.values,
      })
      if (!result.ok) {
        if (result.reason === 'invalid') {
          throw invalidInput(
            'answer',
            (result.errors ?? []).map((e) => ({ path: e.field ? [e.field] : [], message: e.message })),
          )
        }
        throw new TRPCError({
          code: 'CONFLICT',
          message: result.reason === 'expired' ? 'This task has expired' : 'This task is no longer open',
        })
      }
      await ctx.audit({
        action: 'task.complete',
        objectType: 'workflow',
        objectId: row.workflow.id,
        metadata: {
          taskId: input.id,
          runId: row.task.runId,
          block: row.task.blockKey,
          outcome: input.outcome,
        },
      })
      const [after] = await loadTasks(ctx.db, eq(userTasks.id, input.id), 'open', 1)
      return taskView(after!, await assigneeNames(ctx.db, [after!]), { complete: false }, true)
    }),
})
