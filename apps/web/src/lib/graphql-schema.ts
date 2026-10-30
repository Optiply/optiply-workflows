import { useQuery } from '@tanstack/react-query'
import type { IntrospectionQuery } from 'graphql'
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
