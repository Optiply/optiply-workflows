import { useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useTRPC } from '@/lib/trpc'
import { DraftLoader } from '../apps/editor'
import { useLibrarySync } from '../apps/editor/library'
import { useModuleSync } from '../apps/editor/modules'

const route = getRouteApi('/app/modules/$slug')

/**
 * Building a module (M14): the app editor without pages, its draft running on its own with the inputs' test
 * values, saved and published as the module's; a protected one on Git branches, like an app.
 */
export function ModuleEditorPage() {
  const { slug } = route.useParams()
  const search = route.useSearch()
  const trpc = useTRPC()
  const navigate = useNavigate()
  // Loaded into the editor once per visit, like an app's draft.
  const module = useQuery({
    ...trpc.modules.get.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  useLibrarySync()
  // The modules it holds (M21): checked against their releases, and run in the draft.
  useModuleSync()
  return (
    <DraftLoader
      kind="module"
      object={module}
      search={search}
      go={(next) => navigate({ to: '/modules/$slug', params: { slug }, search: next })}
    />
  )
}
