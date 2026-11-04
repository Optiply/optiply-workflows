import {
  type ComponentLibraryDefinition,
  type ComponentLibraryDiagnostic,
  emptyComponentLibrary,
  validateComponentLibrary,
} from '@ow/app-definition'
import { equal, type SharedDefinition, SharedHistory } from '@ow/collab'
import type * as Y from 'yjs'
import { create } from 'zustand'
import { LOCAL, type SaveStatus } from '@/lib/collab-session'
import { changeKey } from '@/lib/history'

/** A build's problem at a file (line and column from 1), as `componentLibraries.build` returns it. */
export interface BuildProblem {
  file: string | null
  line: number | null
  column: number | null
  message: string
}

/**
 * The component library editor's state (M25, multiplayer like the other editors). While the draft's shared document
 * syncs, `definition` is the draft as loaded and edits wait; then it's the document, edits go into it and others'
 * come out of it. Undo and redo are one's own.
 */
export interface ComponentLibraryEditorState {
  readOnly: boolean
  definition: ComponentLibraryDefinition
  shared: SharedDefinition<ComponentLibraryDefinition> | null
  /** The draft revision the server last saved the document as. */
  revision: number
  /** The hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  status: SaveStatus
  saveError: string | null
  /** The browser's checks (the build's come when it runs). */
  diagnostics: ComponentLibraryDiagnostic[]
  history: SharedHistory<ComponentLibraryDefinition, null> | null
  /** The last build's problems, shown on their files until the next build. */
  buildProblems: BuildProblem[]
  setBuildProblems(problems: BuildProblem[]): void
  /** The `package-lock.json` the draft's last build made or followed (the versions its packages resolved to). */
  lock: string | null
  setLock(lock: string | null): void
  canUndo: boolean
  canRedo: boolean
  load(
    definition: ComponentLibraryDefinition,
    revision: number,
    draftHash: string | null,
    diagnostics: ComponentLibraryDiagnostic[],
    readOnly: boolean,
  ): void
  attach(shared: SharedDefinition<ComponentLibraryDefinition>): void
  remote(): void
  /** How many changes came from elsewhere (others, a push from the CLI: M33), to notice them. */
  remoteChanges: number
  connection(status: SaveStatus, saveError: string | null, revision?: number): void
  setDraftHash(definition: ComponentLibraryDefinition, draftHash: string): void
  /** Applies an edit to the shared document; it's checked again, and can be undone. */
  update(edit: (def: ComponentLibraryDefinition) => ComponentLibraryDefinition): void
  /** A code field typed into its text at `path` (`write` changes the `Y.Text`): undoable, grouped like `update`. */
  editText(path: (string | number)[], write: (transaction: Y.Transaction) => void): void
  undo(): void
  redo(): void
}

const EMPTY: ComponentLibraryDefinition = { ...emptyComponentLibrary(), files: [], components: [] }

export const useComponentLibraryEditor = create<ComponentLibraryEditorState>()((set, get) => ({
  readOnly: true,
  definition: EMPTY,
  shared: null,
  revision: 0,
  draftHash: null,
  status: 'connecting',
  saveError: null,
  diagnostics: [],
  history: null,
  buildProblems: [],
  setBuildProblems: (buildProblems) => set({ buildProblems }),
  lock: null,
  setLock: (lock) => set({ lock }),
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
      buildProblems: [],
      ...newHistory(get().history, null),
    }),

  attach: (shared) => set({ shared, ...applied(shared.value), ...newHistory(get().history, shared) }),

  remote: () => {
    const { shared, definition } = get()
    if (shared && shared.value !== definition)
      set({ ...applied(shared.value), remoteChanges: get().remoteChanges + 1 })
  },
  remoteChanges: 0,

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
  old: SharedHistory<ComponentLibraryDefinition, null> | null,
  shared: SharedDefinition<ComponentLibraryDefinition> | null,
): Pick<ComponentLibraryEditorState, 'history' | 'canUndo' | 'canRedo'> {
  old?.destroy()
  return { history: shared ? new SharedHistory(shared, LOCAL) : null, canUndo: false, canRedo: false }
}

const undoable = (history: SharedHistory<ComponentLibraryDefinition, null>) => ({
  canUndo: history.canUndo,
  canRedo: history.canRedo,
})

/** The state after `definition` replaces the current one, checked. */
const applied = (definition: ComponentLibraryDefinition): Partial<ComponentLibraryEditorState> => ({
  definition,
  diagnostics: validateComponentLibrary(definition).diagnostics,
})
