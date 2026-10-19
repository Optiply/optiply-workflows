import type { AppDefinition } from '@ow/app-definition'
import { TRPCClientError } from '@trpc/client'
import { errorMessage, trpcClient } from '@/lib/trpc'
import { useAppEditor } from './store'

/** Saves the draft now if it has unsaved changes (or the last save failed). */
export async function saveDraftNow(): Promise<void> {
  const state = useAppEditor.getState()
  if ((state.status !== 'dirty' && state.status !== 'error') || !state.appId) return
  const snapshot: AppDefinition = state.definition
  const json = JSON.stringify(snapshot)
  state.saving()
  try {
    const result = state.branchDraftId
      ? await trpcClient.branchDrafts.save.mutate({
          id: state.branchDraftId,
          revision: state.revision,
          definition: snapshot,
        })
      : state.kind === 'module'
        ? await trpcClient.modules.saveDraft.mutate({
            id: state.appId,
            revision: state.revision,
            definition: snapshot,
          })
        : await trpcClient.apps.saveDraft.mutate({
            id: state.appId,
            revision: state.revision,
            definition: snapshot,
          })
    useAppEditor.getState().saved(result.revision, json, result.draftHash)
  } catch (err) {
    if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') useAppEditor.getState().conflict()
    else useAppEditor.getState().failed(errorMessage(err))
  }
}

/** Resolves once the server has the current draft: the server runs the draft's queries as saved. */
export async function ensureSaved(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { status, saveError } = useAppEditor.getState()
    if (status === 'saved') return
    if (status === 'conflict')
      throw new Error(
        `Someone else changed this ${useAppEditor.getState().kind}. Reload before running its queries.`,
      )
    if (status === 'error' && i > 0) throw new Error(`The draft couldn't be saved: ${saveError}`)
    if (status === 'dirty' || status === 'error') await saveDraftNow()
    else await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Saving the draft took too long')
}
