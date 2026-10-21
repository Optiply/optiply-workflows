import { SharedDefinition } from '@ow/collab'
import { collabDocuments, collabUpdates, type Db } from '@ow/db'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import type { CollabTarget } from './target'

/**
 * The documents of drafts being edited together, in Postgres (architecture §2.19): each document's compacted state
 * in `collab_documents`, and the updates since in `collab_updates`. Yjs updates commute and apply idempotently, so
 * loading is the state plus whatever updates are there, in any order; compacting folds in exactly the updates it read
 * (never "up to an id": a bigserial commits out of order), under a lock per document.
 */
export class CollabStore {
  constructor(private db: Db) {}

  /**
   * The document as updates to apply, oldest first. A draft opened for the first time gets a document made from the
   * draft as stored.
   */
  async load(target: CollabTarget): Promise<Uint8Array[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockName(target.key)}))`)
      let [document] = await tx
        .select({ state: collabDocuments.state })
        .from(collabDocuments)
        .where(eq(collabDocuments.key, target.key))
      if (!document) {
        const doc = new Y.Doc()
        new SharedDefinition(doc, target.spec).set(target.draft.definition)
        const state = Y.encodeStateAsUpdate(doc)
        doc.destroy()
        await tx
          .insert(collabDocuments)
          .values({ key: target.key, ...target.owner, state, revision: target.draft.revision })
        document = { state }
      }
      const updates = await tx
        .select({ update: collabUpdates.update })
        .from(collabUpdates)
        .where(eq(collabUpdates.documentKey, target.key))
        .orderBy(asc(collabUpdates.id))
      return [document.state, ...updates.map((u) => u.update)]
    })
  }

  /** Stores one update to the document. */
  async append(key: string, update: Uint8Array): Promise<void> {
    await this.db.insert(collabUpdates).values({ documentKey: key, update })
  }

  /** Folds the document's updates into its state. Returns how many it folded. */
  async compact(key: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockName(key)}))`)
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

/** The advisory lock's name: per document, apart from other users of `hashtext` locks. */
const lockName = (key: string) => `collab:${key}`
