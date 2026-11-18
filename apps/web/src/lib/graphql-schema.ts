import { useQuery } from '@tanstack/react-query'
import type { IntrospectionQuery } from 'graphql'
import { useState } from 'react'
import { useTRPC } from './trpc'

/**
 * A GraphQL resource's schema for the editor (M27): read through the resource in the default environment, or the
 * first one it's configured in and the viewer may use. Null until it's there, or when the endpoint won't give it.
 */
export function useGraphqlSchema(
  resource:
    | {
        id: string
        type: string
        environments: { environmentId: string; configured: boolean; level: string | null }[]
      }
    | undefined,
): IntrospectionQuery | null {
  const trpc = useTRPC()
  const environments = useQuery(trpc.environments.list.queryOptions()).data
  const usable =
    resource?.type === 'graphql' ? resource.environments.filter((e) => e.configured && e.level) : []
  const defaultId = environments?.find((e) => e.isDefault)?.id
  const environmentId = (usable.find((e) => e.environmentId === defaultId) ?? usable[0])?.environmentId
  const { data } = useQuery({
    ...trpc.resources.graphqlSchema.queryOptions({
      resourceId: resource?.id ?? '',
      environmentId: environmentId ?? '',
    }),
    enabled: !!resource && !!environmentId,
    staleTime: 5 * 60_000,
  })
  return data?.ok ? (data.schema as IntrospectionQuery) : null
}

/** Where the built-in GraphQL resource's query goes: its endpoint, sign-in and headers (session 57). */
export interface GraphqlApiTarget {
  url: string
  auth: unknown
  headers: unknown
}

export type GraphqlApiSchemaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; schema: IntrospectionQuery; types: number }
  | { status: 'failed'; message: string }

/**
 * The built-in GraphQL resource's schema for one query's endpoint (session 57), read when asked (Load schema), in
 * the default environment, with the query's URL, auth and headers. Its templates get the non-secret config vars and
 * `scope` (the playground's test values). Changing the URL, auth or headers asks again only on the next Load.
 */
export function useGraphqlApiSchema(
  resource: { id: string; type: string } | undefined,
  target: GraphqlApiTarget,
  scope: Record<string, unknown> = {},
): { state: GraphqlApiSchemaState; schema: IntrospectionQuery | null; load: () => void } {
  const trpc = useTRPC()
  const environments = useQuery(trpc.environments.list.queryOptions()).data
  const environmentId = environments?.find((e) => e.isDefault)?.id ?? environments?.[0]?.id
  const [asked, setAsked] = useState<{ key: string; refresh: boolean; target: GraphqlApiTarget } | null>(null)
  const key = JSON.stringify([target.url, target.auth, target.headers, scope])
  const enabled = resource?.type === 'graphqlapi' && !!environmentId && !!asked
  const input = {
    resourceId: resource?.id ?? '',
    environmentId: environmentId ?? '',
    query: asked?.target ?? target,
    scope,
    refresh: asked?.refresh ?? false,
  }
  const { data, isFetching, error } = useQuery({
    ...trpc.resources.graphqlApiSchema.queryOptions(input),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const load = () => setAsked({ key, refresh: asked?.key === key, target })
  let state: GraphqlApiSchemaState = { status: 'idle' }
  if (asked && isFetching) state = { status: 'loading' }
  else if (asked && error) state = { status: 'failed', message: error.message }
  else if (asked && data && !data.ok) state = { status: 'failed', message: data.error.message }
  else if (asked && data?.ok) {
    const schema = data.schema as IntrospectionQuery
    state = {
      status: 'loaded',
      schema,
      types: schema.__schema.types.filter((t) => !t.name.startsWith('__')).length,
    }
  }
  return { state, schema: state.status === 'loaded' ? state.schema : null, load }
}
