import {
  type Block,
  type Diagnostic,
  type Edge,
  validateDefinition,
  type WorkflowDefinition,
} from '@ow/definition'
import { create } from 'zustand'
import type { SampleResult } from './scope-types'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

/** What the side panel shows when no block is selected. */
export type SideTab = 'problems' | 'functions' | 'releases' | 'settings'

/** The blocks, edges and layout of the graph on the canvas: the workflow's, or one function's. */
export interface GraphPart {
  blocks: Block[]
  edges: Edge[]
  layout?: WorkflowDefinition['layout']
}

/** The graph `fn` names (null: the workflow's own). A function that no longer exists reads as empty. */
export function graphOf(def: WorkflowDefinition, fn: string | null): GraphPart {
  if (fn === null) return def
  return def.functions?.find((f) => f.name === fn) ?? { blocks: [], edges: [] }
}

/** `def` with the graph `fn` names replaced by `part`. */
export function withGraph(def: WorkflowDefinition, fn: string | null, part: GraphPart): WorkflowDefinition {
  if (fn === null) return { ...def, blocks: part.blocks, edges: part.edges, layout: part.layout }
  return {
    ...def,
    functions: (def.functions ?? []).map((f) =>
      f.name === fn ? { ...f, blocks: part.blocks, edges: part.edges, layout: part.layout } : f,
    ),
  }
}

interface EditorState {
  workflowId: string | null
  definition: WorkflowDefinition
  /** The draft revision the server has; saves send it for optimistic concurrency. */
  revision: number
  /** The server's hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  status: SaveStatus
  saveError: string | null
  /** The block selected on the canvas, in the open graph. */
  selected: string | null
  /** The function open on the canvas, or null for the workflow itself. */
  graph: string | null
  diagnostics: Diagnostic[]
  /** Results of the latest finished run, by block, for autocompletion. */
  samples: Record<string, SampleResult>
  sideTab: SideTab

  load(workflowId: string, definition: WorkflowDefinition, revision: number, draftHash: string): void
  /** Applies an edit; the draft becomes dirty and is re-validated. */
  update(edit: (def: WorkflowDefinition) => WorkflowDefinition): void
  select(name: string | null): void
  /** Opens a function on the canvas (or the workflow, with null), selecting `block` in it. */
  openGraph(fn: string | null, block?: string | null): void
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
  graph: null,
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
      graph: null,
      diagnostics: validateDefinition(definition).diagnostics,
    }),

  update: (edit) => {
    const definition = edit(get().definition)
    if (definition === get().definition) return
    const status = get().status === 'conflict' ? 'conflict' : 'dirty'
    set({ definition, status, diagnostics: validateDefinition(definition).diagnostics })
  },

  select: (selected) => set({ selected }),
  openGraph: (graph, block = null) => set({ graph, selected: block }),
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

/** Applies an edit to the open graph (the workflow's, or the open function's). */
export function updateGraph(edit: (graph: GraphPart) => GraphPart) {
  const fn = useEditor.getState().graph
  useEditor.getState().update((def) => {
    const before = graphOf(def, fn)
    const after = edit(before)
    return after === before ? def : withGraph(def, fn, after)
  })
}

/** Applies an edit to one block of the open graph, by name. */
export function updateBlock<B extends Block>(name: string, edit: (block: B) => B) {
  updateGraph((g) => ({ ...g, blocks: g.blocks.map((b) => (b.name === name ? edit(b as B) : b)) }))
}

/** Problems that belong to a block (by name) of the graph `fn` names. */
export function problemsOf(diagnostics: Diagnostic[], block: string, fn: string | null = null): Diagnostic[] {
  return diagnostics.filter((d) => d.block === block && (d.function ?? null) === fn)
}
