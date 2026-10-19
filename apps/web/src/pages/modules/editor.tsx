import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ErrorNote, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { Centered, Editor } from '../apps/editor'
import { useLibrarySync } from '../apps/editor/library'
import { useAppEditor } from '../apps/editor/store'

const route = getRouteApi('/app/modules/$slug')

/**
 * Building a module (M14): the app editor without pages, its draft running on its own with the inputs' test
 * values, saved and published as the module's.
 */
export function ModuleEditorPage() {
  const { slug } = route.useParams()
  const search = route.useSearch()
  const trpc = useTRPC()
  // Loaded into the editor once per visit, like an app's draft.
  const mod = useQuery({
    ...trpc.modules.get.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const environments = useQuery(trpc.environments.list.queryOptions())
  useLibrarySync()
  const load = useAppEditor((s) => s.load)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  useEffect(() => {
    if (!mod.data || loadedFor === mod.data.id) return
    load(mod.data.id, mod.data.draftDefinition, mod.data.draftRevision, mod.data.draftHash, {
      kind: 'module',
    })
    setLoadedFor(mod.data.id)
  }, [mod.data, loadedFor, load])

  const error = mod.error ?? environments.error
  if (error)
    return (
      <Centered>
        <ErrorNote error={error} />
      </Centered>
    )
  if (!mod.data || !environments.data || loadedFor !== mod.data.id)
    return (
      <Centered>
        <Spinner />
      </Centered>
    )
  const environment =
    environments.data.find((e) => e.slug === search.env) ??
    environments.data.find((e) => e.isDefault) ??
    environments.data[0]!
  return (
    <Editor
      key={`${mod.data.id}:${environment.id}`}
      app={{
        kind: 'module',
        id: mod.data.id,
        slug: mod.data.slug,
        name: mod.data.name,
        description: mod.data.description,
        level: mod.data.level,
        gitProtected: false,
      }}
      environment={environment}
      environments={environments.data}
      branchDraftId={null}
      git={null}
    />
  )
}
