import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTRPC } from '@/lib/trpc'
import { useAppEditor, usedModuleKeys, usedModuleSlugs } from './store'

/**
 * Keeps the store's knowledge of the modules the app places current (M14): what the validator needs (each one's
 * releases and their interfaces), and the releases the running draft's instances run (only modules the person
 * may use; the others don't run).
 */
export function useModuleSync() {
  const trpc = useTRPC()
  const slugKey = useAppEditor((s) => usedModuleSlugs(s.definition).join(','))
  const releaseKey = useAppEditor((s) => usedModuleKeys(s.definition).join(','))
  const setModules = useAppEditor((s) => s.setModules)
  const setModuleReleases = useAppEditor((s) => s.setModuleReleases)
  const slugs = slugKey ? slugKey.split(',') : []
  const keys = releaseKey ? releaseKey.split(',') : []
  const resolved = useQuery({
    ...trpc.modules.resolve.queryOptions({ slugs }),
    enabled: slugs.length > 0,
  })
  const releases = useQuery({
    ...trpc.modules.instanceReleases.queryOptions({ keys }),
    enabled: keys.length > 0,
  })
  useEffect(() => {
    if (!resolved.data || !slugKey) return
    setModules(Object.fromEntries(slugKey.split(',').map((slug) => [slug, resolved.data[slug] ?? null])))
  }, [resolved.data, slugKey, setModules])
  useEffect(() => {
    if (!releaseKey) setModuleReleases({})
    else if (releases.data) setModuleReleases(releases.data)
  }, [releases.data, releaseKey, setModuleReleases])
}
