import { type LibraryQueryDefinition, libraryQueryHash } from '@ow/app-definition'
import { collabKey, libraryQuerySpec } from '@ow/collab'
import { SessionSlot } from '@/lib/collab-session'
import { createPresence } from '@/lib/presence'
import { useLibraryEditor } from './store'

/** Who else has the library query open (M21): avatars, and their cursors in the query field. No canvas, no pointers. */
const presence = createPresence()
export const useLibraryPresence = presence.usePresence

/** The library query editor's open draft, shared with everyone else editing it (M21). */
const slot = new SessionSlot<LibraryQueryDefinition>(libraryQuerySpec, {
  attach: (shared) => useLibraryEditor.getState().attach(shared),
  remote: () => useLibraryEditor.getState().remote(),
  connection: (status, error, revision) => useLibraryEditor.getState().connection(status, error, revision),
  saved: () => {
    const definition = useLibraryEditor.getState().definition
    void libraryQueryHash(definition).then((hash) =>
      useLibraryEditor.getState().setDraftHash(definition, hash),
    )
  },
  readOnly: () => useLibraryEditor.getState().readOnly,
  presence: (awareness) =>
    presence.track(awareness, { read: () => ({ selection: [], area: null }), subscribe: () => () => {} }),
})

/** Opens a library query's main draft, or a Git branch draft of it. */
export function openLibrarySession(id: string, branchDraftId: string | null): void {
  slot.open(branchDraftId ? collabKey('branch', branchDraftId) : collabKey('library', id))
}

export const closeLibrarySession = () => slot.close()

export const libraryAwareness = () => slot.awareness

/**
 * Resolves with the draft's revision once the server has saved every edit made here (Run, publishing and Git use
 * the draft); rejects when it can't be saved.
 */
export async function ensureLibrarySaved(): Promise<number> {
  await slot.ensureSaved()
  return useLibraryEditor.getState().revision
}
