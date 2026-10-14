import {
  type Db,
  environments,
  groupMembers,
  groups,
  users,
  userTasks,
  workflowRuns,
  workflows,
} from '@ow/db'
import { asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { type Access, atLeast } from './permissions'

/** The groups a user is in. */
export async function groupIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId))
  return rows.map((r) => r.groupId)
}

/** Tasks assigned to the user, directly or through one of their groups. */
export function assignedTo(userId: string, groupIds: string[]): SQL {
  return groupIds.length
    ? sql`(${userId} = any(${userTasks.assigneeUserIds}) or ${userTasks.assigneeGroupIds} && ${`{${groupIds.join(',')}}`}::uuid[])`
    : sql`${userId} = any(${userTasks.assigneeUserIds})`
}

const FINAL_RUN = new Set(['succeeded', 'failed', 'cancelled'])

export type TaskRow = Awaited<ReturnType<typeof loadTasks>>[number]

/** Tasks with what the inbox shows: workflow, environment, run status and who completed them. */
export async function loadTasks(db: Db, where: SQL | undefined, order: 'open' | 'closed', limit: number) {
  return db
    .select({
      task: userTasks,
      workflow: {
        id: workflows.id,
        slug: workflows.slug,
        name: workflows.name,
        folderId: workflows.folderId,
      },
      environment: environments.slug,
      runStatus: workflowRuns.status,
      completedBy: { id: users.id, email: users.email, name: users.name },
    })
    .from(userTasks)
    .innerJoin(workflows, eq(workflows.id, userTasks.workflowId))
    .innerJoin(environments, eq(environments.id, userTasks.environmentId))
    .innerJoin(workflowRuns, eq(workflowRuns.id, userTasks.runId))
    .leftJoin(users, eq(users.id, userTasks.completedBy))
    .where(where)
    .orderBy(
      ...(order === 'open'
        ? [sql`${userTasks.dueAt} asc nulls last`, asc(userTasks.createdAt)]
        : [desc(userTasks.updatedAt)]),
    )
    .limit(limit)
}

/** Names for the assignee ids of these tasks. */
export async function assigneeNames(db: Db, rows: readonly TaskRow[]) {
  const userIds = [...new Set(rows.flatMap((r) => r.task.assigneeUserIds))]
  const groupIds = [...new Set(rows.flatMap((r) => r.task.assigneeGroupIds))]
  const [userRows, groupRows] = await Promise.all([
    userIds.length
      ? db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      : [],
    groupIds.length
      ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds))
      : [],
  ])
  return {
    users: new Map(userRows.map((u) => [u.id, u])),
    groups: new Map(groupRows.map((g) => [g.id, g.name])),
  }
}

/**
 * What the caller may do with a task: assignees (directly or through a group) and admins may see and complete it;
 * people with access to its workflow may see it. Completing also needs the task open and its run still going.
 */
export function taskAccess(
  row: TaskRow,
  user: { id: string },
  groupIds: readonly string[],
  access: Access,
): { see: boolean; complete: boolean } {
  const assigned =
    access.isAdmin ||
    row.task.assigneeUserIds.includes(user.id) ||
    row.task.assigneeGroupIds.some((g) => groupIds.includes(g))
  const see = assigned || atLeast(access.workflowLevel(row.workflow), 'use')
  return { see, complete: assigned && row.task.status === 'open' && !FINAL_RUN.has(row.runStatus) }
}

/** A task as the API returns it. Fields, outcomes and the description only in detail views. */
export function taskView(
  row: TaskRow,
  names: Awaited<ReturnType<typeof assigneeNames>>,
  can: { complete: boolean },
  detail = false,
) {
  const { task } = row
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    runId: task.runId,
    blockKey: task.blockKey,
    runStatus: row.runStatus,
    workflow: { id: row.workflow.id, slug: row.workflow.slug, name: row.workflow.name },
    environment: row.environment,
    assignees: {
      users: task.assigneeUserIds.flatMap((id) => {
        const u = names.users.get(id)
        return u ? [{ email: u.email, name: u.name }] : []
      }),
      groups: task.assigneeGroupIds.flatMap((id) => names.groups.get(id) ?? []),
    },
    dueAt: task.dueAt,
    createdAt: task.createdAt,
    outcome: task.outcome,
    completedBy: row.completedBy?.id ? { email: row.completedBy.email, name: row.completedBy.name } : null,
    completedAt: task.completedAt,
    canComplete: can.complete,
    ...(detail && {
      description: task.description,
      fields: task.fields,
      outcomes: task.outcomes,
      values: task.values,
    }),
  }
}
