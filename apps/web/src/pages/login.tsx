import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Workflow } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button, Card, ErrorNote, Input, Label, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

const route = getRouteApi('/login')

export function LoginPage() {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { error: ssoError } = route.useSearch()
  const { data: config, isLoading } = useQuery(trpc.authConfig.queryOptions())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const localLogin = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Sign-in failed')
    },
    onSuccess: async () => {
      // The route guard reads `me` from the cache (where it's still null), so refetch before navigating.
      await queryClient.fetchQuery({ ...trpc.me.queryOptions(), staleTime: 0 })
      await navigate({ to: '/' })
    },
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    localLogin.mutate()
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 rounded-xl bg-accent p-2.5 text-on-accent shadow-sm">
            <Workflow className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Optiply Workflows</h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>
        </div>

        <Card className="space-y-4 p-6">
          {isLoading && <Spinner />}
          <ErrorNote error={ssoError} />

          {config?.oidcEnabled && (
            <a
              href="/api/auth/oidc/start"
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-sm font-medium shadow-xs hover:bg-canvas"
            >
              <GoogleMark />
              Continue with Google
            </a>
          )}

          {config?.oidcEnabled && config.localLoginEnabled && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          {config?.localLoginEnabled && (
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <ErrorNote error={localLogin.error} />
              <Button type="submit" variant="primary" className="w-full" loading={localLogin.isPending}>
                Sign in
              </Button>
            </form>
          )}

          {config && !config.oidcEnabled && !config.localLoginEnabled && (
            <p className="text-sm text-muted">
              No sign-in method is configured. Set <code>OIDC_CLIENT_ID</code>/<code>OIDC_CLIENT_SECRET</code>{' '}
              or <code>LOCAL_LOGIN_ENABLED=true</code>.
            </p>
          )}
        </Card>
        {config?.oidcEnabled && (
          <p className="mt-4 text-center text-xs text-muted">
            Only @{config.allowedDomain} accounts can sign in.
          </p>
        )}
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.8A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M5.9 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.2a11 11 0 0 0 0 9.8l3.7-2.8z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3 .6 4.1 1.6l3.1-3.1A11 11 0 0 0 2.2 7.1l3.7 2.8C6.8 7.3 9.2 5.4 12 5.4z"
      />
    </svg>
  )
}
