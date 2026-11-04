import { type AppDefinition, appDefinitionHash } from '@ow/app-definition'
import { appSpec, collabKey } from '@ow/collab'
import { SessionSlot } from '@/lib/collab-session'
import { trackPresence } from './presence'
import { useAppEditor } from './store'

/** The app editor's open draft (an app's or a module's), shared with everyone else editing it (M16). */
const slot = new SessionSlot<AppDefinition>(appSpec, {
  attach: (shared) => useAppEditor.getState().attach(shared),
  remote: () => useAppEditor.getState().remote(),
  connection: (status, error, revision) => useAppEditor.getState().connection(status, error, revision),
  saved: () => {
    const definition = useAppEditor.getState().definition
    void appDefinitionHash(definition).then((hash) => useAppEditor.getState().setDraftHash(definition, hash))
  },
  readOnly: () => useAppEditor.getState().readOnly,
  presence: trackPresence,
})

/** Opens an app's or module's main draft, or a Git branch draft of it. */
export function openSession(kind: 'app' | 'module', id: string, branchDraftId: string | null): void {
  slot.open(branchDraftId ? collabKey('branch', branchDraftId) : collabKey(kind, id))
}

export const closeSession = () => slot.close()

/** Presence in the open draft's document, once there is one. */
export const currentAwareness = () => slot.awareness

/** Resolves once the server has saved every edit made here to the draft: the server runs its queries. */
export const ensureSaved = () => slot.ensureSaved()
