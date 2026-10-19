import {
  type AppComponent,
  type AppDefinition,
  type AppDiagnostic,
  type AppValidateOptions,
  type ComponentSpec,
  componentSpec,
  instanceInterface,
  instanceRelease,
  type LibraryInfo,
  type ModuleInfo,
  moduleComponentSpec,
  resolvePage,
  validateApp,
} from '@ow/app-definition'
import type { AppUrl, ModuleReleases } from '@ow/app-runtime'
import { create } from 'zustand'
import { emptyHistory, type History, record, redo, sameValue, seal, undo } from '@/lib/history'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

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
  /** A protected app's main draft: shown and run, but edits are ignored (they're made on a branch). */
  readOnly: boolean
  definition: AppDefinition
  /** The draft revision the server has; saves send it for optimistic concurrency. */
  revision: number
  /** The server's hash of the saved draft; equal to the live release's when nothing is unpublished. */
  draftHash: string | null
  /** JSON of the definition the server has, to tell whether an edit changed anything. */
  savedJson: string
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
  /** The edits that can be undone and redone (M13); cleared when a draft is loaded. */
  history: History<AppDefinition, AppEditorView>
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
  /** Applies an edit; the draft becomes dirty and is validated again, and the edit can be undone. */
  update(edit: (def: AppDefinition) => AppDefinition): void
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
  saving(): void
  saved(revision: number, json: string, draftHash: string): void
  conflict(): void
  failed(message: string): void
}

export const useAppEditor = create<AppEditorState>((set, get) => ({
  kind: 'app',
  appId: null,
  branchDraftId: null,
  readOnly: false,
  definition: { schemaVersion: 1, components: [], queries: [] },
  revision: 0,
  draftHash: null,
  savedJson: '',
  status: 'saved',
  saveError: null,
  diagnostics: [],
  selected: null,
  openCode: null,
  focus: 'component',
  panelTab: 'code',
  url: { page: null, params: {} },
  history: emptyHistory(),
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
      revision,
      draftHash,
      savedJson: JSON.stringify(definition),
      status: 'saved',
      saveError: null,
      diagnostics: validate(definition, get()),
      selected: null,
      openCode: definition.queries[0]?.name ?? null,
      focus: 'component',
      url: { page: resolvePage(definition, null), params: {} },
      history: emptyHistory(),
    }),

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
    if (state.readOnly) return
    const before = state.definition
    const next = edit(before)
    // Rebuilt but the same (a field reporting the value it has): nothing to undo or save.
    if (next === before || sameValue(before, next)) return
    set({
      ...applied(state, next),
      history: record(state.history, { before, after: next, view: viewOf(state), at: Date.now() }),
    })
  },

  undo: () => {
    const state = get()
    if (state.readOnly || state.status === 'conflict') return
    const step = undo(state.history, viewOf(state))
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
        ...applied(state, step.entry.after, step.entry.redoView ?? step.entry.view),
        history: step.history,
        epoch: state.epoch + 1,
      })
  },

  // A new selection, code item or page ends the step being typed: the next edit is undone on its own.
  select: (selected) =>
    set((s) => ({
      selected,
      ...(selected !== null && { focus: 'component' as const }),
      history: seal(s.history),
    })),
  openCodeItem: (openCode) =>
    set((s) => ({ openCode, panelTab: 'code', focus: 'code' as const, history: seal(s.history) })),
  setPanelTab: (panelTab) => set({ panelTab }),
  setUrl: (page, params = {}) =>
    set((s) => ({ url: { page: resolvePage(s.definition, page), params }, history: seal(s.history) })),
  saving: () => set({ status: 'saving' }),
  saved: (revision, json, draftHash) =>
    set((s) => ({
      revision,
      draftHash,
      savedJson: json,
      saveError: null,
      // Edited while saving: still dirty.
      status: JSON.stringify(s.definition) === json ? 'saved' : 'dirty',
    })),
  conflict: () => set({ status: 'conflict' }),
  failed: (saveError) => set({ status: 'error', saveError }),
}))

function viewOf(state: AppEditorState): AppEditorView {
  return { selected: state.selected, openCode: state.openCode, page: state.url.page }
}

/**
 * The state after `definition` replaces the current one: validated, on a page it has, and saved or dirty by whether
 * it differs from what the server has (undoing back to it needs no save). A save in flight finishes first: `saved`
 * then sees whether the definition still differs. With a `view` (undo, redo), what was showing comes back if it's
 * still there.
 */
/** The library queries an app uses, by slug, sorted. */
export function usedLibrarySlugs(definition: AppDefinition): string[] {
  return [...new Set(definition.queries.flatMap((q) => (q.kind === 'library' ? [q.library] : [])))].sort()
}

/** The modules an app places, by slug, sorted. */
export function usedModuleSlugs(definition: AppDefinition): string[] {
  return [...new Set(definition.components.flatMap((c) => instanceKey(c)?.slug ?? []))].sort()
}

/** The `slug@version` keys of the module releases the app's instances run, sorted. */
export function usedModuleKeys(definition: AppDefinition): string[] {
  return [...new Set(definition.components.flatMap((c) => instanceKey(c)?.key ?? []))].sort()
}

const instanceKey = (c: AppDefinition['components'][number]) =>
  c.type === 'module' ? instanceRelease(c) : null

/**
 * The browser's checks, library queries and module instances included once the server said about each one the
 * app uses.
 */
function validate(
  definition: AppDefinition,
  { libraries, modules }: Pick<AppEditorState, 'libraries' | 'modules'>,
): AppDiagnostic[] {
  const options: AppValidateOptions = {}
  if (usedLibrarySlugs(definition).every((slug) => Object.hasOwn(libraries, slug))) {
    options.resolveLibrary = (slug) => libraries[slug] ?? undefined
  }
  if (usedModuleSlugs(definition).every((slug) => Object.hasOwn(modules, slug))) {
    options.resolveModule = (slug) => modules[slug] ?? undefined
  }
  return validateApp(definition, options).diagnostics
}

function applied(
  state: AppEditorState,
  definition: AppDefinition,
  view?: AppEditorView,
): Partial<AppEditorState> {
  const { status, url } = state
  const unchanged = JSON.stringify(definition) === state.savedJson
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
    status: status === 'conflict' || status === 'saving' ? status : unchanged ? 'saved' : 'dirty',
    ...(status === 'error' && unchanged && { saveError: null }),
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
