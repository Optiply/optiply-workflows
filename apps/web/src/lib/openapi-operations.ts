import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'

export interface OpenApiParameterView {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  description?: string
  schema?: { type?: string | string[]; enum?: unknown[]; format?: string }
}

export interface OpenApiOperationView {
  id: string
  method: string
  path: string
  summary?: string
  description?: string
  tags: string[]
  deprecated?: boolean
  parameters: OpenApiParameterView[]
  body?: { required: boolean; contentTypes: string[]; example?: unknown }
}

/**
 * An OpenAPI resource's operations (M29), from its saved document in the given environment, or the default one (or
 * the first it's configured in and the viewer may use).
 */
export function useOpenApiOperations(
  resource:
    | {
        id: string
        type: string
        environments?: { environmentId: string; configured?: boolean; level?: string | null }[]
      }
    | undefined,
  environmentId?: string,
): { operations: OpenApiOperationView[]; title?: string; message?: string; loading: boolean } {
  const trpc = useTRPC()
  const environments = useQuery(trpc.environments.list.queryOptions()).data
  const usable =
    resource?.type === 'openapi' ? (resource.environments ?? []).filter((e) => e.configured && e.level) : []
  const defaultId = environments?.find((e) => e.isDefault)?.id
  const env = environmentId ?? (usable.find((e) => e.environmentId === defaultId) ?? usable[0])?.environmentId
  const { data, isLoading } = useQuery({
    ...trpc.resources.openapiOperations.queryOptions({
      resourceId: resource?.id ?? '',
      environmentId: env ?? '',
    }),
    enabled: !!resource && resource.type === 'openapi' && !!env,
    staleTime: 60_000,
  })
  if (!data) return { operations: [], loading: isLoading }
  if (!data.ok) return { operations: [], message: data.message, loading: false }
  return { operations: data.operations as OpenApiOperationView[], title: data.title, loading: false }
}
