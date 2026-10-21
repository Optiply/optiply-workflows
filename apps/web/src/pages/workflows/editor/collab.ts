import { collabKey, workflowSpec } from '@ow/collab'
import { definitionHash, type WorkflowDefinition } from '@ow/definition'
import { SessionSlot } from '@/lib/collab-session'
import { trackPresence } from './presence'
import { useEditor } from './store'

/** The workflow editor's open draft, shared with everyone else editing it (M16). */
const slot = new SessionSlot<WorkflowDefinition>(workflowSpec, {
  attach: (shared) => useEditor.getState().attach(shared),
  remote: () => useEditor.getState().remote(),
  connection: (status, error, revision) => useEditor.getState().connection(status, error, revision),
  saved: () => {
    const definition = useEditor.getState().definition
    void definitionHash(definition).then((hash) => useEditor.getState().setDraftHash(definition, hash))
  },
  readOnly: () => useEditor.getState().readOnly,
  presence: trackPresence,
})

/** Opens the workflow's main draft, or a Git branch draft of it. */
export function openSession(workflowId: string, branchDraftId: string | null): void {
  slot.open(branchDraftId ? collabKey('branch', branchDraftId) : collabKey('workflow', workflowId))
}

export const closeSession = () => slot.close()

/** Presence in the open draft's document, once there is one. */
export const currentAwareness = () => slot.awareness

/** Resolves once the server has saved every edit made here to the draft: Run waits for it. */
export const ensureSaved = () => slot.ensureSaved()
