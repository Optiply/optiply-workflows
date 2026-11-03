import { equal, type SharedDefinition, SharedHistory } from '@ow/collab'
import {
  type Block,
  type Diagnostic,
  type Edge,
  usedLibraries,
  validateDefinition,
  type WorkflowDefinition,
} from '@ow/definition'
import { checkBodySchema } from '@ow/definition/body-schema'
import type * as Y from 'yjs'
import { create } from 'zustand'
import { LOCAL, type SaveStatus } from '@/lib/collab-session'
import { changeKey } from '@/lib/history'
import type { LibraryRef } from '@/lib/library-refs'
import type { SampleResult } from './scope-types'

export { LOCAL, type SaveStatus }

/** What the side panel shows when no block is selected. */
export type SideTab = 'problems' | 'functions' | 'releases' | 'settings'
/** The left rail's panels (M28); the workflow-level side tabs became some of them. */
export type RailPanel = SideTab | 'blocks' | 'outline' | 'triggers' | 'search'

/** Which rail panel is open, per browser. */
const RAIL_KEY = 'ow.workflowRail'
const RAIL_PANELS: readonly RailPanel[] = [
  'blocks',
  'outline',
  'functions',
  'triggers',
  'search',
  'releases',
  'settings',
  'problems',
]

function storedRail(): RailPanel | null {
  try {
    const value = localStorage.getItem(RAIL_KEY)
    return RAIL_PANELS.includes(value as RailPanel) ? (value as RailPanel) : null
  } catch {
    return null
  }
}

function storeRail(panel: RailPanel | null) {
  try {
    if (panel) localStorage.setItem(RAIL_KEY, panel)
    else localStorage.removeItem(RAIL_KEY)
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

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
  /** Watching only (Use, or a protected workflow's main draft): shown, run and updated live, but edits are ignored. */
  readOnly: boolean
  definition: WorkflowDefinition
  /**
   * The document everyone edits (M16), once it has synced: edits go through it, and others' come back from it. Until
   * then, `definition` is the draft as loaded and edits are ignored.
   */
  shared: SharedDefinition<WorkflowDefinition> | null
  /** The draft revision the server last saved the document as. */
  revision: number
  /** The hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
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
  /**
   * What the server said about the library queries the workflow uses (M21), by slug; null for one that doesn't
   * exist or the person can't see. The validator checks Library query blocks once every one used is known.
   */
  libraries: Record<string, LibraryRef | null>
  /** Results of the latest finished run, by block, for autocompletion. */
  samples: Record<string, SampleResult>
  /** The left rail's open panel, or none. */
  railPanel: RailPanel | null
  /** The block opened in the side editor panel (M28): its form shows there instead of in its node. */
  panelBlock: string | null
  /** A block the canvas should bring into view (a problem or search hit clicked), until it has. */
  focus: string | null
  /**
   * This editor's own edits to undo and redo (M13's steps, on the shared document's undo manager since M16: undoing
   * never reverts someone else's edit); made afresh when a draft is loaded and synced.
   */
  history: SharedHistory<WorkflowDefinition, EditorView> | null
  /** Whether this editor has edits of its own to undo, or undone ones to redo. */
  canUndo: boolean
  canRedo: boolean
  /** Raised by undo and redo: the side panel remounts, so what it read once (and Monaco's models) starts afresh. */
  epoch: number

  /** Shows a draft as loaded, until `attach` hands over the shared document. */
  load(
    workflowId: string,
    definition: WorkflowDefinition,
    revision: number,
    draftHash: string,
    opts?: { branchDraftId?: string | null; readOnly?: boolean },
  ): void
  /** The shared document synced: it's the definition from now on, and edits go into it. */
  attach(shared: SharedDefinition<WorkflowDefinition>): void
  /** Someone else changed the shared document (or it synced again): shows it as it is now. */
  remote(): void
  /** How the connection stands. */
  connection(status: SaveStatus, saveError: string | null, revision?: number): void
  setDraftHash(definition: WorkflowDefinition, draftHash: string): void
  /** Applies an edit to the shared document; it's re-validated, and can be undone. */
  update(edit: (def: WorkflowDefinition) => WorkflowDefinition): void
  /**
   * A code field typed into its text at `path` (`write` changes the `Y.Text`): undoable, grouped like `update`. With
   * `removeEmpty`, a text left empty is removed (the field is optional, and absent means something else).
   */
  editText(
    path: (string | number)[],
    write: (transaction: Y.Transaction) => void,
    opts?: { removeEmpty?: boolean },
  ): void
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
  setSamples(samples: Record<string, SampleResult>): void
  /** Opens a rail panel (the workflow's problems, releases, ...). */
  showTab(tab: RailPanel): void
  /** Opens a rail panel, or closes it when it's the open one (or with null). */
  toggleRail(panel: RailPanel | null): void
  /** Opens a block's form in the side editor panel, or closes it (null). */
  openInPanel(name: string | null): void
  /** What the server said about library queries the workflow uses (merged into `libraries`); re-validates. */
  setLibraries(libraries: Record<string, LibraryRef | null>): void
}

const EMPTY: WorkflowDefinition = { schemaVersion: 1, blocks: [], edges: [] }

/** The editor's state. One editor is open at a time; `load` resets it. */
export const useEditor = create<EditorState>()((set, get) => ({
  workflowId: null,
  branchDraftId: null,
  readOnly: false,
  definition: EMPTY,
  shared: null,
  revision: 0,
  draftHash: null,
  status: 'connecting',
  saveError: null,
  selected: null,
  selection: [],
  notice: null,
  graph: null,
  diagnostics: [],
  libraries: {},
  samples: {},
  railPanel: storedRail(),
  panelBlock: null,
  focus: null,
  history: null,
  canUndo: false,
  canRedo: false,
  epoch: 0,

  load: (workflowId, definition, revision, draftHash, opts = {}) =>
    set({
      workflowId,
      branchDraftId: opts.branchDraftId ?? null,
      readOnly: opts.readOnly ?? false,
      definition,
      shared: null,
      revision,
      draftHash,
      status: 'connecting',
      saveError: null,
      selected: null,
      selection: [],
      panelBlock: null,
      notice: null,
      graph: null,
      diagnostics: validate(definition, get().libraries),
      ...newHistory(get().history, null),
    }),

  attach: (shared) => set({ shared, ...applied(shared.value), ...newHistory(get().history, shared) }),

  remote: () => {
    const state = get()
    if (!state.shared) return
    const definition = state.shared.value
    if (definition === state.definition) return
    // What's selected stays, minus what someone else deleted.
    const view = restoredView(definition, state)
    const names = new Set(graphOf(definition, view.graph).blocks.map((b) => b.name))
    set({ ...applied(definition), ...view, selection: state.selection.filter((n) => names.has(n)) })
  },

  // Ended for good (access lost): the editor stops taking edits.
  connection: (status, saveError, revision) =>
    set({
      status,
      saveError,
      ...(revision !== undefined && { revision }),
      ...(status === 'closed' && { readOnly: true }),
    }),

  setDraftHash: (definition, draftHash) => {
    if (get().definition === definition) set({ draftHash })
  },

  update: (edit) => {
    const { readOnly, shared, definition: before, selected, graph, history } = get()
    if (readOnly || !shared || !history) return
    const definition = edit(before)
    // Rebuilt but the same (a field reporting the value it has): nothing to undo or save.
    if (definition === before || equal(before, definition)) return
    history.edit(definition, { selected, graph }, changeKey(before, definition), Date.now())
    set({ ...applied(shared.value), ...undoable(history) })
  },

  editText: (path, write, opts = {}) => {
    const { readOnly, shared, history, selected, graph } = get()
    if (readOnly || !shared || !history) return
    // The same key M13's changeKey gives an edit of this one value, so typing groups either way.
    history.change({ selected, graph }, `.${path.join('.')}`, Date.now(), (transaction) => {
      write(transaction)
      if (opts.removeEmpty && shared.textAt(path)?.toString().trim() === '') shared.delete(path)
    })
    set({ ...applied(shared.value), ...undoable(history) })
  },

  // Undo and redo are one's own (M16): what others changed meanwhile stays.
  undo: () => {
    const { readOnly, shared, history, selected, graph, epoch } = get()
    if (readOnly || !shared || !history) return
    const step = history.undo({ selected, graph })
    if (step) {
      set({
        ...applied(shared.value, step.view ?? { selected, graph }),
        ...undoable(history),
        epoch: epoch + 1,
      })
    }
  },

  redo: () => {
    const { readOnly, shared, history, selected, graph, epoch } = get()
    if (readOnly || !shared || !history) return
    const step = history.redo()
    if (step) {
      set({
        ...applied(shared.value, step.view ?? { selected, graph }),
        ...undoable(history),
        epoch: epoch + 1,
      })
    }
  },

  // A new selection ends the step being typed: the next edit is undone on its own.
  select: (selected) => {
    get().history?.seal()
    set({ selected, selection: selected ? [selected] : [] })
  },
  inspect: (selected) => {
    get().history?.seal()
    set({ selected })
  },
  setSelection: (names) => {
    // The same selection changes nothing (no one is notified).
    if (sameNames(get().selection, names)) return
    get().history?.seal()
    set({ selection: names })
  },
  notify: (notice) => set({ notice }),
  openGraph: (graph, block = null) => {
    get().history?.seal()
    // A block asked for (a problem or a search hit) opens in the side panel, with its fields, and is shown.
    set({ graph, selected: block, selection: block ? [block] : [], panelBlock: block, focus: block })
  },
  setSamples: (samples) => set({ samples }),
  showTab: (railPanel) => {
    storeRail(railPanel)
    set({ railPanel })
  },
  toggleRail: (panel) => {
    const railPanel = panel === get().railPanel ? null : panel
    storeRail(railPanel)
    set({ railPanel })
  },
  openInPanel: (panelBlock) => set({ panelBlock, ...(panelBlock && { selected: panelBlock }) }),
  setLibraries: (found) => {
    const libraries = { ...get().libraries, ...found }
    set({ libraries, diagnostics: validate(get().definition, libraries) })
  },
}))

/** The browser's checks, Library query blocks included once the server said about each one the workflow uses. */
function validate(
  definition: WorkflowDefinition,
  libraries: Record<string, LibraryRef | null>,
): Diagnostic[] {
  const known = usedLibraries(definition).every((slug) => Object.hasOwn(libraries, slug))
  return validateDefinition(definition, {
    checkBodySchema,
    ...(known && { resolveLibrary: (slug: string) => libraries[slug] ?? undefined }),
  }).diagnostics
}

/**
 * The state after `definition` replaces the current one, validated. With a `view` (undo, redo, or someone else's edit),
 * what was selected stays if it's still there.
 */
function applied(definition: WorkflowDefinition, view?: EditorView): Partial<EditorState> {
  return {
    definition,
    diagnostics: validate(definition, useEditor.getState().libraries),
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

/** A fresh undo history for `shared` (none before it syncs), the old one let go. */
function newHistory(
  old: SharedHistory<WorkflowDefinition, EditorView> | null,
  shared: SharedDefinition<WorkflowDefinition> | null,
): Pick<EditorState, 'history' | 'canUndo' | 'canRedo'> {
  old?.destroy()
  return { history: shared ? new SharedHistory(shared, LOCAL) : null, canUndo: false, canRedo: false }
}

const undoable = (history: SharedHistory<WorkflowDefinition, EditorView>) => ({
  canUndo: history.canUndo,
  canRedo: history.canRedo,
})

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
