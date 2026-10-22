import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button, Card, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { isSqlType } from '@/lib/resource-types'
import { useTRPC } from '@/lib/trpc'
import { CustomAuthFields } from './custom-auth'
import { OAuthCodeFields, OAuthConnections } from './oauth'
import {
  ConnectorErrorNote,
  type KeyValue,
  KeyValueEditor,
  type ResourceDetail,
  type SecretEdit,
  SecretField,
} from './shared'
import { type SshConfig, type SshEdits, type SshKeyInfo, SshTunnelFields } from './ssh-tunnel'

type Config = Record<string, unknown>
/** Secret edits by field; nested records nest (`headers: { name: edit }`, `ssh: { hopId: { privateKey: edit } }`). */
type SecretEdits = { [key: string]: SecretEdit | SecretEdits }
type Mask = Record<string, unknown> | null

const DEFAULTS: Record<string, Config> = {
  postgres: {
    host: '',
    port: 5432,
    database: '',
    user: '',
    ssl: 'prefer',
    poolSize: 5,
    readOnly: false,
    maxRows: 10_000,
    statementTimeoutMs: 120_000,
  },
  mysql: {
    host: '',
    port: 3306,
    database: '',
    user: '',
    ssl: 'require',
    poolSize: 5,
    readOnly: false,
    maxRows: 10_000,
    statementTimeoutMs: 120_000,
  },
  bigquery: {
    maximumBytesBilled: 10 * 1024 ** 3,
    maxRows: 10_000,
    statementTimeoutMs: 120_000,
    labels: {},
  },
  rest: {
    baseUrl: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
    allowedHosts: [],
    allowPrivateNetwork: false,
    maxResponseBytes: 10 * 1024 * 1024,
  },
}

/** Turns edits into the write-only patch the API expects: omitted = keep, null = clear, string = set. */
function buildPatch(edits: SecretEdits): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {}
  for (const [key, edit] of Object.entries(edits)) {
    if (edit === undefined || edit === '') continue
    if (edit !== null && typeof edit === 'object') {
      const nested = buildPatch(edit)
      if (nested) patch[key] = nested
    } else patch[key] = edit
  }
  return Object.keys(patch).length ? patch : undefined
}

export interface FieldsProps {
  config: Config
  set: (key: string, value: unknown) => void
  secrets: Mask
  edits: SecretEdits
  setEdit: (key: string, edit: SecretEdits[string]) => void
  disabled: boolean
  /** Each SSH hop's stored key, as the server describes it (M17). */
  sshKeys: Record<string, SshKeyInfo> | null
}

export function SettingsPanel({
  resource,
  environmentId,
  canEdit,
  onSaved,
}: {
  resource: ResourceDetail
  environmentId: string
  canEdit: boolean
  /** After a save (the page stays on Settings: a first save would otherwise switch it to Query). */
  onSaved?: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const stored = resource.environments.find((e) => e.environmentId === environmentId)
  const [config, setConfig] = useState<Config>(() => ({
    ...DEFAULTS[resource.type],
    ...(stored?.config ?? {}),
  }))
  const [edits, setEdits] = useState<SecretEdits>({})

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.resources.get.queryKey({ id: resource.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.resources.list.queryKey() }),
      // Saving other consent settings disconnects accounts.
      queryClient.invalidateQueries({
        queryKey: trpc.resources.oauthConnections.queryKey({ resourceId: resource.id }),
      }),
    ])
  const save = useMutation(
    trpc.resources.saveConfig.mutationOptions({
      onSuccess: async () => {
        setEdits({})
        onSaved?.()
        await refresh()
      },
    }),
  )
  const test = useMutation(trpc.resources.test.mutationOptions())
  const remove = useMutation(trpc.resources.deleteConfig.mutationOptions({ onSuccess: refresh }))

  const props: FieldsProps = {
    config,
    set: (key, value) => setConfig((c) => ({ ...c, [key]: value })),
    secrets: (stored?.secrets as Mask) ?? null,
    edits,
    setEdit: (key, edit) => setEdits((e) => ({ ...e, [key]: edit })),
    disabled: !canEdit,
    sshKeys: (stored?.sshKeys as Record<string, SshKeyInfo> | null | undefined) ?? null,
  }
  const request = { resourceId: resource.id, environmentId, config, secrets: buildPatch(edits) }

  return (
    <div className="space-y-4">
      {!canEdit && (
        <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">
          You can use this resource here but not change its settings.
        </p>
      )}
      {!stored?.config && canEdit && (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
          Not configured in this environment yet. Fill in the settings and save.
        </p>
      )}
      <Card className="space-y-5 p-5">
        {resource.type === 'bigquery' ? (
          <BigQueryFields {...props} />
        ) : isSqlType(resource.type) ? (
          <SqlFields {...props} type={resource.type} />
        ) : (
          <RestFields {...props} resourceId={resource.id} />
        )}
      </Card>

      {canEdit && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(request)}>
              Save
            </Button>
            <Button loading={test.isPending} onClick={() => test.mutate(request)}>
              Test connection
            </Button>
            {stored?.config && (
              <Button
                variant="danger"
                className="ml-auto"
                loading={remove.isPending}
                onClick={() => {
                  if (confirm('Remove this environment’s settings and credentials?')) {
                    remove.mutate({ resourceId: resource.id, environmentId })
                  }
                }}
              >
                Remove from this environment
              </Button>
            )}
          </div>
          <ErrorNote error={save.error ?? test.error ?? remove.error} />
          {save.isSuccess && !save.isPending && <p className="text-sm text-success">Saved.</p>}
          {test.data?.ok && (
            <p className="flex items-center gap-2 text-sm text-success">
              <CircleCheck className="size-4" /> Connected{test.data.message ? ` · ${test.data.message}` : ''}{' '}
              · {test.data.durationMs} ms
            </p>
          )}
          {test.data && !test.data.ok && (
            <ConnectorErrorNote error={test.data.error} onConnected={() => test.mutate(request)} />
          )}
        </div>
      )}
      {stored?.config && <OAuthConnections resource={resource} environmentId={environmentId} />}
    </div>
  )
}

const isSet = (secrets: Mask, key: string) => !!secrets && key in secrets
const num = (v: string) => (v === '' ? undefined : Number(v))

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
}

function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
  hint: string
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-accent"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  )
}

/** The SSH tunnel section of a Postgres, MySQL or REST resource's settings (M17). */
function Tunnel({
  config,
  set,
  secrets,
  edits,
  setEdit,
  disabled,
  sshKeys,
  target,
}: FieldsProps & { target: string }) {
  return (
    <SshTunnelFields
      ssh={config.ssh as SshConfig | undefined}
      onChange={(ssh) => set('ssh', ssh)}
      mask={secrets?.ssh as Record<string, Record<string, unknown>> | undefined}
      edits={edits.ssh as SshEdits | undefined}
      setEdits={(e) => setEdit('ssh', e)}
      keys={sshKeys}
      disabled={disabled}
      target={target}
    />
  )
}

/** Postgres and MySQL settings: the same fields, with each one's TLS modes. */
function SqlFields(props: FieldsProps & { type: string }) {
  const { config, set, secrets, edits, setEdit, disabled, type } = props
  const text = (key: string) => ({
    value: String(config[key] ?? ''),
    disabled,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  })
  const number = (key: string) => ({
    type: 'number',
    value: config[key] === undefined ? '' : String(config[key]),
    disabled,
    onChange: (e: { target: { value: string } }) => set(key, num(e.target.value)),
  })
  return (
    <>
      <Grid>
        <Field label="Host">
          <Input {...text('host')} placeholder="db.internal.optiply.nl" />
        </Field>
        <Field label="Port">
          <Input {...number('port')} />
        </Field>
        <Field label="Database">
          <Input {...text('database')} />
        </Field>
        <Field label="User" hint="For read-only use, connect as a user that only has SELECT.">
          <Input {...text('user')} />
        </Field>
        <Field label="Password">
          <SecretField
            isSet={isSet(secrets, 'password')}
            edit={edits.password as SecretEdit}
            onChange={(e) => setEdit('password', e)}
            disabled={disabled}
          />
        </Field>
        <Field label="SSL">
          <Select value={String(config.ssl)} disabled={disabled} onChange={(e) => set('ssl', e.target.value)}>
            {type === 'postgres' && <option value="prefer">Prefer (try TLS, fall back)</option>}
            <option value="require">Require (don't check the certificate)</option>
            <option value="verify-full">Verify certificate and hostname</option>
            <option value="disable">Disable</option>
          </Select>
        </Field>
      </Grid>
      {config.ssl === 'verify-full' && (
        <Field label="CA certificate (PEM)" hint="Only needed for a private certificate authority.">
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={String(config.caCert ?? '')}
            disabled={disabled}
            onChange={(e) => set('caCert', e.target.value || undefined)}
          />
        </Field>
      )}
      <Grid>
        <Field label="Max rows" hint="Queries returning more fail instead of loading everything.">
          <Input {...number('maxRows')} />
        </Field>
        <Field label="Statement timeout (ms)">
          <Input {...number('statementTimeoutMs')} />
        </Field>
        <Field label="Connection pool size">
          <Input {...number('poolSize')} />
        </Field>
      </Grid>
      <Checkbox
        checked={!!config.readOnly}
        disabled={disabled}
        onChange={(v) => set('readOnly', v)}
        label="Read-only"
        hint={`${
          type === 'mysql' ? 'Makes the session read-only' : 'Runs every query in a read-only transaction'
        }. A guard against mistakes; use a SELECT-only user for security.`}
      />
      <Tunnel {...props} target="the database" />
    </>
  )
}

const GIB = 1024 ** 3

function BigQueryFields({ config, set, secrets, edits, setEdit, disabled }: FieldsProps) {
  const text = (key: string) => ({
    value: String(config[key] ?? ''),
    disabled,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value || undefined),
  })
  const number = (key: string) => ({
    type: 'number',
    value: config[key] === undefined ? '' : String(config[key]),
    disabled,
    onChange: (e: { target: { value: string } }) => set(key, num(e.target.value)),
  })
  // Rows of their own, so a new (still empty) label doesn't vanish while it's typed; saved as an object.
  const [labels, setLabels] = useState<KeyValue[]>(() =>
    Object.entries((config.labels as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value })),
  )
  const bytes = config.maximumBytesBilled as number | undefined
  return (
    <>
      <Field
        label="Service account key"
        hint="Paste the service account's JSON key file. It needs the BigQuery Job User role, plus Data Viewer (or Editor) on the datasets it queries."
      >
        <SecretField
          isSet={isSet(secrets, 'serviceAccountKey')}
          edit={edits.serviceAccountKey as SecretEdit}
          onChange={(e) => setEdit('serviceAccountKey', e)}
          disabled={disabled}
          placeholder='{ "type": "service_account", … }'
        />
      </Field>
      <Grid>
        <Field label="Project" hint="Where queries run and are billed. Defaults to the key's project.">
          <Input {...text('projectId')} placeholder="optiply-analytics" />
        </Field>
        <Field
          label="Location"
          hint="Where jobs run, e.g. EU or europe-west4. Left empty, BigQuery picks it."
        >
          <Input {...text('location')} placeholder="EU" />
        </Field>
        <Field
          label="Default dataset"
          hint="For table names written without a dataset: dataset or project.dataset."
        >
          <Input {...text('defaultDataset')} placeholder="shop" />
        </Field>
        <Field
          label="Maximum bytes billed (GiB)"
          hint="A query that would bill more fails before it runs, at no cost."
        >
          <Input
            type="number"
            min={0}
            step="any"
            value={bytes === undefined ? '' : String(Math.round((bytes / GIB) * 1000) / 1000)}
            disabled={disabled}
            onChange={(e) => {
              const gib = num(e.target.value)
              set('maximumBytesBilled', gib === undefined ? undefined : Math.max(1, Math.round(gib * GIB)))
            }}
          />
        </Field>
        <Field label="Max rows" hint="Queries returning more fail instead of loading everything.">
          <Input {...number('maxRows')} />
        </Field>
        <Field label="Statement timeout (ms)" hint="The job is cancelled when it runs longer.">
          <Input {...number('statementTimeoutMs')} />
        </Field>
      </Grid>
      <Field
        label="Job labels"
        hint="Added to every job for cost reports, with the workflow, run and environment. Lowercase letters, digits, _ and -."
      >
        <KeyValueEditor
          rows={labels}
          onChange={(rows) => {
            setLabels(rows)
            set('labels', Object.fromEntries(rows.filter((r) => r.key).map((r) => [r.key, r.value])))
          }}
          disabled={disabled}
          keyPlaceholder="team"
          valuePlaceholder="operations"
        />
      </Field>
    </>
  )
}

type Auth = { type: string; [key: string]: unknown }

function RestFields(props: FieldsProps & { resourceId: string }) {
  const { config, set, secrets, edits, setEdit, disabled, resourceId } = props
  const auth = (config.auth ?? { type: 'none' }) as Auth
  const setAuth = (patch: Partial<Auth>) => set('auth', { ...auth, ...patch })
  const secret = (key: string, label: string) => (
    <Field label={label}>
      <SecretField
        isSet={isSet(secrets, key)}
        edit={edits[key] as SecretEdit}
        onChange={(e) => setEdit(key, e)}
        disabled={disabled}
      />
    </Field>
  )
  const authText = (key: string, label: string, placeholder?: string) => (
    <Field label={label}>
      <Input
        value={String(auth[key] ?? '')}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setAuth({ [key]: e.target.value || undefined })}
      />
    </Field>
  )
  return (
    <>
      <Field
        label="Base URL"
        hint="Queries add a path to this; they can't reach other hosts unless allowed below."
      >
        <Input
          value={String(config.baseUrl ?? '')}
          placeholder="https://api.example.com/v1"
          disabled={disabled}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      </Field>

      <Field label="Authentication">
        <Select
          value={auth.type}
          disabled={disabled}
          onChange={(e) =>
            set('auth', {
              type: e.target.value,
              ...(e.target.value === 'apiKey' ? { in: 'header', name: 'X-API-Key' } : {}),
              ...(e.target.value === 'oauth2AuthorizationCode'
                ? { provider: 'custom', scope: '', authorizeParams: [], pkce: true, tokens: 'shared' }
                : {}),
              ...(e.target.value === 'custom' ? { steps: [], refreshSteps: [] } : {}),
            })
          }
        >
          <option value="none">None</option>
          <option value="apiKey">API key</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
          <option value="oauth2ClientCredentials">OAuth 2.0 client credentials</option>
          <option value="oauth2AuthorizationCode">OAuth 2.0 sign-in (authorization code)</option>
          <option value="custom">Custom auth flow</option>
        </Select>
      </Field>
      {auth.type === 'apiKey' && (
        <Grid>
          <Field label="Send in">
            <Select
              value={String(auth.in ?? 'header')}
              disabled={disabled}
              onChange={(e) => setAuth({ in: e.target.value })}
            >
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </Select>
          </Field>
          {authText('name', 'Name', 'X-API-Key')}
          {secret('apiKey', 'API key')}
        </Grid>
      )}
      {auth.type === 'bearer' && <Grid>{secret('bearerToken', 'Token')}</Grid>}
      {auth.type === 'basic' && (
        <Grid>
          {authText('username', 'Username')}
          {secret('password', 'Password')}
        </Grid>
      )}
      {auth.type === 'oauth2AuthorizationCode' && (
        <OAuthCodeFields
          resourceId={resourceId}
          config={config}
          set={set}
          auth={auth}
          clientSecret={secret('clientSecret', 'Client secret')}
          disabled={disabled}
        />
      )}
      {auth.type === 'custom' && (
        <CustomAuthFields
          auth={auth}
          setAuth={setAuth}
          secrets={secrets}
          edits={edits}
          setEdit={setEdit}
          disabled={disabled}
        />
      )}
      {auth.type === 'oauth2ClientCredentials' && (
        <Grid>
          {authText('tokenUrl', 'Token URL', 'https://auth.example.com/oauth/token')}
          {authText('clientId', 'Client ID')}
          {secret('clientSecret', 'Client secret')}
          {authText('scope', 'Scope (optional)')}
          {authText('audience', 'Audience (optional)')}
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
        </Grid>
      )}

      <Field
        label="Headers"
        hint={
          auth.type === 'custom'
            ? 'Sent with every request; use the flow’s variables here, e.g. Authorization: Bearer {{ auth.token }}.'
            : 'Sent with every request. Put credentials in secret headers below instead.'
        }
      >
        <KeyValueEditor
          rows={(config.headers as KeyValue[]) ?? []}
          onChange={(rows) => set('headers', rows)}
          disabled={disabled}
          keyPlaceholder="Header"
        />
      </Field>
      <SecretRecord
        field="headers"
        label="Secret headers"
        hint="Values are encrypted and never shown again."
        namePlaceholder="Header name"
        addLabel="Add secret header"
        secrets={secrets}
        edits={edits}
        setEdit={setEdit}
        disabled={disabled}
      />
      <Field label="Query parameters" hint="Added to every request.">
        <KeyValueEditor
          rows={(config.params as KeyValue[]) ?? []}
          onChange={(rows) => set('params', rows)}
          disabled={disabled}
          keyPlaceholder="Parameter"
        />
      </Field>
      <Field
        label="Other allowed hosts"
        hint="One per line; *.example.com allows subdomains. Redirects are checked too."
      >
        <Textarea
          rows={2}
          className="font-mono"
          value={((config.allowedHosts as string[]) ?? []).join('\n')}
          disabled={disabled}
          onChange={(e) =>
            set(
              'allowedHosts',
              e.target.value
                .split('\n')
                .map((h) => h.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
      <Checkbox
        checked={!!config.allowPrivateNetwork}
        disabled={disabled}
        onChange={(v) => set('allowPrivateNetwork', v)}
        label="Allow private network addresses"
        hint="Off by default: requests to localhost, internal IPs and cloud metadata are blocked. Through an SSH tunnel they're allowed: what's reached is the SSH server's network."
      />
      <Tunnel {...props} target="the API" />
    </>
  )
}

/** Named secret values kept in one record of the secrets (`headers`, or a custom auth flow's `values`). */
export function SecretRecord({
  field,
  label,
  hint,
  namePlaceholder,
  addLabel,
  secrets,
  edits,
  setEdit,
  disabled,
}: Pick<FieldsProps, 'secrets' | 'edits' | 'setEdit' | 'disabled'> & {
  field: string
  label: string
  hint: string
  namePlaceholder: string
  addLabel: string
}) {
  const stored = Object.keys((secrets?.[field] as Record<string, unknown>) ?? {})
  const recordEdits = (edits[field] as Record<string, SecretEdit>) ?? {}
  const names = [...new Set([...stored, ...Object.keys(recordEdits)])]
  const [name, setName] = useState('')
  const setOne = (key: string, edit: SecretEdit) => setEdit(field, { ...recordEdits, [key]: edit })
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-2">
        {names.map((key) => (
          <div key={key} className="flex items-center gap-3">
            <span className="w-48 truncate font-mono text-sm">{key}</span>
            <div className="flex-1">
              <SecretField
                isSet={stored.includes(key)}
                edit={recordEdits[key]}
                onChange={(e) => setOne(key, e)}
                disabled={disabled}
              />
            </div>
          </div>
        ))}
        {!disabled && (
          <div className="flex gap-2">
            <Input
              className="font-mono"
              placeholder={namePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!name.trim()}
              onClick={() => {
                setOne(name.trim(), '')
                setName('')
              }}
            >
              <Plus className="size-4" /> {addLabel}
            </Button>
          </div>
        )}
      </div>
    </Field>
  )
}
