import type { AppDefinition } from '@ow/app-definition'
import { equal, SharedDefinition } from '@ow/collab'
import {
  apps,
  collabDocuments,
  collabUpdates,
  componentLibraries,
  type Db,
  gitBranchDrafts,
  libraryQueries,
  modules,
  workflows,
} from '@ow/db'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { recordAppVersion } from '../app-history'
import type { CollabOwner, CollabTarget } from './target'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Where the API processes tell each other about documents, as JSON: a draft written (`{d: key, r: revision}`, by the
 * triggers of migration 0022), an update stored (`{d, u: update id, p: process}`) or presence changed
 * (`{d, a: base64 awareness update, p}`).
 */
export const COLLAB_CHANNEL = 'ow_collab'

/** Presence larger than this isn't relayed: NOTIFY payloads stop at 8000 bytes. */
const MAX_NOTIFY_BYTES = 7000

/** What `write` did: wrote the draft, found it already equal, or found a newer draft to fold in first. */
export type WriteResult = { revision: number; written: boolean } | { fold: true }

/**
 * The documents of drafts being edited together, in Postgres (architecture §2.19): each document's compacted state
 * in `collab_documents`, and the updates since in `collab_updates`. Yjs updates commute and apply idempotently, so
 * loading is the state plus whatever updates are there, in any order; compacting folds in exactly the updates it read
 * (never "up to an id": a bigserial commits out of order).
 *
 * A document's `revision` is the draft revision it last matched. Writing the document to its draft bumps both; a
 * draft written by anything else (a REST save, a release restored, a Git pull) has a higher revision, and is folded
 * into the document as an edit. Everything touching a document holds its advisory lock, and the draft's row, so a
 * fold happens once whichever process sees it first.
 */
export class CollabStore {
  constructor(private db: Db) {}

  /**
   * The document as updates to apply, oldest first, its revision, and the draft (the document may be ahead of it: edits
   * stored whose write failed, or a process gone before writing). A draft opened for the first time gets a document
   * made from it; a draft written since the document last matched it is folded in, and the other processes told.
   */
  async load(
    target: CollabTarget,
    source: string,
  ): Promise<{ updates: Uint8Array[]; revision: number; draft: unknown }> {
    return this.db.transaction(async (tx) => {
      await lock(tx, target.key)
      const draft = await lockedDraft(tx, target.owner)
      let [document] = await tx
        .select({ state: collabDocuments.state, revision: collabDocuments.revision })
        .from(collabDocuments)
        .where(eq(collabDocuments.key, target.key))
      if (!document) {
        const doc = new Y.Doc()
        new SharedDefinition(doc, target.spec).set(draft.definition)
        const state = Y.encodeStateAsUpdate(doc)
        doc.destroy()
        await tx
          .insert(collabDocuments)
          .values({ key: target.key, ...target.owner, state, revision: draft.revision })
        document = { state, revision: draft.revision }
      }
      const updates = [
        document.state,
        ...(
          await tx
            .select({ update: collabUpdates.update })
            .from(collabUpdates)
            .where(eq(collabUpdates.documentKey, target.key))
            .orderBy(asc(collabUpdates.id))
        ).map((u) => u.update),
      ]
      if (draft.revision <= document.revision)
        return { updates, revision: document.revision, draft: draft.definition }
      const doc = new Y.Doc()
      for (const u of updates) Y.applyUpdate(doc, u)
      const folded = foldUpdate(doc, target, draft.definition)
      doc.destroy()
      if (folded) {
        // Rooms open elsewhere fold nothing once the revision moved: they get the update instead.
        const [row] = await tx
          .insert(collabUpdates)
          .values({ documentKey: target.key, update: folded })
          .returning({ id: collabUpdates.id })
        await notify(tx, { d: target.key, u: row!.id, p: source })
      }
      await setRevision(tx, target.key, draft.revision)
      return {
        updates: folded ? [...updates, folded] : updates,
        revision: draft.revision,
        draft: draft.definition,
      }
    })
  }

  /** Stores one update to the document and tells the other processes (`source` is this one), once it's committed. */
  async append(key: string, update: Uint8Array, source: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(collabUpdates)
        .values({ documentKey: key, update })
        .returning({ id: collabUpdates.id })
      await notify(tx, { d: key, u: row!.id, p: source })
    })
  }

  /** One stored update; null once compacted into the document's state. */
  async fetch(id: number): Promise<Uint8Array | null> {
    const [row] = await this.db
      .select({ update: collabUpdates.update })
      .from(collabUpdates)
      .where(eq(collabUpdates.id, id))
    return row?.update ?? null
  }

  /**
   * The document as stored: its state and the updates since, read under its lock (a compaction between reading the
   * state and the updates would leave out the updates it folded in).
   */
  async read(key: string): Promise<Uint8Array[]> {
    return this.db.transaction(async (tx) => {
      await lock(tx, key)
      const [document] = await tx
        .select({ state: collabDocuments.state })
        .from(collabDocuments)
        .where(eq(collabDocuments.key, key))
      if (!document) return []
      const updates = await tx
        .select({ update: collabUpdates.update })
        .from(collabUpdates)
        .where(eq(collabUpdates.documentKey, key))
      return [document.state, ...updates.map((u) => u.update)]
    })
  }

  /** Asks the other processes with the document open to announce who is there (a room just opened here). */
  async askPresence(key: string, source: string): Promise<void> {
    await this.db.execute(
      sql`select pg_notify(${COLLAB_CHANNEL}, ${JSON.stringify({ d: key, q: 1, p: source })})`,
    )
  }

  /** Tells the other processes about a change of presence here. Too large to relay: false. */
  async announcePresence(key: string, update: Uint8Array, source: string): Promise<boolean> {
    const payload = JSON.stringify({ d: key, a: Buffer.from(update).toString('base64'), p: source })
    if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) return false
    await this.db.execute(sql`select pg_notify(${COLLAB_CHANNEL}, ${payload})`)
    return true
  }

  /**
   * Writes the document's definition (schema-checked by the caller) to its draft, with the draft's revision + 1,
   * unless the draft already equals it; `fold` when the draft has moved past the document (fold it in first).
   */
  async write(target: CollabTarget, definition: unknown, userId: string | null): Promise<WriteResult> {
    return this.db.transaction(async (tx) => {
      await lock(tx, target.key)
      const draft = await lockedDraft(tx, target.owner)
      const [document] = await tx
        .select({ revision: collabDocuments.revision })
        .from(collabDocuments)
        .where(eq(collabDocuments.key, target.key))
      if (!document) throw new Error(`No collab document ${target.key}`)
      if (draft.revision !== document.revision) return { fold: true }
      if (equal(draft.definition, definition)) return { revision: draft.revision, written: false }
      const revision = draft.revision + 1
      await writeDraft(tx, target.owner, definition, revision, userId)
      await setRevision(tx, target.key, revision)
      return { revision, written: true }
    })
  }

  /**
   * Folds a draft written since the document last matched it into the open document: `apply` makes the document
   * equal to it (returning the update, null if nothing changed), which is stored with the draft's revision. The
   * document's revision either way (nothing to fold: another process folded, or wrote, or the draft didn't move); null
   * when the document is gone.
   */
  async fold(
    target: CollabTarget,
    apply: (definition: unknown) => Uint8Array | null,
    source: string,
  ): Promise<{ revision: number } | null> {
    return this.db.transaction(async (tx) => {
      await lock(tx, target.key)
      const draft = await lockedDraft(tx, target.owner)
      const [document] = await tx
        .select({ revision: collabDocuments.revision })
        .from(collabDocuments)
        .where(eq(collabDocuments.key, target.key))
      if (!document) return null
      if (draft.revision <= document.revision) return { revision: document.revision }
      const update = apply(draft.definition)
      if (update) {
        const [row] = await tx
          .insert(collabUpdates)
          .values({ documentKey: target.key, update })
          .returning({ id: collabUpdates.id })
        await notify(tx, { d: target.key, u: row!.id, p: source })
      }
      await setRevision(tx, target.key, draft.revision)
      return { revision: draft.revision }
    })
  }

  /** Folds the document's updates into its state. Returns how many it folded. */
  async compact(key: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await lock(tx, key)
      const [document] = await tx
        .select({ state: collabDocuments.state })
        .from(collabDocuments)
        .where(eq(collabDocuments.key, key))
      if (!document) return 0
      const updates = await tx
        .select({ id: collabUpdates.id, update: collabUpdates.update })
        .from(collabUpdates)
        .where(eq(collabUpdates.documentKey, key))
      if (!updates.length) return 0
      const doc = new Y.Doc()
      Y.applyUpdate(doc, document.state)
      for (const u of updates) Y.applyUpdate(doc, u.update)
      const state = Y.encodeStateAsUpdate(doc)
      doc.destroy()
      await tx.update(collabDocuments).set({ state }).where(eq(collabDocuments.key, key))
      await tx.delete(collabUpdates).where(
        inArray(
          collabUpdates.id,
          updates.map((u) => u.id),
        ),
      )
      return updates.length
    })
  }
}

/** The update that makes `doc` equal to `definition`, applied to it; null when it already was. */
export function foldUpdate(
  doc: Y.Doc,
  target: CollabTarget,
  definition: unknown,
  origin?: unknown,
): Uint8Array | null {
  const updates: Uint8Array[] = []
  const capture = (update: Uint8Array) => updates.push(update)
  const shared = new SharedDefinition(doc, target.spec)
  doc.on('update', capture)
  try {
    shared.set(definition, origin)
  } finally {
    doc.off('update', capture)
    shared.destroy()
  }
  return updates.length ? Y.mergeUpdates(updates) : null
}

/** The document's advisory lock, per document, apart from other users of `hashtext` locks. */
const lock = (tx: Tx, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`collab:${key}`}))`)

const notify = (tx: Tx, message: { d: string; u: number; p: string }) =>
  tx.execute(sql`select pg_notify(${COLLAB_CHANNEL}, ${JSON.stringify(message)})`)

const setRevision = (tx: Tx, key: string, revision: number) =>
  tx.update(collabDocuments).set({ revision }).where(eq(collabDocuments.key, key))

/** The draft a document edits, its row locked until the transaction ends. */
async function lockedDraft(tx: Tx, owner: CollabOwner): Promise<{ definition: unknown; revision: number }> {
  const row = await (async () => {
    if ('branchDraftId' in owner) {
      return (
        await tx
          .select({ definition: gitBranchDrafts.definition, revision: gitBranchDrafts.revision })
          .from(gitBranchDrafts)
          .where(eq(gitBranchDrafts.id, owner.branchDraftId))
          .for('update')
      )[0]
    }
    const [table, id] =
      'workflowId' in owner
        ? [workflows, owner.workflowId]
        : 'appId' in owner
          ? [apps, owner.appId]
          : 'libraryQueryId' in owner
            ? [libraryQueries, owner.libraryQueryId]
            : 'componentLibraryId' in owner
              ? [componentLibraries, owner.componentLibraryId]
              : [modules, owner.moduleId]
    return (
      await tx
        .select({ definition: table.draftDefinition, revision: table.draftRevision })
        .from(table)
        .where(eq(table.id, id))
        .for('update')
    )[0]
  })()
  if (!row) throw new Error('The draft is gone')
  return row
}

async function writeDraft(
  tx: Tx,
  owner: CollabOwner,
  definition: unknown,
  revision: number,
  userId: string | null,
): Promise<void> {
  if ('branchDraftId' in owner) {
    await tx
      .update(gitBranchDrafts)
      .set({ definition: definition as never, revision, updatedBy: userId })
      .where(eq(gitBranchDrafts.id, owner.branchDraftId))
    return
  }
  const values = { draftDefinition: definition as never, draftRevision: revision, updatedBy: userId }
  if ('workflowId' in owner) await tx.update(workflows).set(values).where(eq(workflows.id, owner.workflowId))
  else if ('appId' in owner) {
    await tx.update(apps).set(values).where(eq(apps.id, owner.appId))
    // The editor's History (session 41).
    await recordAppVersion(tx, {
      appId: owner.appId,
      definition: definition as AppDefinition,
      revision,
      userId,
    })
  } else if ('libraryQueryId' in owner) {
    await tx.update(libraryQueries).set(values).where(eq(libraryQueries.id, owner.libraryQueryId))
  } else if ('componentLibraryId' in owner) {
    await tx.update(componentLibraries).set(values).where(eq(componentLibraries.id, owner.componentLibraryId))
  } else await tx.update(modules).set(values).where(eq(modules.id, owner.moduleId))
}
