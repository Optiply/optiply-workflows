import {
  type AppComponent,
  type AppDefinition,
  type AppDiagnostic,
  type AppValidateOptions,
  type ComponentSpec,
  componentSpec,
  instanceInterface,
  type LibraryInfo,
  type ModuleInfo,
  moduleComponentSpec,
  resolvePage,
  usedLibraries,
  usedModules,
  validateApp,
} from '@ow/app-definition'
import type { AppUrl, ModuleReleases } from '@ow/app-runtime'
import { equal, type SharedDefinition, SharedHistory } from '@ow/collab'
import type * as Y from 'yjs'
import { create } from 'zustand'
import { LOCAL, type SaveStatus } from '@/lib/collab-session'
import { changeKey } from '@/lib/history'

export type { SaveStatus }

/** What the bottom panel shows. */
export type PanelTab = 'code' | 'state' | 'problems' | 'console'

/** What was showing when an edit was made: undoing it shows it again. */
export interface AppEditorView {
  selected: string | null
  openCode: string | null
  page: string | null
}

/** A library query the app uses, as the server described it (`libraryQueries.resolve`). */
export type LibraryRef = LibraryInfo & { id: string; name: string }

/** A module the app places, as the server described it (`modules.resolve`). */
export type ModuleRef = ModuleInfo & { id: string; name: string }

interface AppEditorState {
  /** Whose draft is edited: an app's, or a module's (M14; same editor, saved and run as the module's). */
  kind: 'app' | 'module'
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
  /** The component selected on the canvas. */
  selected: string | null
  /** The query, transformer or variable open in the bottom panel. */
  openCode: string | null
  /** What was chosen last, for copy and duplicate: the selected component, or the open code item. */
  focus: 'component' | 'code'
  panelTab: PanelTab
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

  load(
    appId: string,
    definition: AppDefinition,
    revision: number,
    draftHash: string,
    opts?: { branchDraftId?: string | null; readOnly?: boolean; kind?: 'app' | 'module' },
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
  openCodeItem(name: string | null): void
  setPanelTab(tab: PanelTab): void
  /** Edits another page (without parameters), or follows `utils.openPage` (with them). */
  setUrl(page: string | null, params?: Record<string, string>): void
  /** Adds what the server said about library queries, and validates again. */
  setLibraries(libraries: Record<string, LibraryRef | null>): void
  /** Adds what the server said about modules, and validates again. */
  setModules(modules: Record<string, ModuleRef | null>): void
  setModuleReleases(releases: ModuleReleases): void
}

export const useAppEditor = create<AppEditorState>((set, get) => ({
  kind: 'app',
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
  openCode: null,
  focus: 'component',
  panelTab: 'code',
  url: { page: null, params: {} },
  history: null,
  canUndo: false,
  canRedo: false,
  epoch: 0,
  libraries: {},
  modules: {},
  moduleReleases: {},

  load: (appId, definition, revision, draftHash, opts = {}) =>
    set({
      appId,
      kind: opts.kind ?? 'app',
      branchDraftId: opts.branchDraftId ?? null,
      readOnly: opts.readOnly ?? false,
      definition,
      shared: null,
      revision,
      draftHash,
      status: 'connecting',
      saveError: null,
      diagnostics: validate(definition, get()),
      selected: null,
      openCode: definition.queries[0]?.name ?? null,
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
    set({ selected, ...(selected !== null && { focus: 'component' as const }) })
  },
  openCodeItem: (openCode) => {
    get().history?.seal()
    set({ openCode, panelTab: 'code', focus: 'code' as const })
  },
  setPanelTab: (panelTab) => set({ panelTab }),
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
  return { selected: state.selected, openCode: state.openCode, page: state.url.page }
}

/**
 * The browser's checks, library queries and module instances included once the server said about each one the
 * app uses.
 */
function validate(
  definition: AppDefinition,
  { libraries, modules }: Pick<AppEditorState, 'libraries' | 'modules'>,
): AppDiagnostic[] {
  const options: AppValidateOptions = {}
  if (usedLibraries(definition).every((slug) => Object.hasOwn(libraries, slug))) {
    options.resolveLibrary = (slug) => libraries[slug] ?? undefined
  }
  if (usedModules(definition).every((slug) => Object.hasOwn(modules, slug))) {
    options.resolveModule = (slug) => modules[slug] ?? undefined
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
    ...(view && {
      selected:
        view.selected !== null && definition.components.some((c) => c.name === view.selected)
          ? view.selected
          : null,
      // The code item shown then, or the one open now; one that's gone (an undone query) gives way to the first.
      openCode:
        [view.openCode, state.openCode].find((n) => n !== null && names.has(n)) ??
        definition.queries[0]?.name ??
        null,
    }),
  }
}

/**
 * A component's spec; a module instance's from the interface of the release it names, once the editor knows its
 * module (M14), open until then.
 */
export function specOf(
  component: AppComponent,
  modules: Record<string, ModuleRef | null>,
): ComponentSpec | undefined {
  if (component.type !== 'module') return componentSpec(component.type)
  return moduleComponentSpec(instanceInterface(component, (slug) => modules[slug] ?? undefined))
}
