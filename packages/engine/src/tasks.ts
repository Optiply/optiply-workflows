import { type Db, groups, users, userTasks } from '@ow/db'
import { checkTaskSubmission } from '@ow/definition'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { BlockFailure } from './errors'
import { RUNS_QUEUED_CHANNEL } from './queue'
import type { TaskState, UserTasks } from './types'

/**
 * User Tasks in Postgres. A task belongs to a run and a block (one each, so a block that runs again finds its task),
 * and names its assignees by user and group id, resolved from emails and group names when it opens.
 */
export class PgUserTasks implements UserTasks {
  constructor(private readonly db: Db) {}

  async open(request: Parameters<UserTasks['open']>[0]): Promise<TaskState> {
    const emails = unique(request.assignees.users.map((e) => e.trim().toLowerCase()))
    const groupNames = unique(request.assignees.groups.map((g) => g.trim()))
    const foundUsers = emails.length
      ? await this.db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, emails))
      : []
    const foundGroups = groupNames.length
      ? await this.db
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(inArray(groups.name, groupNames))
      : []
    const missingUsers = emails.filter((e) => !foundUsers.some((u) => u.email.toLowerCase() === e))
    const missingGroups = groupNames.filter((g) => !foundGroups.some((x) => x.name === g))
    if (missingUsers.length || missingGroups.length) {
      throw new BlockFailure(
        'unknown_assignee',
        [
          missingUsers.length && `No user has the email ${missingUsers.join(', ')}`,
          missingGroups.length && `No group is named ${missingGroups.join(', ')}`,
        ]
          .filter(Boolean)
          .join('; '),
      )
    }
    if (!foundUsers.length && !foundGroups.length) {
      throw new BlockFailure('no_assignee', 'The task has nobody to do it: its assignees came out empty')
    }

    const inserted = await this.db
      .insert(userTasks)
      .values({
        runId: request.runId,
        blockKey: request.blockKey,
        workflowId: request.workflowId,
        environmentId: request.environmentId,
        title: request.title,
        description: request.description,
        fields: request.fields,
        outcomes: request.outcomes,
        assigneeUserIds: foundUsers.map((u) => u.id),
        assigneeGroupIds: foundGroups.map((g) => g.id),
        dueAt: request.dueAt,
      })
      .onConflictDoNothing({ target: [userTasks.runId, userTasks.blockKey] })
      .returning({ id: userTasks.id })
    const id =
      inserted[0]?.id ??
      (
        await this.db
          .select({ id: userTasks.id })
          .from(userTasks)
          .where(and(eq(userTasks.runId, request.runId), eq(userTasks.blockKey, request.blockKey)))
      )[0]!.id
    return (await this.get(id))!
  }

  async get(taskId: string): Promise<TaskState | null> {
    const [row] = await this.db
      .select({ task: userTasks, user: { id: users.id, email: users.email, name: users.name } })
      .from(userTasks)
      .leftJoin(users, eq(users.id, userTasks.completedBy))
      .where(eq(userTasks.id, taskId))
    if (!row) return null
    const { task, user } = row
    return {
      id: task.id,
      status: task.status,
      dueAt: task.dueAt,
      outcome: task.outcome,
      values: task.values,
      completedBy: user,
      completedAt: task.completedAt,
    }
  }

  async expire(taskId: string): Promise<TaskState | null> {
    await this.db
      .update(userTasks)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(userTasks.id, taskId), eq(userTasks.status, 'open')))
    return this.get(taskId)
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export type CompleteTaskResult =
  | { ok: true; runId: string }
  | {
      ok: false
      reason: 'not_found' | 'not_open' | 'invalid'
      errors?: { field?: string; message: string }[]
    }

/**
 * Completes an open task with an outcome and the submitted values (checked against its fields), and wakes its run.
 * Who may complete it is the caller's business (the server checks assignees).
 *
 * The run row is locked first, so this and the run pausing (`suspendRun`) happen one after the other: either the
 * run is already `waiting` here and is woken, or it pauses afterwards and `suspendRun` sees the task done.
 */
export async function completeTask(
  db: Db,
  request: { taskId: string; userId: string; outcome: string; values: Record<string, unknown> },
): Promise<CompleteTaskResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({
        runId: userTasks.runId,
        status: userTasks.status,
        fields: userTasks.fields,
        outcomes: userTasks.outcomes,
      })
      .from(userTasks)
      .where(eq(userTasks.id, request.taskId))
    if (!task) return { ok: false, reason: 'not_found' }
    await tx.execute(sql`select 1 from workflow_runs where id = ${task.runId} for update`)

    const submission = checkTaskSubmission(task.fields, task.outcomes, request.outcome, request.values)
    if (!submission.ok) return { ok: false, reason: 'invalid', errors: submission.errors }
    const done = await tx
      .update(userTasks)
      .set({
        status: 'completed',
        outcome: submission.outcome,
        values: submission.values,
        completedBy: request.userId,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(userTasks.id, request.taskId), eq(userTasks.status, 'open')))
      .returning({ id: userTasks.id })
    if (!done.length) return { ok: false, reason: 'not_open' }

    const woken = await tx.execute(sql`
      update workflow_runs set available_at = now(), updated_at = now()
      where id = ${task.runId} and status = 'waiting' and available_at > now()
      returning id`)
    if (woken.length) await tx.execute(sql`select pg_notify(${RUNS_QUEUED_CHANNEL}, '')`)
    return { ok: true, runId: task.runId }
  })
}
