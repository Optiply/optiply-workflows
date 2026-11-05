import {
  type AppDefinition,
  isEmptySummary,
  mergeChangeSummaries,
  summarizeAppChange,
} from '@ow/app-definition'
import { appDraftVersions, type Db } from '@ow/db'
import { and, desc, eq, lt, notInArray, or } from 'drizzle-orm'
import type { Tx } from './refresh-lock'

/*
 * An app's draft history (session 41, the editor's History panel, after Retool's save log): every save of the main
 * draft is recorded; a save by the same person within `MERGE_WINDOW_MS` of their last entry updates it, so a burst of
 * edits (collaborative saves come every few hundred milliseconds) is one entry. The newest `KEPT` per app are kept.
 */

/** Saves by one person this close together make one entry. */
export const MERGE_WINDOW_MS = 2 * 60_000
/** Entries kept per app. */
export const KEPT = 200

/**
 * Records a save of an app's main draft (in the transaction that wrote it, so the entry and the draft agree). A save
 * changing nothing isn't recorded; a restore always starts its own entry.
 */
export async function recordAppVersion(
  tx: Tx | Db,
  opts: {
    appId: string
    definition: AppDefinition
    revision: number
    userId: string | null
    restoredFrom?: string
    now?: Date
  },
): Promise<void> {
  const now = opts.now ?? new Date()
  const [last] = await tx
    .select()
    .from(appDraftVersions)
    .where(eq(appDraftVersions.appId, opts.appId))
    .orderBy(desc(appDraftVersions.updatedAt), desc(appDraftVersions.id))
    .limit(1)
  const change = summarizeAppChange(last?.definition ?? null, opts.definition)
  if (last && isEmptySummary(change) && !opts.restoredFrom) return
  const mergeable =
    last &&
    !opts.restoredFrom &&
    !last.restoredFrom &&
    last.createdBy === opts.userId &&
    now.getTime() - last.updatedAt.getTime() < MERGE_WINDOW_MS
  if (mergeable) {
    await tx
      .update(appDraftVersions)
      .set({
        definition: opts.definition,
        revision: opts.revision,
        summary: mergeChangeSummaries(last.summary, change),
        updatedAt: now,
      })
      .where(eq(appDraftVersions.id, last.id))
    return
  }
  await tx.insert(appDraftVersions).values({
    appId: opts.appId,
    definition: opts.definition,
    revision: opts.revision,
    summary: change,
    restoredFrom: opts.restoredFrom ?? null,
    createdBy: opts.userId,
    createdAt: now,
    updatedAt: now,
  })
  // The oldest beyond what's kept go.
  const kept = tx
    .select({ id: appDraftVersions.id })
    .from(appDraftVersions)
    .where(eq(appDraftVersions.appId, opts.appId))
    .orderBy(desc(appDraftVersions.updatedAt), desc(appDraftVersions.id))
    .limit(KEPT)
  await tx
    .delete(appDraftVersions)
    .where(and(eq(appDraftVersions.appId, opts.appId), notInArray(appDraftVersions.id, kept)))
}

/** A page of an app's history, newest first, without definitions; `before` continues from an entry's cursor. */
export async function listAppVersions(
  db: Db,
  appId: string,
  opts: { before?: { updatedAt: Date; id: string }; limit?: number } = {},
) {
  const limit = opts.limit ?? 30
  const rows = await db
    .select({
      id: appDraftVersions.id,
      revision: appDraftVersions.revision,
      summary: appDraftVersions.summary,
      restoredFrom: appDraftVersions.restoredFrom,
      createdBy: appDraftVersions.createdBy,
      createdAt: appDraftVersions.createdAt,
      updatedAt: appDraftVersions.updatedAt,
    })
    .from(appDraftVersions)
    .where(
      and(
        eq(appDraftVersions.appId, appId),
        opts.before
          ? or(
              lt(appDraftVersions.updatedAt, opts.before.updatedAt),
              and(
                eq(appDraftVersions.updatedAt, opts.before.updatedAt),
                lt(appDraftVersions.id, opts.before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(appDraftVersions.updatedAt), desc(appDraftVersions.id))
    .limit(limit + 1)
  return { versions: rows.slice(0, limit), more: rows.length > limit }
}

/** One version of an app's draft, or undefined. */
export async function getAppVersion(db: Db | Tx, appId: string, id: string) {
  const [row] = await db
    .select()
    .from(appDraftVersions)
    .where(and(eq(appDraftVersions.appId, appId), eq(appDraftVersions.id, id)))
  return row
}
