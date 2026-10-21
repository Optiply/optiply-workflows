import * as Y from 'yjs'
import type { SharedDefinition } from './shared'

/** At most this many steps can be undone (M13's limit). */
export const HISTORY_LIMIT = 100
/** Edits of the same values less than this far apart are one step (M13's). */
export const MERGE_MS = 1000

const VIEW = 'view'
const REDO_VIEW = 'redoView'

/**
 * Undo and redo of one's own edits to a shared definition (architecture §2.19), on Yjs's `UndoManager`: undoing never
 * reverts someone else's edit, and what others changed since stays.
 *
 * It keeps M13's behaviour: edits with the same `key` (M13's `changeKey`: the values an edit changed in place) less
 * than `MERGE_MS` apart are one step, a `null` key or a `seal` (a change of selection) starts a new one, and each step
 * keeps the editor's `view` from when it was made (shown on undo) and from when it was undone (shown on redo).
 */
export class SharedHistory<D, V> {
  readonly undoManager: Y.UndoManager
  private lastKey: string | null = null
  private lastAt = 0
  private open = false
  private pendingView: V | undefined

  constructor(
    readonly shared: SharedDefinition<D>,
    /** The origin of this editor's own edits; only those are undone. */
    readonly origin: unknown,
  ) {
    // `edit` decides what merges (lib0 reads the clock its own way, so Yjs's timer stays out of it).
    this.undoManager = new Y.UndoManager(shared.root, {
      trackedOrigins: new Set([origin]),
      captureTimeout: Number.POSITIVE_INFINITY,
    })
    this.undoManager.on('stack-item-added', this.added)
  }

  destroy(): void {
    this.undoManager.off('stack-item-added', this.added)
    this.undoManager.destroy()
  }

  get canUndo(): boolean {
    return this.undoManager.canUndo()
  }

  get canRedo(): boolean {
    return this.undoManager.canRedo()
  }

  /**
   * Writes a local edit as a step to undo, or as part of the open step when it changed the same values (`key`) a
   * moment ago. `view` is what the editor showed as it was made; `at` when it was made (ms).
   */
  edit(next: D, view: V, key: string | null, at = Date.now()): void {
    if (!(this.open && key !== null && key === this.lastKey && at - this.lastAt < MERGE_MS)) {
      this.undoManager.stopCapturing()
    }
    this.pendingView = view
    try {
      this.shared.set(next, this.origin)
    } finally {
      this.pendingView = undefined
    }
    this.lastKey = key
    this.lastAt = at
    this.open = key !== null
  }

  /** Ends the open step: the next edit starts a new one, whatever it changes. */
  seal(): void {
    this.open = false
  }

  /**
   * Undoes one's last step that still changes something. Returns the view it was made in, or null when there was
   * nothing to undo. `view` is what's showing now, which redoing the step shows again.
   */
  undo(view?: V): { view: V | undefined } | null {
    this.seal()
    const undone = this.undoManager.undo()
    if (!undone) return null
    const redo = this.undoManager.redoStack.at(-1)
    redo?.meta.set(VIEW, undone.meta.get(VIEW))
    if (view !== undefined) redo?.meta.set(REDO_VIEW, view)
    return { view: undone.meta.get(VIEW) as V | undefined }
  }

  /** Redoes the last undone step. Returns the view showing when it was undone; null when there was nothing to redo. */
  redo(): { view: V | undefined } | null {
    this.seal()
    const redone = this.undoManager.redo()
    if (!redone) return null
    this.undoManager.undoStack.at(-1)?.meta.set(VIEW, redone.meta.get(VIEW))
    return { view: (redone.meta.get(REDO_VIEW) ?? redone.meta.get(VIEW)) as V | undefined }
  }

  private added = ({
    stackItem,
    type,
  }: {
    stackItem: Y.UndoManager['undoStack'][number]
    type: 'undo' | 'redo'
  }) => {
    if (type !== 'undo' || this.undoManager.redoing) return
    stackItem.meta.set(VIEW, this.pendingView)
    const stack = this.undoManager.undoStack
    if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT)
  }
}
