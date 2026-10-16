import { type AppDefinition, type AppDiagnostic, resolvePage, validateApp } from '@ow/app-definition'
import type { AppUrl } from '@ow/app-runtime'
import { create } from 'zustand'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

/** What the bottom panel shows. */
export type PanelTab = 'code' | 'state' | 'problems' | 'console'

interface AppEditorState {
  appId: string | null
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
  panelTab: PanelTab
  /**
   * Where the draft is: the page being edited (null without pages) and the parameters `utils.openPage` gave it.
   * The running draft follows it; it stays a page the app has (a deleted page gives way to the first).
   */
  url: AppUrl

  load(appId: string, definition: AppDefinition, revision: number, draftHash: string): void
  /** Applies an edit; the draft becomes dirty and is validated again. */
  update(edit: (def: AppDefinition) => AppDefinition): void
  select(name: string | null): void
  openCodeItem(name: string | null): void
  setPanelTab(tab: PanelTab): void
  /** Edits another page (without parameters), or follows `utils.openPage` (with them). */
  setUrl(page: string | null, params?: Record<string, string>): void
  saving(): void
  saved(revision: number, json: string, draftHash: string): void
  conflict(): void
  failed(message: string): void
}

export const useAppEditor = create<AppEditorState>((set, get) => ({
  appId: null,
  definition: { schemaVersion: 1, components: [], queries: [] },
  revision: 0,
  draftHash: null,
  savedJson: '',
  status: 'saved',
  saveError: null,
  diagnostics: [],
  selected: null,
  openCode: null,
  panelTab: 'code',
  url: { page: null, params: {} },

  load: (appId, definition, revision, draftHash) =>
    set({
      appId,
      definition,
      revision,
      draftHash,
      savedJson: JSON.stringify(definition),
      status: 'saved',
      saveError: null,
      diagnostics: validateApp(definition).diagnostics,
      selected: null,
      openCode: definition.queries[0]?.name ?? null,
      url: { page: resolvePage(definition, null), params: {} },
    }),

  update: (edit) => {
    const { definition, status } = get()
    const next = edit(definition)
    if (next === definition) return
    const unchanged = JSON.stringify(next) === get().savedJson
    const { url } = get()
    const page = resolvePage(next, url.page)
    set({
      definition: next,
      ...(page !== url.page && { url: { page, params: {} } }),
      diagnostics: validateApp(next).diagnostics,
      // A save in flight finishes first; `saved` then sees whether this edit is still unsaved.
      status: status === 'conflict' || status === 'saving' ? status : unchanged ? 'saved' : 'dirty',
    })
  },

  select: (selected) => set({ selected }),
  openCodeItem: (openCode) => set({ openCode, panelTab: 'code' }),
  setPanelTab: (panelTab) => set({ panelTab }),
  setUrl: (page, params = {}) => set((s) => ({ url: { page: resolvePage(s.definition, page), params } })),
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
