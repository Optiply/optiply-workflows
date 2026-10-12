import type { AppRouter } from '@ow/server/trpc'
import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import superjson from 'superjson'

export type RouterOutputs = inferRouterOutputs<AppRouter>

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>()

export const queryClient = new QueryClient({
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
