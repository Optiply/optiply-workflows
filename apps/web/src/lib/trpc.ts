import type { AppRouter } from '@ow/server/trpc'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import superjson from 'superjson'

export type RouterOutputs = inferRouterOutputs<AppRouter>
export type RouterInputs = inferRouterInputs<AppRouter>

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>()

/** What the server says to someone whose access is apps only about anything but their apps (`APPS_ONLY_REFUSAL`). */
export const APPS_ONLY_REFUSAL = 'Your account can only use the apps shared with you'

let onAppsOnlyRefusal: (() => void) | null = null
/**
 * What to do when the server refuses someone as apps only: their access changed since `me` was read (an admin switched
 * it), so the page they're on isn't theirs any more. The router sets it (it knows where their apps are).
 */
export function setAppsOnlyRefusalHandler(handler: () => void) {
  onAppsOnlyRefusal = handler
}
const watchRefusal = (err: unknown) => {
  if (err instanceof TRPCClientError && err.data?.code === 'FORBIDDEN' && err.message === APPS_ONLY_REFUSAL)
    onAppsOnlyRefusal?.()
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: watchRefusal }),
  mutationCache: new MutationCache({ onError: watchRefusal }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => {
        const code = err instanceof TRPCClientError ? err.data?.code : undefined
        if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND') return false
        return count < 2
      },
    },
  },
})

export const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
})

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
