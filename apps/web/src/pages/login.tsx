import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Hourglass, KeyRound } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button, buttonVariants, Card, ErrorNote, Input, Label, Spinner } from '@/components/ui'
import { Wordmark } from '@/components/wordmark'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

const route = getRouteApi('/login')
const OIDC_START = '/api/auth/oidc/start'

export function LoginPage() {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { error: ssoError, pending } = route.useSearch()
  const { data: config, isLoading } = useQuery(trpc.authConfig.queryOptions())
  // Only the provider's sign-in (production: Optiply's Auth0) and nothing to tell the person: go straight there instead
  // of showing a page with one button. A waiting approval or a failed sign-in stays here, with its message and a button
  // to try again, so nobody bounces between this page and the provider without seeing why.
  const message = Boolean(pending || ssoError)
  const straightToProvider = Boolean(config?.oidcEnabled && !config.localLoginEnabled && !message)
  useEffect(() => {
    // replace: the browser's Back from the provider's page doesn't land here and get sent on again.
    if (straightToProvider) window.location.replace(OIDC_START)
  }, [straightToProvider])
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

  // Also while the settings load, so production doesn't flash the card before going on.
  if (isLoading || straightToProvider) {
    return (
      <div className="flex min-h-full items-center justify-center" data-testid="to-provider">
        <Spinner />
      </div>
    )
  }

  return (
    // A calm page with a soft glow of the brand's blue behind the card.
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_50%_-10%,color-mix(in_srgb,var(--color-accent)_14%,transparent),transparent_70%)]"
      />
      <div className="relative w-full max-w-sm motion-safe:animate-fade-in">
        <div className="mb-8 flex justify-center">
          <Wordmark size="lg" />
        </div>

        <Card className="space-y-5 rounded-2xl p-8 shadow-menu">
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted">to Optiply Workflows</p>
          </div>
          {pending ? (
            <div
              role="status"
              className="flex gap-3 rounded-xl border border-accent/30 bg-accent-soft/60 p-4 text-sm"
              data-testid="pending-approval"
            >
              <Hourglass className="mt-0.5 size-4 shrink-0 text-accent" />
              <div>
                <div className="font-medium">Waiting for an admin's approval</div>
                <p className="mt-0.5 text-muted">
                  Your request to use Optiply Workflows has reached the admins. Once one of them lets you in,
                  sign in again here.
                </p>
              </div>
            </div>
          ) : (
            <ErrorNote error={ssoError} />
          )}

          {config?.oidcEnabled && (
            <a
              href={OIDC_START}
              className={cn(buttonVariants({ variant: 'tertiary', size: 'lg' }), 'w-full text-ink')}
            >
              {config.oidcProvider === 'Google' ? <GoogleMark /> : <KeyRound className="size-4" />}
              {message && !config.localLoginEnabled
                ? 'Sign in again'
                : `Continue with ${config.oidcProvider}`}
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
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                loading={localLogin.isPending}
              >
                Sign in
              </Button>
            </form>
          )}

          {config && !config.oidcEnabled && !config.localLoginEnabled && (
            <p className="text-sm text-muted">
              No sign-in method is configured. Set <code>OIDC_ISSUER</code>/<code>OIDC_CLIENT_ID</code> or{' '}
              <code>LOCAL_LOGIN_ENABLED=true</code>.
            </p>
          )}
        </Card>
        {config?.oidcEnabled && (
          <p className="mt-5 text-center text-xs text-muted">
            @{config.allowedDomain} accounts and invited people can sign in; new accounts wait for an admin.
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
