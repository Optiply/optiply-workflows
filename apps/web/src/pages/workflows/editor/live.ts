import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { runsApi } from '@/lib/runs-api'
import { useRun } from './run-state'

/**
 * Follows the open run over server-sent events: the snapshot, then every block and run change. When the run ends,
 * its full details are reloaded and the autocompletion samples refreshed.
 */
export function useRunEvents() {
  const runId = useRun((s) => s.runId)
  const slug = useRun((s) => s.slug)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!runId) return
    const { snapshot, applyBlock, applyRun, setRun } = useRun.getState()
    const source = new EventSource(`/api/v1/runs/${runId}/events`)
    const stillOpen = () => useRun.getState().runId === runId
    source.addEventListener('snapshot', (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (stillOpen()) snapshot(data.run, data.blocks)
    })
    source.addEventListener('block', (e) => {
      if (stillOpen()) applyBlock(JSON.parse((e as MessageEvent).data))
    })
    source.addEventListener('run', (e) => {
      if (stillOpen()) applyRun(JSON.parse((e as MessageEvent).data).status)
    })
    source.addEventListener('end', async () => {
      source.close()
      const run = await runsApi.get(runId)
      if (stillOpen()) setRun(run)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workflow-samples', slug] }),
        queryClient.invalidateQueries({ queryKey: ['workflow-runs', slug] }),
        queryClient.invalidateQueries({ queryKey: ['run', runId] }),
      ])
    })
    // A refused stream (the run is gone or not visible) closes without retrying.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) source.close()
    }
    return () => source.close()
  }, [runId, slug, queryClient])
}
