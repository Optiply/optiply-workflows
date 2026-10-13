import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { SampleResult } from './scope-types'
import { useEditor } from './store'

/** Results bigger than this aren't fetched for autocompletion. */
const MAX_SAMPLE_BYTES = 512 * 1024

interface RunSummary {
  id: string
  status: string
}
interface BlockSummary {
  key: string
  status: string
  sizeBytes: number | null
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json() as Promise<T>
}

/** Loads the latest finished run's block results into the editor store, for autocompletion. */
export function useLastRunSamples(slug: string) {
  const setSamples = useEditor((s) => s.setSamples)
  const { data } = useQuery({
    queryKey: ['workflow-samples', slug],
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, SampleResult>> => {
      const { runs } = await json<{ runs: RunSummary[] }>(`/api/v1/workflows/${slug}/runs?limit=10`)
      const run = runs.find((r) => r.status === 'succeeded' || r.status === 'failed')
      if (!run) return {}
      const { blocks } = await json<{ blocks: BlockSummary[] }>(`/api/v1/runs/${run.id}/blocks`)
      const wanted = blocks.filter((b) => b.status === 'succeeded' && (b.sizeBytes ?? 0) <= MAX_SAMPLE_BYTES)
      const results = await Promise.all(
        wanted.map(async (b) => {
          const { block } = await json<{ block: { data: unknown } }>(
            `/api/v1/runs/${run.id}/blocks/${encodeURIComponent(b.key)}`,
          )
          return [b.key, { data: block.data, status: b.status }] as const
        }),
      )
      return Object.fromEntries(results)
    },
  })
  useEffect(() => {
    if (data) setSamples(data)
  }, [data, setSamples])
}
