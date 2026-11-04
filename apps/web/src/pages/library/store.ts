import { type LibraryDiagnostic, type LibraryQueryDefinition, validateLibraryQuery } from '@ow/app-definition'
import { equal, type SharedDefinition, SharedHistory } from '@ow/collab'
import type * as Y from 'yjs'
import { create } from 'zustand'
import { LOCAL, type SaveStatus } from '@/lib/collab-session'
import { changeKey } from '@/lib/history'

/**
 * The library query editor's state (M21: multiplayer like the other editors). While the draft's shared document
 * syncs, `definition` is the draft as loaded and edits wait; then it's the document, edits go into it and others'
 * come out of it. Undo and redo are one's own.
 */
export interface LibraryEditorState {
  readOnly: boolean
  definition: LibraryQueryDefinition
  shared: SharedDefinition<LibraryQueryDefinition> | null
  /** The draft revision the server last saved the document as. */
  revision: number
  /** The hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  status: SaveStatus
  saveError: string | null
  /** The browser's checks (the server's, with the connector, come at publishing). */
  diagnostics: LibraryDiagnostic[]
  history: SharedHistory<LibraryQueryDefinition, null> | null
  canUndo: boolean
  canRedo: boolean
  load(
    definition: LibraryQueryDefinition,
    revision: number,
    draftHash: string | null,
    diagnostics: LibraryDiagnostic[],
    readOnly: boolean,
  ): void
  attach(shared: SharedDefinition<LibraryQueryDefinition>): void
  remote(): void
  connection(status: SaveStatus, saveError: string | null, revision?: number): void
  setDraftHash(definition: LibraryQueryDefinition, draftHash: string): void
  /** Applies an edit to the shared document; it's checked again, and can be undone. */
  update(edit: (def: LibraryQueryDefinition) => LibraryQueryDefinition): void
  /** A code field typed into its text at `path` (`write` changes the `Y.Text`): undoable, grouped like `update`. */
  editText(path: (string | number)[], write: (transaction: Y.Transaction) => void): void
  undo(): void
  redo(): void
}

const EMPTY: LibraryQueryDefinition = { schemaVersion: 1, resource: 'optiply_db', query: {}, params: [] }

export const useLibraryEditor = create<LibraryEditorState>()((set, get) => ({
  readOnly: true,
  definition: EMPTY,
  shared: null,
  revision: 0,
  draftHash: null,
  status: 'connecting',
  saveError: null,
  diagnostics: [],
  history: null,
  canUndo: false,
  canRedo: false,

  load: (definition, revision, draftHash, diagnostics, readOnly) =>
    set({
      readOnly,
      definition,
      shared: null,
      revision,
      draftHash,
      status: 'connecting',
      saveError: null,
      diagnostics,
      ...newHistory(get().history, null),
    }),

  attach: (shared) => set({ shared, ...applied(shared.value), ...newHistory(get().history, shared) }),

  remote: () => {
    const { shared, definition } = get()
    if (shared && shared.value !== definition) set(applied(shared.value))
  },

  connection: (status, saveError, revision) =>
    set((s) => ({ status, saveError, revision: revision ?? s.revision })),

  setDraftHash: (definition, draftHash) => {
    if (get().definition === definition) set({ draftHash })
  },

  update: (edit) => {
    const { shared, history, readOnly, definition } = get()
    if (readOnly || !shared || !history) return
    const next = edit(definition)
    if (next === definition || equal(definition, next)) return
    history.edit(next, null, changeKey(definition, next), Date.now())
    set({ ...applied(shared.value), ...undoable(history) })
  },

  editText: (path, write) => {
    const { shared, history, readOnly } = get()
    if (readOnly || !shared || !history) return
    history.change(null, `.${path.join('.')}`, Date.now(), write)
    set({ ...applied(shared.value), ...undoable(history) })
  },

  undo: () => {
    const { shared, history, readOnly } = get()
    if (readOnly || !shared || !history) return
    if (history.undo(null)) set({ ...applied(shared.value), ...undoable(history) })
  },

  redo: () => {
    const { shared, history, readOnly } = get()
    if (readOnly || !shared || !history) return
    if (history.redo()) set({ ...applied(shared.value), ...undoable(history) })
  },
}))

function newHistory(
  old: SharedHistory<LibraryQueryDefinition, null> | null,
  shared: SharedDefinition<LibraryQueryDefinition> | null,
): Pick<LibraryEditorState, 'history' | 'canUndo' | 'canRedo'> {
  old?.destroy()
  return { history: shared ? new SharedHistory(shared, LOCAL) : null, canUndo: false, canRedo: false }
}

const undoable = (history: SharedHistory<LibraryQueryDefinition, null>) => ({
  canUndo: history.canUndo,
  canRedo: history.canRedo,
})

/** The state after `definition` replaces the current one, checked. */
const applied = (definition: LibraryQueryDefinition): Partial<LibraryEditorState> => ({
  definition,
  diagnostics: validateLibraryQuery(definition).diagnostics,
})
