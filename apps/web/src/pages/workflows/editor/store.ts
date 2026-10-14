import { type Diagnostic, validateDefinition, type WorkflowDefinition } from '@ow/definition'
import { create } from 'zustand'
import type { SampleResult } from './scope-types'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

/** What the side panel shows when no block is selected. */
export type SideTab = 'problems' | 'releases' | 'settings'

interface EditorState {
  workflowId: string | null
  definition: WorkflowDefinition
  /** The draft revision the server has; saves send it for optimistic concurrency. */
  revision: number
  /** The server's hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  status: SaveStatus
  saveError: string | null
  selected: string | null
  diagnostics: Diagnostic[]
  /** Results of the latest finished run, by block, for autocompletion. */
  samples: Record<string, SampleResult>
  sideTab: SideTab

  load(workflowId: string, definition: WorkflowDefinition, revision: number, draftHash: string): void
  /** Applies an edit; the draft becomes dirty and is re-validated. */
  update(edit: (def: WorkflowDefinition) => WorkflowDefinition): void
  select(name: string | null): void
  saving(): void
  /** The server stored `savedJson` as `revision`; later edits keep the draft dirty. */
  saved(revision: number, savedJson: string, draftHash: string): void
  conflict(): void
  failed(message: string): void
  setSamples(samples: Record<string, SampleResult>): void
  /** Shows a workflow-level tab in the side panel (and deselects the block). */
  showTab(tab: SideTab): void
}

const EMPTY: WorkflowDefinition = { schemaVersion: 1, blocks: [], edges: [] }

/** The editor's state. One editor is open at a time; `load` resets it. */
export const useEditor = create<EditorState>()((set, get) => ({
  workflowId: null,
  definition: EMPTY,
  revision: 0,
  draftHash: null,
  status: 'saved',
  saveError: null,
  selected: null,
  diagnostics: [],
  samples: {},
  sideTab: 'problems',

  load: (workflowId, definition, revision, draftHash) =>
    set({
      workflowId,
      definition,
      revision,
      draftHash,
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
  saved: (revision, savedJson, draftHash) =>
    set({
      revision,
      draftHash,
      status: JSON.stringify(get().definition) === savedJson ? 'saved' : 'dirty',
    }),
  conflict: () => set({ status: 'conflict' }),
  failed: (message) => set({ status: 'error', saveError: message }),
  setSamples: (samples) => set({ samples }),
  showTab: (sideTab) => set({ sideTab, selected: null }),
}))

/** Applies an edit to one block, by name. */
export function updateBlock<B extends WorkflowDefinition['blocks'][number]>(
  name: string,
  edit: (block: B) => B,
) {
  useEditor.getState().update((def) => ({
    ...def,
    blocks: def.blocks.map((b) => (b.name === name ? edit(b as B) : b)),
  }))
}

/** Problems that belong to a block (by name). */
export function problemsOf(diagnostics: Diagnostic[], block: string): Diagnostic[] {
  return diagnostics.filter((d) => d.block === block)
}
