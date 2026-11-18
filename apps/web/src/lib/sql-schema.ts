import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isSqlType } from './resource-types'
import { useTRPC } from './trpc'

export interface SqlSchemaView {
  tables: { schema: string; name: string; columns: { name: string; type: string; nullable: boolean }[] }[]
  truncated: boolean
}

export type SqlSchemaState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }
  | { status: 'loaded'; schema: SqlSchemaView }

/**
 * A SQL resource's tables and columns for the editor (session 57): read in `environmentId` (the playground's), else
 * the default environment, else the first one it's configured in and the viewer may use. `refresh` reads the database
 * again (the server keeps an answer 10 minutes).
 */
export function useSqlSchema(
  resource:
    | {
        id: string
        type: string
        /** Only needed without `environmentId`: where it's configured and may be used. */
        environments?: { environmentId: string; configured?: boolean; level: string | null }[]
      }
    | undefined,
  environmentId?: string,
): { state: SqlSchemaState; schema: SqlSchemaView | null; refresh: () => void } {
  const trpc = useTRPC()
  const environments = useQuery(trpc.environments.list.queryOptions()).data
  const usable =
    resource && isSqlType(resource.type)
      ? (resource.environments ?? []).filter((e) => (e.configured ?? true) && e.level)
      : []
  const defaultId = environments?.find((e) => e.isDefault)?.id
  const envId =
    environmentId ?? (usable.find((e) => e.environmentId === defaultId) ?? usable[0])?.environmentId
  const [refresh, setRefresh] = useState(false)
  const query = useQuery({
    ...trpc.resources.sqlSchema.queryOptions({
      resourceId: resource?.id ?? '',
      environmentId: envId ?? '',
      refresh,
    }),
    enabled: !!resource && isSqlType(resource.type) && !!envId,
    // Tables change (the Database page, other tools): read again when the editor opens a minute later.
    staleTime: 60_000,
    retry: false,
  })
  const reload = () => {
    if (refresh) void query.refetch()
    else setRefresh(true)
  }
  let state: SqlSchemaState = { status: 'none' }
  if (!resource || !isSqlType(resource.type) || !envId) state = { status: 'none' }
  else if (query.isFetching) state = { status: 'loading' }
  else if (query.error) state = { status: 'failed', message: query.error.message }
  else if (query.data && !query.data.ok) state = { status: 'failed', message: query.data.error.message }
  else if (query.data?.ok && !query.data.supported) state = { status: 'unsupported' }
  else if (query.data?.ok && query.data.schema) state = { status: 'loaded', schema: query.data.schema }
  return { state, schema: state.status === 'loaded' ? state.schema : null, refresh: reload }
}
