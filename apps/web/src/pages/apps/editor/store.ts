import {
  type AppComponent,
  type AppDefinition,
  type AppDiagnostic,
  type AppValidateOptions,
  type ComponentLibraryInfo,
  type ComponentSpec,
  componentSpec,
  customComponentSpec,
  customInstanceInterface,
  instanceInterface,
  type ModuleInfo,
  moduleComponentSpec,
  resolvePage,
  usedComponentLibraries,
  usedLibraries,
  usedModules,
  validateApp,
} from '@ow/app-definition'
import type { AppUrl, ComponentLibraryReleases, ModuleReleases } from '@ow/app-runtime'
import { equal, type SharedDefinition, SharedHistory } from '@ow/collab'
import type * as Y from 'yjs'
import { create } from 'zustand'
import { LOCAL, type SaveStatus } from '@/lib/collab-session'
import { changeKey } from '@/lib/history'
import type { LibraryRef } from '@/lib/library-refs'

export type { SaveStatus }

/** The panel left of the canvas, picked on the rail (one at a time, or none). */
export type LeftPanel = 'components' | 'pages' | 'tree' | 'code' | 'search' | 'state' | 'settings'
/** What the debug drawer above the status bar shows. */
export type DebugTab = 'problems' | 'console'

/** What was showing when an edit was made: undoing it shows it again. */
export interface AppEditorView {
  selected: string | null
  /** Every component selected (M24); `selected` is the last one picked. */
  selection?: string[]
  openCode: string | null
  page: string | null
}

export type { LibraryRef }

/** A module the app places, as the server described it (`modules.resolve`). */
export type ModuleRef = ModuleInfo & { id?: string; name?: string }

/** A component library the app's custom components use (M25), as the server described it. */
export type ComponentLibraryRef = ComponentLibraryInfo & { id?: string; name?: string }

interface AppEditorState {
  /** Whose draft is edited: an app's, or a module's (M14; same editor, saved and run as the module's). */
  kind: 'app' | 'module'
  /** A module's slug (M21): its instances reaching it back are cycles. Null for an app. */
  slug: string | null
  /** The app's id, or the module's. */
  appId: string | null
  /** The Git branch draft being edited (M11), or null for the app's own (main) draft. */
  branchDraftId: string | null
  /** A protected app's main draft: shown, run and updated live, but edits are ignored (they're made on a branch). */
  readOnly: boolean
  definition: AppDefinition
  /**
   * The document everyone edits (M16), once it has synced: edits go through it, and others' come back from it. Until
   * then, `definition` is the draft as loaded and edits are ignored.
   */
  shared: SharedDefinition<AppDefinition> | null
  /** The draft revision the server last saved the document as. */
  revision: number
  /** The hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  status: SaveStatus
  saveError: string | null
  /** From the browser's validator (connector checks come with publishing). */
  diagnostics: AppDiagnostic[]
  /** The component selected on the canvas: the last one picked (the inspector's). */
  selected: string | null
  /** Every component selected (M24): shift- or cmd-click adds and removes; `selected` is among them. */
  selection: string[]
  /** The query, transformer or variable open in the dock beside the left panel (none: the dock is closed). */
  openCode: string | null
  /** What was chosen last, for copy and duplicate: the selected component, or the open code item. */
  focus: 'component' | 'code'
  /** The rail's panel; null when collapsed. */
  leftPanel: LeftPanel | null
  /** The debug drawer's tab; null when closed. */
  debugTab: DebugTab | null
  /** The inspector, right of the canvas (⌘U hides and shows it). */
  inspectorOpen: boolean
  /**
   * Where the draft is: the page being edited (null without pages) and the parameters `utils.openPage` gave it.
   * The running draft follows it; it stays a page the app has (a deleted page gives way to the first).
   */
  url: AppUrl
  /**
   * This editor's own edits to undo and redo (M13's steps, on the shared document's undo manager since M16: undoing
   * never reverts someone else's edit); made afresh when a draft is loaded and synced.
   */
  history: SharedHistory<AppDefinition, AppEditorView> | null
  canUndo: boolean
  canRedo: boolean
  /** Raised by undo and redo: the panels remount, so what they read once starts afresh. */
  epoch: number
  /**
   * What the server said about the library queries the app uses (M14), by slug; null for one that doesn't exist
   * or the person can't see. The validator checks library queries once every one used is known.
   */
  libraries: Record<string, LibraryRef | null>
  /** Likewise for the modules the app places (M14): the validator checks instances once every one is known. */
  modules: Record<string, ModuleRef | null>
  /** The module releases the running draft's instances run, by `slug@version` (`modules.instanceReleases`). */
  moduleReleases: ModuleReleases
  /** Likewise for the component libraries its custom components use (M25, `componentLibraries.resolve`). */
  componentLibraries: Record<string, ComponentLibraryRef | null>
  /** The library releases the running draft's custom components run (`componentLibraries.instanceReleases`). */
  libraryReleases: ComponentLibraryReleases

  load(
    appId: string,
    definition: AppDefinition,
    revision: number,
    draftHash: string,
    opts?: { branchDraftId?: string | null; readOnly?: boolean; kind?: 'app' | 'module'; slug?: string },
  ): void
  /** The shared document synced: it's the definition from now on, and edits go into it. */
  attach(shared: SharedDefinition<AppDefinition>): void
  /** Someone else changed the shared document (or it synced again): shows it as it is now. */
  remote(): void
  connection(status: SaveStatus, saveError: string | null, revision?: number): void
  setDraftHash(definition: AppDefinition, draftHash: string): void
  /** Applies an edit to the shared document; it's validated again, and can be undone. */
  update(edit: (def: AppDefinition) => AppDefinition): void
  /**
   * A code field typed into its text at `path` (`write` changes the `Y.Text`): undoable, grouped like `update`. With
   * `removeEmpty`, a text left empty is removed (the field is optional, and absent means something else).
   */
  editText(
    path: (string | number)[],
    write: (transaction: Y.Transaction) => void,
    opts?: { removeEmpty?: boolean },
  ): void
  /** Puts back the definition before the last edit, and what was showing then. */
  undo(): void
  /** Makes the last undone edit again. */
  redo(): void
  select(name: string | null): void
  /** Adds a component to the selection, or takes it out (shift- or cmd-click, M24). */
  toggleSelect(name: string): void
  /** Selects these components (cmd+A, M24); the last is the inspector's. */
  selectMany(names: string[]): void
  openCodeItem(name: string | null): void
  setLeftPanel(panel: LeftPanel | null): void
  setDebugTab(tab: DebugTab | null): void
  setInspectorOpen(open: boolean): void
  /** Edits another page (without parameters), or follows `utils.openPage` (with them). */
  setUrl(page: string | null, params?: Record<string, string>): void
  /** Adds what the server said about library queries, and validates again. */
  setLibraries(libraries: Record<string, LibraryRef | null>): void
  /** Adds what the server said about modules, and validates again. */
  setModules(modules: Record<string, ModuleRef | null>): void
  setModuleReleases(releases: ModuleReleases): void
  setComponentLibraries(libraries: Record<string, ComponentLibraryRef | null>): void
  setLibraryReleases(releases: ComponentLibraryReleases): void
}

export const useAppEditor = create<AppEditorState>((set, get) => ({
  kind: 'app',
  slug: null,
  appId: null,
  branchDraftId: null,
  readOnly: false,
  definition: { schemaVersion: 1, components: [], queries: [] },
  shared: null,
  revision: 0,
  draftHash: null,
  status: 'connecting',
  saveError: null,
  diagnostics: [],
  selected: null,
  selection: [],
  openCode: null,
  focus: 'component',
  leftPanel: 'components',
  debugTab: null,
  inspectorOpen: true,
  url: { page: null, params: {} },
  history: null,
  canUndo: false,
  canRedo: false,
  epoch: 0,
  libraries: {},
  modules: {},
  moduleReleases: {},
  componentLibraries: {},
  libraryReleases: {},

  load: (appId, definition, revision, draftHash, opts = {}) =>
    set({
      appId,
      kind: opts.kind ?? 'app',
      slug: opts.kind === 'module' ? (opts.slug ?? null) : null,
      branchDraftId: opts.branchDraftId ?? null,
      readOnly: opts.readOnly ?? false,
      definition,
      shared: null,
      revision,
      draftHash,
      status: 'connecting',
      saveError: null,
      diagnostics: validate(definition, {
        ...get(),
        slug: opts.kind === 'module' ? (opts.slug ?? null) : null,
      }),
      selected: null,
      selection: [],
      openCode: null,
      focus: 'component',
      url: { page: resolvePage(definition, null), params: {} },
      ...newHistory(get().history, null),
    }),

  attach: (shared) => set({ shared, ...applied(get(), shared.value), ...newHistory(get().history, shared) }),

  remote: () => {
    const state = get()
    if (!state.shared) return
    const definition = state.shared.value
    // What's showing stays, unless someone else deleted it.
    if (definition !== state.definition) set(applied(state, definition, viewOf(state)))
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

  editText: (path, write, opts = {}) => {
    const state = get()
    const { shared, history } = state
    if (state.readOnly || !shared || !history) return
    // The same key M13's changeKey gives an edit of this one value, so typing groups either way.
    history.change(viewOf(state), `.${path.join('.')}`, Date.now(), (transaction) => {
      write(transaction)
      if (opts.removeEmpty && shared.textAt(path)?.toString().trim() === '') shared.delete(path)
    })
    set({ ...applied(state, shared.value), ...undoable(history) })
  },

  setLibraries: (found) => {
    const libraries = { ...get().libraries, ...found }
    set({ libraries, diagnostics: validate(get().definition, { ...get(), libraries }) })
  },

  setModules: (found) => {
    const modules = { ...get().modules, ...found }
    set({ modules, diagnostics: validate(get().definition, { ...get(), modules }) })
  },

  setModuleReleases: (moduleReleases) => {
    // The running draft restarts its instances on a change; the same releases again aren't one.
    if (JSON.stringify(moduleReleases) !== JSON.stringify(get().moduleReleases)) set({ moduleReleases })
  },

  setComponentLibraries: (found) => {
    const componentLibraries = { ...get().componentLibraries, ...found }
    set({ componentLibraries, diagnostics: validate(get().definition, { ...get(), componentLibraries }) })
  },

  setLibraryReleases: (libraryReleases) => {
    if (JSON.stringify(libraryReleases) !== JSON.stringify(get().libraryReleases)) set({ libraryReleases })
  },

  update: (edit) => {
    const state = get()
    const { shared, history } = state
    if (state.readOnly || !shared || !history) return
    const before = state.definition
    const next = edit(before)
    // Rebuilt but the same (a field reporting the value it has): nothing to undo or save.
    if (next === before || equal(before, next)) return
    history.edit(next, viewOf(state), changeKey(before, next), Date.now())
    set({ ...applied(state, shared.value), ...undoable(history) })
  },

  // Undo and redo are one's own (M16): what others changed meanwhile stays.
  undo: () => {
    const state = get()
    const { shared, history } = state
    if (state.readOnly || !shared || !history) return
    const step = history.undo(viewOf(state))
    if (step) {
      set({
        ...applied(state, shared.value, step.view ?? viewOf(state)),
        ...undoable(history),
        epoch: state.epoch + 1,
      })
    }
  },

  redo: () => {
    const state = get()
    const { shared, history } = state
    if (state.readOnly || !shared || !history) return
    const step = history.redo()
    if (step) {
      set({
        ...applied(state, shared.value, step.view ?? viewOf(state)),
        ...undoable(history),
        epoch: state.epoch + 1,
      })
    }
  },

  // A new selection, code item or page ends the step being typed: the next edit is undone on its own.
  select: (selected) => {
    get().history?.seal()
    set({
      selected,
      selection: selected === null ? [] : [selected],
      ...(selected !== null && { focus: 'component' as const }),
    })
  },
  toggleSelect: (name) => {
    get().history?.seal()
    const { selection } = get()
    const next = selection.includes(name) ? selection.filter((n) => n !== name) : [...selection, name]
    set({ selection: next, selected: next.at(-1) ?? null, focus: 'component' as const })
  },
  selectMany: (names) => {
    get().history?.seal()
    set({
      selection: names,
      selected: names.at(-1) ?? null,
      ...(names.length && { focus: 'component' as const }),
    })
  },
  openCodeItem: (openCode) => {
    get().history?.seal()
    // In the dock; the left panel stays as it was.
    set({ openCode, focus: 'code' as const })
  },
  setLeftPanel: (leftPanel) => set({ leftPanel }),
  setDebugTab: (debugTab) => set({ debugTab }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setUrl: (page, params = {}) => {
    get().history?.seal()
    set((s) => ({ url: { page: resolvePage(s.definition, page), params } }))
  },
}))

/** A fresh undo history for `shared` (none before it syncs), the old one let go. */
function newHistory(
  old: SharedHistory<AppDefinition, AppEditorView> | null,
  shared: SharedDefinition<AppDefinition> | null,
): Pick<AppEditorState, 'history' | 'canUndo' | 'canRedo'> {
  old?.destroy()
  return { history: shared ? new SharedHistory(shared, LOCAL) : null, canUndo: false, canRedo: false }
}

const undoable = (history: SharedHistory<AppDefinition, AppEditorView>) => ({
  canUndo: history.canUndo,
  canRedo: history.canRedo,
})

function viewOf(state: AppEditorState): AppEditorView {
  return {
    selected: state.selected,
    selection: state.selection,
    openCode: state.openCode,
    page: state.url.page,
  }
}

/** What was selected in `view` that `definition` still has; the inspector's the last of it when its own is gone. */
function restoredSelection(
  definition: AppDefinition,
  view: AppEditorView,
): Pick<AppEditorState, 'selection' | 'selected'> {
  const exists = (n: string) => definition.components.some((c) => c.name === n)
  const selection = (view.selection ?? (view.selected ? [view.selected] : [])).filter(exists)
  const selected =
    view.selected !== null && exists(view.selected) ? view.selected : (selection.at(-1) ?? null)
  return { selection, selected }
}

/**
 * The browser's checks, library queries and module instances included once the server said about each one the
 * app uses.
 */
function validate(
  definition: AppDefinition,
  {
    libraries,
    modules,
    componentLibraries,
    slug,
  }: Pick<AppEditorState, 'libraries' | 'modules' | 'componentLibraries' | 'slug'>,
): AppDiagnostic[] {
  const options: AppValidateOptions = slug ? { self: slug } : {}
  if (usedLibraries(definition).every((slug) => Object.hasOwn(libraries, slug))) {
    options.resolveLibrary = (slug) => libraries[slug] ?? undefined
  }
  if (usedModules(definition).every((slug) => Object.hasOwn(modules, slug))) {
    options.resolveModule = (slug) => modules[slug] ?? undefined
  }
  if (usedComponentLibraries(definition).every((slug) => Object.hasOwn(componentLibraries, slug))) {
    options.resolveComponentLibrary = (slug) => componentLibraries[slug] ?? undefined
  }
  return validateApp(definition, options).diagnostics
}

/**
 * The state after `definition` replaces the current one: validated, on a page it has. With a `view` (undo, redo,
 * someone else's edit), what was showing comes back if it's still there.
 */
function applied(
  state: AppEditorState,
  definition: AppDefinition,
  view?: AppEditorView,
): Partial<AppEditorState> {
  const { url } = state
  const page = resolvePage(definition, view ? view.page : url.page)
  const names = new Set([
    ...definition.components.map((c) => c.name),
    ...definition.queries.map((q) => q.name),
    ...(definition.transformers ?? []).map((t) => t.name),
    ...(definition.variables ?? []).map((v) => v.name),
  ])
  return {
    definition,
    ...(page !== url.page && { url: { page, params: {} } }),
    diagnostics: validate(definition, state),
    // What's selected and gone (someone else deleted it) leaves the selection.
    ...(!view &&
      state.selection.some((n) => !names.has(n)) && {
        selection: state.selection.filter((n) => names.has(n)),
        selected: state.selected !== null && names.has(state.selected) ? state.selected : null,
      }),
    ...(view && restoredSelection(definition, view)),
    ...(view && {
      // The code item shown then, or the one open now; one that's gone (an undone query) closes the dock.
      openCode: [view.openCode, state.openCode].find((n) => n !== null && names.has(n)) ?? null,
    }),
  }
}

/**
 * A component's spec; a module instance's from the interface of the release it names, once the editor knows its
 * module (M14), open until then; a custom component's likewise from its library (M25).
 */
export function specOf(
  component: AppComponent,
  modules: Record<string, ModuleRef | null>,
  componentLibraries: Record<string, ComponentLibraryRef | null> = {},
): ComponentSpec | undefined {
  if (component.type === 'custom') {
    return customComponentSpec(
      customInstanceInterface(component, (slug) => componentLibraries[slug] ?? undefined),
    )
  }
  if (component.type !== 'module') return componentSpec(component.type)
  return moduleComponentSpec(instanceInterface(component, (slug) => modules[slug] ?? undefined))
}
