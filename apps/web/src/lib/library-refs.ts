import type { LibraryInfo } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTRPC } from '@/lib/trpc'

/**
 * A library query an app or workflow uses, as the server described it (`libraryQueries.resolve`); one the person
 * may not use has `noUse` and no id or name (M21).
 */
export type LibraryRef = LibraryInfo & { id?: string; name?: string }

/**
 * Keeps an editor's knowledge of the library queries its definition uses current (M14, M21): `key` is their slugs
 * joined by commas; `onResolved` gets each one, null for one that doesn't exist or the person can't see.
 */
export function useLibraryRefs(key: string, onResolved: (refs: Record<string, LibraryRef | null>) => void) {
  const trpc = useTRPC()
  const slugs = key ? key.split(',') : []
  const resolved = useQuery({
    ...trpc.libraryQueries.resolve.queryOptions({ slugs }),
    enabled: slugs.length > 0,
  })
  useEffect(() => {
    if (!resolved.data || !key) return
    onResolved(Object.fromEntries(key.split(',').map((slug) => [slug, resolved.data[slug] ?? null])))
  }, [resolved.data, key, onResolved])
}
