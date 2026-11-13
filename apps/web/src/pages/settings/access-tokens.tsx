import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { KeyRound, Plus } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

const appRoute = getRouteApi('/app')
type AccessToken = RouterOutputs['accessTokens']['list'][number]

/**
 * A user's personal access tokens (M33, docs/architecture.md §2.36), for the components CLI (`ow-components
 * login`). A token acts as its user within its scope; it's shown once. Admins can list and revoke everyone's.
 */
export function AccessTokensPage() {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [everyone, setEveryone] = useState(false)
  const input = { everyone: me.isAdmin && everyone }
  const { data: tokens, isLoading, error } = useQuery(trpc.accessTokens.list.queryOptions(input))
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.accessTokens.list.queryKey() })
  const revoke = useMutation(trpc.accessTokens.revoke.mutationOptions({ onSuccess: refresh }))

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Tokens let the components CLI (<code className="font-mono">ow-components</code>) act as you: it can
          read, edit, build and publish the component libraries you may, and nothing else. Keep a token like a
          password; revoke it when a machine no longer needs it.
        </p>
        <Button variant="primary" onClick={() => setCreating(!creating)}>
          <Plus className="size-4" /> New token
        </Button>
      </div>

      {created && <NewToken created={created} onDismiss={() => setCreated(null)} />}
      {creating && (
        <CreateToken
          onCreated={(token) => {
            setCreating(false)
            setCreated(token)
            refresh()
          }}
        />
      )}
      {me.isAdmin && (
        <Checkbox
          label="Everyone's tokens"
          checked={everyone}
          onChange={(e) => setEveryone(e.target.checked)}
        />
      )}
      <ErrorNote error={revoke.error ?? error} />

      {isLoading ? (
        <Spinner />
      ) : !tokens?.length ? (
        <EmptyState icon={<KeyRound className="size-6" />} title="No access tokens yet">
          Make one to sign the components CLI in.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              {input.everyone && <Th>User</Th>}
              <Th>Scope</Th>
              <Th>Last used</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} data-testid={`access-token-${t.name}`}>
                <Td>
                  <div className="font-medium">{t.name}</div>
                  <div className="font-mono text-xs text-muted">{t.prefix}…</div>
                </Td>
                {input.everyone && <Td className="text-xs">{t.userEmail}</Td>}
                <Td className="text-xs">{t.scopes.map(scopeLabel).join(', ')}</Td>
                <Td className="text-xs text-muted">
                  {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'Never'}
                </Td>
                <Td>
                  <TokenStatus token={t} />
                </Td>
                <Td className="w-24 text-right">
                  {!t.revokedAt && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (
                          await confirmDialog(`Revoke "${t.name}"? The CLI using it stops working at once.`, {
                            danger: true,
                            confirm: 'Revoke',
                          })
                        ) {
                          revoke.mutate({ id: t.id })
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}

function scopeLabel(scope: string): string {
  return scope === 'component-libraries' ? 'Component libraries' : scope
}

function TokenStatus({ token }: { token: AccessToken }) {
  if (token.revokedAt) return <Badge tone="danger">Revoked</Badge>
  if (token.expiresAt && new Date(token.expiresAt) <= new Date()) return <Badge>Expired</Badge>
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone="success">Active</Badge>
      {token.expiresAt && (
        <span className="text-xs text-muted">until {new Date(token.expiresAt).toLocaleDateString()}</span>
      )}
    </span>
  )
}

/** The token, once: it's stored only as a hash. */
function NewToken({
  created,
  onDismiss,
}: {
  created: { name: string; token: string }
  onDismiss: () => void
}) {
  return (
    <Card className="border-accent/40 bg-accent-soft/30 p-4" data-testid="new-access-token">
      <div className="mb-2 font-medium">“{created.name}” is ready. Copy it now: it won’t be shown again.</div>
      <div className="flex items-center gap-1 rounded-md border border-border bg-surface pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-sm" data-testid="new-access-token-value">
          {created.token}
        </code>
        <CopyButton text={created.token} label="Copy token" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Sign the CLI in with <code className="font-mono">ow-components login {window.location.origin}</code>{' '}
        and paste it when asked (or set <code className="font-mono">OW_URL</code> and{' '}
        <code className="font-mono">OW_TOKEN</code> in CI).
      </p>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={onDismiss}>
          I’ve copied it
        </Button>
      </div>
    </Card>
  )
}

const EXPIRIES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'A year' },
  { value: 'never', label: 'Never' },
] as const

function CreateToken({ onCreated }: { onCreated: (created: { name: string; token: string }) => void }) {
  const trpc = useTRPC()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<(typeof EXPIRIES)[number]['value']>('90')
  const create = useMutation(trpc.accessTokens.create.mutationOptions())
  return (
    <Card className="p-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          const expiresAt = expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86_400_000)
          create.mutate(
            { name, scopes: ['component-libraries'], expiresAt },
            { onSuccess: (made) => onCreated({ name: made.name, token: made.token }) },
          )
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint="Where it's used, e.g. my laptop, the components repo's CI.">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Expires">
            <Select
              aria-label="Expires"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as typeof expiry)}
            >
              {EXPIRIES.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox label="Component libraries (the components CLI)" checked disabled readOnly />
        <ErrorNote error={create.error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Create token
          </Button>
        </div>
      </form>
    </Card>
  )
}
