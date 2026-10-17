import {
  type Block,
  type Diagnostic,
  type Edge,
  validateDefinition,
  type WorkflowDefinition,
} from '@ow/definition'
import { create } from 'zustand'
import { emptyHistory, type History, record, redo, sameValue, seal, undo } from '@/lib/history'
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

/** What was selected when an edit was made: undoing it shows it again. */
export interface EditorView {
  selected: string | null
  graph: string | null
}

interface EditorState {
  workflowId: string | null
  /** The Git branch draft being edited (M11), or null for the workflow's own (main) draft. */
  branchDraftId: string | null
  /** A protected workflow's main draft: shown and run, but edits are ignored (they're made on a branch). */
  readOnly: boolean
  definition: WorkflowDefinition
  /** The draft revision the server has; saves send it for optimistic concurrency. */
  revision: number
  /** The server's hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  /** JSON of the definition the server has, to tell whether an edit (or an undo) changed anything. */
  savedJson: string
  status: SaveStatus
  saveError: string | null
  /** The block whose inspector shows, in the open graph. */
  selected: string | null
  /** The blocks selected on the canvas (several with ⌘/Ctrl-click or a box), for copy; the nodes show it. */
  selection: string[]
  /** A message about the last paste (what was renamed, skipped or brought along), until dismissed. */
  notice: string | null
  /** The function open on the canvas, or null for the workflow itself. */
  graph: string | null
  diagnostics: Diagnostic[]
  /** Results of the latest finished run, by block, for autocompletion. */
  samples: Record<string, SampleResult>
  sideTab: SideTab
  /** The edits that can be undone and redone (M13); cleared when a draft is loaded. */
  history: History<WorkflowDefinition, EditorView>
  /** Raised by undo and redo: the side panel remounts, so what it read once (and Monaco's models) starts afresh. */
  epoch: number

  load(
    workflowId: string,
    definition: WorkflowDefinition,
    revision: number,
    draftHash: string,
    opts?: { branchDraftId?: string | null; readOnly?: boolean },
  ): void
  /** Applies an edit; the draft becomes dirty and is re-validated, and the edit can be undone. */
  update(edit: (def: WorkflowDefinition) => WorkflowDefinition): void
  /** Puts back the definition before the last edit, and what was selected then. */
  undo(): void
  /** Makes the last undone edit again. */
  redo(): void
  /** Selects one block (or none), as the only one selected on the canvas. */
  select(name: string | null): void
  /** Shows a block's inspector, leaving the canvas selection as React Flow's click made it (⌘/Ctrl adds). */
  inspect(name: string): void
  /** The canvas selection changed: React Flow's `select` changes, from clicks and box selection. */
  setSelection(names: string[]): void
  notify(message: string | null): void
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
  branchDraftId: null,
  readOnly: false,
  definition: EMPTY,
  revision: 0,
  draftHash: null,
  savedJson: '',
  status: 'saved',
  saveError: null,
  selected: null,
  selection: [],
  notice: null,
  graph: null,
  diagnostics: [],
  samples: {},
  sideTab: 'problems',
  history: emptyHistory(),
  epoch: 0,

  load: (workflowId, definition, revision, draftHash, opts = {}) =>
    set({
      workflowId,
      branchDraftId: opts.branchDraftId ?? null,
      readOnly: opts.readOnly ?? false,
      definition,
      revision,
      draftHash,
      savedJson: JSON.stringify(definition),
      status: 'saved',
      saveError: null,
      selected: null,
      selection: [],
      notice: null,
      graph: null,
      diagnostics: validateDefinition(definition).diagnostics,
      history: emptyHistory(),
    }),

  update: (edit) => {
    const { readOnly, definition: before, selected, graph, history } = get()
    if (readOnly) return
    const definition = edit(before)
    // Rebuilt but the same (a field reporting the value it has): nothing to undo or save.
    if (definition === before || sameValue(before, definition)) return
    set({
      ...applied(get(), definition),
      history: record(history, { before, after: definition, view: { selected, graph }, at: Date.now() }),
    })
  },

  undo: () => {
    const state = get()
    if (state.readOnly || state.status === 'conflict') return
    const step = undo(state.history)
    if (step)
      set({
        ...applied(state, step.entry.before, step.entry.view),
        history: step.history,
        epoch: state.epoch + 1,
      })
  },

  redo: () => {
    const state = get()
    if (state.readOnly || state.status === 'conflict') return
    const step = redo(state.history)
    if (step)
      set({
        ...applied(state, step.entry.after, step.entry.view),
        history: step.history,
        epoch: state.epoch + 1,
      })
  },

  // A new selection ends the step being typed: the next edit is undone on its own.
  select: (selected) =>
    set((s) => ({ selected, selection: selected ? [selected] : [], history: seal(s.history) })),
  inspect: (selected) => set((s) => ({ selected, history: seal(s.history) })),
  setSelection: (names) =>
    // The same selection returns the state itself, so nothing is notified.
    set((s) => (sameNames(s.selection, names) ? s : { selection: names, history: seal(s.history) })),
  notify: (notice) => set({ notice }),
  openGraph: (graph, block = null) =>
    set((s) => ({ graph, selected: block, selection: block ? [block] : [], history: seal(s.history) })),
  saving: () => set({ status: 'saving', saveError: null }),
  saved: (revision, savedJson, draftHash) =>
    set({
      revision,
      draftHash,
      savedJson,
      status: JSON.stringify(get().definition) === savedJson ? 'saved' : 'dirty',
    }),
  conflict: () => set({ status: 'conflict' }),
  failed: (message) => set({ status: 'error', saveError: message }),
  setSamples: (samples) => set({ samples }),
  showTab: (sideTab) => set({ sideTab, selected: null }),
}))

/**
 * The state after `definition` replaces the current one: validated, and saved or dirty by whether it differs from
 * what the server has (undoing back to it needs no save). A save in flight finishes first: `saved` then sees whether
 * the definition still differs. With a `view` (undo, redo), what was selected comes back if it's still there.
 */
function applied(
  state: EditorState,
  definition: WorkflowDefinition,
  view?: EditorView,
): Partial<EditorState> {
  const { status } = state
  const unchanged = JSON.stringify(definition) === state.savedJson
  return {
    definition,
    diagnostics: validateDefinition(definition).diagnostics,
    status: status === 'conflict' || status === 'saving' ? status : unchanged ? 'saved' : 'dirty',
    ...(status === 'error' && unchanged && { saveError: null }),
    ...(view && restoredView(definition, view)),
  }
}

/** `view` in `def`: a function that's gone opens the workflow; a block that's gone isn't selected. */
function restoredView(def: WorkflowDefinition, view: EditorView): EditorView & { selection: string[] } {
  const graph = view.graph !== null && def.functions?.some((f) => f.name === view.graph) ? view.graph : null
  const selected =
    view.selected !== null && graphOf(def, graph).blocks.some((b) => b.name === view.selected)
      ? view.selected
      : null
  return { graph, selected, selection: selected ? [selected] : [] }
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

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
