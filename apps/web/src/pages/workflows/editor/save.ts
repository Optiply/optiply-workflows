import type { WorkflowDefinition } from '@ow/definition'
import { TRPCClientError } from '@trpc/client'
import { errorMessage, trpcClient } from '@/lib/trpc'
import { useEditor } from './store'

/** Saves the draft now if it has unsaved changes (or the last save failed). */
export async function saveDraftNow(): Promise<void> {
  const state = useEditor.getState()
  if ((state.status !== 'dirty' && state.status !== 'error') || !state.workflowId) return
  const snapshot: WorkflowDefinition = state.definition
  const json = JSON.stringify(snapshot)
  state.saving()
  try {
    const result = await trpcClient.workflows.saveDraft.mutate({
      id: state.workflowId,
      revision: state.revision,
      definition: snapshot,
    })
    useEditor.getState().saved(result.revision, json, result.draftHash)
  } catch (err) {
    if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') useEditor.getState().conflict()
    else useEditor.getState().failed(errorMessage(err))
  }
}

/** Resolves once the server has the current draft; runs execute what's saved, so Run waits for this. */
export async function ensureSaved(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { status, saveError } = useEditor.getState()
    if (status === 'saved') return
    if (status === 'conflict')
      throw new Error('Someone else changed this workflow. Reload before running it.')
    if (status === 'error' && i > 0) throw new Error(`The draft couldn't be saved: ${saveError}`)
    if (status === 'dirty' || status === 'error') await saveDraftNow()
    else await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Saving the draft took too long')
}
