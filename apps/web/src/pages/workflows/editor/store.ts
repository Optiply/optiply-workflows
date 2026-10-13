import { type Diagnostic, validateDefinition, type WorkflowDefinition } from '@ow/definition'
import { create } from 'zustand'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

interface EditorState {
  workflowId: string | null
  definition: WorkflowDefinition
  /** The draft revision the server has; saves send it for optimistic concurrency. */
  revision: number
  status: SaveStatus
  saveError: string | null
  selected: string | null
  diagnostics: Diagnostic[]

  load(workflowId: string, definition: WorkflowDefinition, revision: number): void
  /** Applies an edit; the draft becomes dirty and is re-validated. */
  update(edit: (def: WorkflowDefinition) => WorkflowDefinition): void
  select(name: string | null): void
  saving(): void
  /** The server stored `savedJson` as `revision`; later edits keep the draft dirty. */
  saved(revision: number, savedJson: string): void
  conflict(): void
  failed(message: string): void
}

const EMPTY: WorkflowDefinition = { schemaVersion: 1, blocks: [], edges: [] }

/** The editor's state. One editor is open at a time; `load` resets it. */
export const useEditor = create<EditorState>()((set, get) => ({
  workflowId: null,
  definition: EMPTY,
  revision: 0,
  status: 'saved',
  saveError: null,
  selected: null,
  diagnostics: [],

  load: (workflowId, definition, revision) =>
    set({
      workflowId,
      definition,
      revision,
      status: 'saved',
      saveError: null,
      selected: null,
      diagnostics: validateDefinition(definition).diagnostics,
    }),

  update: (edit) => {
    const definition = edit(get().definition)
    if (definition === get().definition) return
    const status = get().status === 'conflict' ? 'conflict' : 'dirty'
    set({ definition, status, diagnostics: validateDefinition(definition).diagnostics })
  },

  select: (selected) => set({ selected }),
  saving: () => set({ status: 'saving', saveError: null }),
  saved: (revision, savedJson) =>
    set({ revision, status: JSON.stringify(get().definition) === savedJson ? 'saved' : 'dirty' }),
  conflict: () => set({ status: 'conflict' }),
  failed: (message) => set({ status: 'error', saveError: message }),
}))

/** Problems that belong to a block (by name). */
export function problemsOf(diagnostics: Diagnostic[], block: string): Diagnostic[] {
  return diagnostics.filter((d) => d.block === block)
}
