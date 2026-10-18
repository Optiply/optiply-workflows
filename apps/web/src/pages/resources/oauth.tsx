import { fillPlaceholders, type OAuthProviderId, oauthPresets } from '@ow/connectors/oauth-presets'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, KeyRound } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Badge, Button, Card, Checkbox, CopyButton, ErrorNote, Field, Input, Select } from '@/components/ui'
import { connectAccount } from '@/lib/oauth'
import { useTRPC } from '@/lib/trpc'
import { type KeyValue, KeyValueEditor, type ResourceDetail } from './shared'

type Auth = { type: string; [key: string]: unknown }

const PROVIDER_ORDER: OAuthProviderId[] = ['custom', 'google', 'hubspot', 'slack', 'microsoft']
const providerLabel = (id: OAuthProviderId) => (id === 'custom' ? 'Other (custom)' : oauthPresets[id].label)

/** Reads a placeholder's current value back out of a filled-in URL (Microsoft's tenant). */
function placeholderValue(template: string, url: string, name: string): string {
  const [before, after] = template.split(`{${name}}`)
  if (before === undefined || after === undefined || !url.startsWith(before) || !url.endsWith(after))
    return ''
  const value = url.slice(before.length, url.length - after.length)
  try {
    return value.startsWith('{') ? '' : decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * The authorization-code settings in the REST form. Picking a provider fills in its URLs and suggestions (and the
 * base URL and allowed hosts when they're empty); everything stays editable.
 */
export function OAuthCodeFields({
  resourceId,
  config,
  set,
  auth,
  clientSecret,
  disabled,
}: {
  resourceId: string
  config: Record<string, unknown>
  set: (key: string, value: unknown) => void
  auth: Auth
  /** The client secret field (secret fields are the settings form's). */
  clientSecret: ReactNode
  disabled: boolean
}) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.resources.oauthConnections.queryOptions({ resourceId }))
  const provider = (auth.provider as OAuthProviderId | undefined) ?? 'custom'
  const preset = provider === 'custom' ? undefined : oauthPresets[provider]
  const setAuth = (patch: Partial<Auth>) => set('auth', { ...auth, ...patch })
  const text = (key: string) => String(auth[key] ?? '')

  const pickProvider = (id: OAuthProviderId) => {
    if (id === 'custom') return setAuth({ provider: 'custom' })
    const next = oauthPresets[id]
    const values = Object.fromEntries(next.placeholders.map((p) => [p.name, p.defaultValue]))
    set('auth', {
      ...auth,
      provider: id,
      authorizeUrl: fillPlaceholders(next.authorizeUrl, values),
      tokenUrl: fillPlaceholders(next.tokenUrl, values),
      scope: next.scope,
      authorizeParams: next.authorizeParams,
      pkce: next.pkce,
      clientAuth: next.clientAuth,
    })
    if (!String(config.baseUrl ?? '')) set('baseUrl', next.baseUrl)
    if (!((config.allowedHosts as string[] | undefined) ?? []).length && next.allowedHosts.length) {
      set('allowedHosts', next.allowedHosts)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-canvas/50 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Provider" hint={preset ? preset.hint : 'Any OAuth 2.0 provider (RFC 6749).'}>
          <Select
            value={provider}
            disabled={disabled}
            onChange={(e) => pickProvider(e.target.value as OAuthProviderId)}
          >
            {PROVIDER_ORDER.map((id) => (
              <option key={id} value={id}>
                {providerLabel(id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Accounts"
          hint={
            auth.tokens === 'perUser'
              ? 'Each person connects their own account. Workflows using it can’t be published.'
              : 'Someone with edit access connects one account; every query uses it.'
          }
        >
          <Select
            value={String(auth.tokens ?? 'shared')}
            disabled={disabled}
            onChange={(e) => setAuth({ tokens: e.target.value })}
          >
            <option value="shared">One shared account</option>
            <option value="perUser">Each person’s own account</option>
          </Select>
        </Field>
        {preset?.placeholders.map((p) => (
          <Field key={p.name} label={p.label}>
            <Input
              value={placeholderValue(preset.authorizeUrl, text('authorizeUrl'), p.name)}
              placeholder={p.defaultValue}
              disabled={disabled}
              onChange={(e) => {
                const values = { [p.name]: e.target.value.trim() }
                setAuth({
                  authorizeUrl: fillPlaceholders(preset.authorizeUrl, values),
                  tokenUrl: fillPlaceholders(preset.tokenUrl, values),
                })
              }}
            />
          </Field>
        ))}
        <Field label="Authorization URL">
          <Input
            value={text('authorizeUrl')}
            placeholder="https://auth.example.com/oauth/authorize"
            disabled={disabled}
            onChange={(e) => setAuth({ authorizeUrl: e.target.value })}
          />
        </Field>
        <Field label="Token URL">
          <Input
            value={text('tokenUrl')}
            placeholder="https://auth.example.com/oauth/token"
            disabled={disabled}
            onChange={(e) => setAuth({ tokenUrl: e.target.value })}
          />
        </Field>
        <Field label="Client ID">
          <Input
            value={text('clientId')}
            disabled={disabled}
            onChange={(e) => setAuth({ clientId: e.target.value })}
          />
        </Field>
        {clientSecret}
        <Field
          label="Scopes"
          hint={provider === 'slack' ? 'Comma-separated.' : 'Space-separated, as the provider names them.'}
          className="md:col-span-2"
        >
          <Input
            className="font-mono"
            value={text('scope')}
            disabled={disabled}
            onChange={(e) => setAuth({ scope: e.target.value })}
          />
        </Field>
      </div>
      <Field
        label="Extra consent screen parameters"
        hint="Added to the authorization URL, e.g. prompt=consent."
      >
        <KeyValueEditor
          rows={(auth.authorizeParams as KeyValue[] | undefined) ?? []}
          onChange={(rows) => setAuth({ authorizeParams: rows })}
          disabled={disabled}
          keyPlaceholder="Parameter"
        />
      </Field>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Field label="Send client secret">
          <Select
            value={String(auth.clientAuth ?? 'body')}
            disabled={disabled}
            onChange={(e) => setAuth({ clientAuth: e.target.value })}
          >
            <option value="body">In the request body</option>
            <option value="basic">As basic auth</option>
          </Select>
        </Field>
        <Checkbox
          className="h-8"
          checked={auth.pkce !== false}
          disabled={disabled}
          onChange={(e) => setAuth({ pkce: e.target.checked })}
          label="Use PKCE"
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Redirect URI</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 text-xs">
            {data?.redirectUri ?? '…'}
          </code>
          {data && <CopyButton text={data.redirectUri} label="Copy the redirect URI" />}
        </div>
        <p className="text-xs text-muted">
          Register it with the provider’s OAuth app
          {preset && (
            <>
              {' '}
              (
              <a
                href={preset.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                {preset.label} <ExternalLink className="size-3" />
              </a>
              )
            </>
          )}
          . It’s the same for every resource.
        </p>
      </div>
    </div>
  )
}

const reasonText = (reason: string | null) =>
  reason === 'settings_changed'
    ? 'The OAuth settings changed since it was connected.'
    : reason === 'expired'
      ? 'Its access ran out and the provider gave no way to renew it.'
      : `The provider no longer accepts it${reason ? ` (${reason})` : ''}.`

/**
 * The connected account in one environment: the shared one (connected by people with Edit), or on per-user
 * resources the viewer's own. Connecting uses the saved settings.
 */
export function OAuthConnections({
  resource,
  environmentId,
}: {
  resource: ResourceDetail
  environmentId: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const options = trpc.resources.oauthConnections.queryOptions({ resourceId: resource.id })
  const { data } = useQuery(options)
  const env = data?.environments.find((e) => e.environmentId === environmentId)
  const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey })
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const shared = env?.tokens === 'shared'
  const connect = useMutation({
    mutationFn: () =>
      connectAccount({ resourceId: resource.id, environmentId, account: shared ? 'shared' : 'mine' }),
    onSuccess: async (outcome) => {
      setMessage({ ok: outcome.ok, text: outcome.message })
      await refresh()
    },
  })
  const disconnect = useMutation(
    trpc.resources.oauthDisconnect.mutationOptions({
      onSuccess: async () => {
        setMessage(null)
        await refresh()
      },
    }),
  )
  if (!env?.tokens || !env.connection) return null

  const connection = env.connection
  const connected = connection.connected
  const needsReconnect = connection.connected && connection.status === 'reconnect'
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="flex-1 space-y-1">
          <h2 className="font-semibold">{shared ? 'Shared account' : 'Your account'}</h2>
          <p className="text-sm text-muted">
            {shared
              ? 'Every query in this environment, including workflows that run on their own, uses this account.'
              : 'Your queries here use your own account; everyone connects their own.'}
          </p>
        </div>
        {connection.connected ? (
          <Badge tone={needsReconnect ? 'danger' : 'success'}>
            {needsReconnect ? 'Needs reconnecting' : 'Connected'}
          </Badge>
        ) : (
          <Badge>Not connected</Badge>
        )}
      </div>

      {connection.connected && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Account</dt>
          <dd>{connection.account ?? 'Unknown (the provider didn’t say)'}</dd>
          <dt className="text-muted">Connected on</dt>
          <dd>{new Date(connection.connectedAt).toLocaleString()}</dd>
          {connection.scope && (
            <>
              <dt className="text-muted">Scopes</dt>
              <dd className="font-mono text-xs leading-5 break-all">{connection.scope}</dd>
            </>
          )}
        </dl>
      )}
      {needsReconnect && <p className="text-sm text-danger">{reasonText(connection.reason)}</p>}
      {env.connectedPeople !== null && (
        <p className="text-sm text-muted">
          {env.connectedPeople === 1 ? '1 person has' : `${env.connectedPeople} people have`} connected their
          own account here.
        </p>
      )}

      {env.canConnect ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate()}>
            {connected ? 'Reconnect' : shared ? 'Connect account' : 'Connect your account'}
          </Button>
          {connected && (
            <Button
              variant="danger"
              loading={disconnect.isPending}
              onClick={() => {
                if (
                  confirm(
                    shared
                      ? 'Disconnect the shared account? Queries will stop working until someone connects one.'
                      : 'Disconnect your account?',
                  )
                ) {
                  disconnect.mutate({
                    resourceId: resource.id,
                    environmentId,
                    account: shared ? 'shared' : 'mine',
                  })
                }
              }}
            >
              Disconnect
            </Button>
          )}
          <span className="text-xs text-muted">Connecting uses the saved settings.</span>
        </div>
      ) : (
        <p className="text-sm text-muted">
          Someone with edit access to this resource connects the shared account.
        </p>
      )}
      {message && (
        <p className={message.ok ? 'text-sm text-success' : 'text-sm text-danger'}>{message.text}</p>
      )}
      <ErrorNote error={disconnect.error} />
    </Card>
  )
}
