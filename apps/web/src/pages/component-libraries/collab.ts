import { type ComponentLibraryDefinition, componentLibraryHash } from '@ow/app-definition'
import { collabKey, componentLibrarySpec } from '@ow/collab'
import { SessionSlot } from '@/lib/collab-session'
import { createPresence } from '@/lib/presence'
import { useComponentLibraryEditor } from './store'

/** Who else has the library open (M25): avatars, and their cursors in its files. */
const presence = createPresence()
export const useComponentLibraryPresence = presence.usePresence

/** The component library editor's open draft, shared with everyone else editing it (M25). */
const slot = new SessionSlot<ComponentLibraryDefinition>(componentLibrarySpec, {
  attach: (shared) => useComponentLibraryEditor.getState().attach(shared),
  remote: () => useComponentLibraryEditor.getState().remote(),
  connection: (status, error, revision) =>
    useComponentLibraryEditor.getState().connection(status, error, revision),
  saved: () => {
    const definition = useComponentLibraryEditor.getState().definition
    void componentLibraryHash(definition).then((hash) =>
      useComponentLibraryEditor.getState().setDraftHash(definition, hash),
    )
  },
  readOnly: () => useComponentLibraryEditor.getState().readOnly,
  presence: (awareness) =>
    presence.track(awareness, { read: () => ({ selection: [], area: null }), subscribe: () => () => {} }),
})

/** Opens a library's main draft, or a Git branch draft of it. */
export function openComponentLibrarySession(id: string, branchDraftId: string | null): void {
  slot.open(branchDraftId ? collabKey('branch', branchDraftId) : collabKey('components', id))
}

export const closeComponentLibrarySession = () => slot.close()

export const componentLibraryAwareness = () => slot.awareness

/**
 * Resolves with the draft's revision once the server has saved every edit made here (Build, publishing and Git use
 * the draft); rejects when it can't be saved.
 */
export async function ensureComponentLibrarySaved(): Promise<number> {
  await slot.ensureSaved()
  return useComponentLibraryEditor.getState().revision
}
