import { type AppDefinition, type AppDiagnostic, validateApp } from '@ow/app-definition'
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

  load(appId: string, definition: AppDefinition, revision: number, draftHash: string): void
  /** Applies an edit; the draft becomes dirty and is validated again. */
  update(edit: (def: AppDefinition) => AppDefinition): void
  select(name: string | null): void
  openCodeItem(name: string | null): void
  setPanelTab(tab: PanelTab): void
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
    }),

  update: (edit) => {
    const { definition, status } = get()
    const next = edit(definition)
    if (next === definition) return
    const unchanged = JSON.stringify(next) === get().savedJson
    set({
      definition: next,
      diagnostics: validateApp(next).diagnostics,
      // A save in flight finishes first; `saved` then sees whether this edit is still unsaved.
      status: status === 'conflict' || status === 'saving' ? status : unchanged ? 'saved' : 'dirty',
    })
  },

  select: (selected) => set({ selected }),
  openCodeItem: (openCode) => set({ openCode, panelTab: 'code' }),
  setPanelTab: (panelTab) => set({ panelTab }),
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
