import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { isSqlType } from './resource-types'
import { trpcClient, useTRPC } from './trpc'

export interface SqlSchemaView {
  tables: { schema: string; name: string; columns: { name: string; type: string; nullable: boolean }[] }[]
  truncated: boolean
  /** How many columns were read at most. */
  limit: number
}

export type SqlSchemaState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }
  | { status: 'loaded'; schema: SqlSchemaView; refreshing: boolean }

/** Schemas tables are usually in, written without it. */
const USUAL = new Set(['public', 'dbo', 'main'])

/**
 * How a table is written in SQL: with its schema when the database has several and it isn't the usual one. The tables
 * panel inserts it and the editor's completions offer it, so both write the same name.
 */
export function sqlTableName(table: { schema: string; name: string }, several: boolean): string {
  return several && !USUAL.has(table.schema.toLowerCase()) ? `${table.schema}.${table.name}` : table.name
}

/** Whether a schema is one tables are usually in (an unqualified name means a table there). */
export function isUsualSchema(schema: string): boolean {
  return USUAL.has(schema.toLowerCase())
}

/**
 * A SQL resource's tables and columns for the editor (session 57): read in `environmentId` (the playground's), else
 * the default environment, else the first one it's configured in and the viewer may use. A loaded schema stays shown
 * while it's read again; `refresh` reads the database once more (the server keeps an answer 10 minutes), without
 * making later reads skip that.
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
  const client = useQueryClient()
  const environments = useQuery(trpc.environments.list.queryOptions()).data
  const usable =
    resource && isSqlType(resource.type)
      ? (resource.environments ?? []).filter((e) => (e.configured ?? true) && e.level)
      : []
  const defaultId = environments?.find((e) => e.isDefault)?.id
  const envId =
    environmentId ?? (usable.find((e) => e.environmentId === defaultId) ?? usable[0])?.environmentId
  const input = { resourceId: resource?.id ?? '', environmentId: envId ?? '', refresh: false }
  const options = trpc.resources.sqlSchema.queryOptions(input)
  const query = useQuery({
    ...options,
    enabled: !!resource && isSqlType(resource.type) && !!envId,
    // Tables change (the Database page, other tools): read again when the editor opens a minute later.
    staleTime: 60_000,
    retry: false,
  })
  const [refreshing, setRefreshing] = useState(false)
  const refresh = () => {
    if (!resource || !envId || refreshing) return
    setRefreshing(true)
    trpcClient.resources.sqlSchema
      .query({ ...input, refresh: true })
      .then((data) => client.setQueryData(options.queryKey, data))
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }
  let state: SqlSchemaState = { status: 'none' }
  const data = query.data
  if (!resource || !isSqlType(resource.type) || !envId) state = { status: 'none' }
  // Shown while it's read again (on focus, after a minute, Refresh): the list and completions don't drop out.
  else if (data?.ok && data.supported && data.schema)
    state = { status: 'loaded', schema: data.schema, refreshing: refreshing || query.isFetching }
  else if (query.isPending || refreshing) state = { status: 'loading' }
  else if (query.error) state = { status: 'failed', message: query.error.message }
  else if (data && !data.ok) state = { status: 'failed', message: data.error.message }
  else if (data?.ok && !data.supported) state = { status: 'unsupported' }
  return { state, schema: state.status === 'loaded' ? state.schema : null, refresh }
}
