import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, GitBranch, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { SaveToBranchDialog } from '@/components/settings-git'
import { Button, Card, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { isSqlType } from '@/lib/resource-types'
import { useTRPC } from '@/lib/trpc'
import { S3Fields } from './aws-settings'
import { CustomAuthFields } from './custom-auth'
import { JdbcFields } from './jdbc-settings'
import { OAuthCodeFields, OAuthConnections } from './oauth'
import { OpenApiSpecFields } from './openapi-settings'
import { OverridesCard } from './overrides'
import { SDK_TEMPLATES, SdkFields } from './sdk-settings'
import {
  AirtableFields,
  AnthropicFields,
  GeminiFields,
  GmailFields,
  GoogleSheetsFields,
  HubSpotFields,
  JiraFields,
  NotionFields,
  OpenAiCompatibleFields,
  SalesforceFields,
  SendGridFields,
  SlackFields,
  StripeFields,
  TeamsFields,
} from './service-settings'
import {
  ConnectorErrorNote,
  type KeyValue,
  KeyValueEditor,
  type ResourceDetail,
  type SecretEdit,
  SecretField,
} from './shared'
import {
  type IapKeyInfo,
  type SshConfig,
  type SshEdits,
  type SshKeyInfo,
  SshTestSteps,
  SshTunnelFields,
} from './ssh-tunnel'

type Config = Record<string, unknown>
/** Secret edits by field; nested records nest (`headers: { name: edit }`, `ssh: { hopId: { privateKey: edit } }`). */
export type SecretEdits = { [key: string]: SecretEdit | SecretEdits }
export type Mask = Record<string, unknown> | null

const DEFAULTS: Record<string, Config> = {
  postgres: {
    host: '',
    port: 5432,
    database: '',
    user: '',
    ssl: 'prefer',
    poolSize: 5,
    readOnly: false,
    maxRows: 1_000_000,
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
    maxRows: 1_000_000,
    statementTimeoutMs: 120_000,
  },
  mssql: {
    host: '',
    port: 1433,
    database: '',
    auth: 'sql',
    user: '',
    ssl: 'require',
    poolSize: 5,
    readOnly: false,
    maxRows: 1_000_000,
    statementTimeoutMs: 120_000,
  },
  jdbc: {
    driver: 'oracle',
    mode: 'fields',
    oracleConnect: 'service',
    https: true,
    auth: 'password',
    user: '',
    wallet: false,
    properties: {},
    oauthTokens: 'perUser',
    readOnly: false,
    maxRows: 1_000_000,
    statementTimeoutMs: 120_000,
    poolSize: 5,
    tunnelHosts: [],
  },
  bigquery: {
    maximumBytesBilled: 10 * 1024 ** 3,
    maxRows: 1_000_000,
    statementTimeoutMs: 120_000,
    labels: {},
  },
  slack: { auth: { type: 'token' } },
  hubspot: { auth: { type: 'token' } },
  sendgrid: { region: 'global' },
  stripe: {},
  anthropic: { model: 'claude-sonnet-5-5', hidePrompts: false, fallback: true, allowPrivateNetwork: false },
  openai_compatible: { baseUrl: '', model: '', hidePrompts: false, allowPrivateNetwork: false },
  gemini: { platform: 'gemini', model: 'gemini-3.8-flash', hidePrompts: false, allowPrivateNetwork: false },
  airtable: {},
  jira: { siteUrl: '', deployment: 'cloud', allowPrivateNetwork: false },
  notion: {},
  salesforce: { domain: '', apiVersion: 'v62.0', auth: { type: 'oauth', clientId: '' } },
  googlesheets: { auth: { type: 'serviceAccount' } },
  gmail: { auth: { type: 'oauth' } },
  msteams: { auth: { type: 'oauth' } },
  sdk: {
    language: 'python',
    packages: [],
    allowedHosts: [],
    allowPrivateNetwork: false,
    options: {},
    setup: SDK_TEMPLATES.python,
    auth: { type: 'bearer' },
  },
  graphql: {
    baseUrl: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
    allowedHosts: [],
    allowPrivateNetwork: false,
    maxResponseBytes: 10 * 1024 * 1024,
  },
  s3: { region: 'eu-west-1', identity: 'key', forcePathStyle: false },
  rest: {
    baseUrl: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
    allowedHosts: [],
    allowPrivateNetwork: false,
    maxResponseBytes: 10 * 1024 * 1024,
  },
  openapi: {
    baseUrl: '',
    headers: [],
    params: [],
    auth: { type: 'none' },
    allowedHosts: [],
    allowPrivateNetwork: false,
    maxResponseBytes: 10 * 1024 * 1024,
    spec: '',
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
  /** Each IAP hop's stored service account key, as its account (M18). */
  iapKeys: Record<string, IapKeyInfo> | null
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
  const [savingToBranch, setSavingToBranch] = useState(false)
  // Protected (M22): the settings are Git's, so saving here changes the secrets only (sent with Git's settings).
  const fromGit = resource.gitProtected

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

  // An edit after saving: "Saved." no longer describes what's on screen.
  const props: FieldsProps = {
    config,
    set: (key, value) => {
      if (save.isSuccess) save.reset()
      setConfig((c) => ({ ...c, [key]: value }))
    },
    secrets: (stored?.secrets as Mask) ?? null,
    edits,
    setEdit: (key, edit) => {
      if (save.isSuccess) save.reset()
      setEdits((e) => ({ ...e, [key]: edit }))
    },
    disabled: !canEdit,
    sshKeys: (stored?.sshKeys as Record<string, SshKeyInfo> | null | undefined) ?? null,
    iapKeys: (stored?.iapKeys as Record<string, IapKeyInfo> | null | undefined) ?? null,
  }
  const request = { resourceId: resource.id, environmentId, config, secrets: buildPatch(edits) }
  const secretsOnly = { ...request, config: (stored?.config ?? {}) as Config }
  const changedHere =
    JSON.stringify(config) !== JSON.stringify({ ...DEFAULTS[resource.type], ...(stored?.config ?? {}) })
  // Trusted in Test connection but not saved yet (M17).
  const pins = (c: Config | null | undefined) =>
    JSON.stringify(((c?.ssh as SshConfig | undefined)?.hops ?? []).map((h) => h.hostKey ?? null))
  const unsavedTrust = !!config.ssh && pins(config) !== pins(stored?.config as Config | undefined)

  return (
    <div className="space-y-4">
      {!canEdit && (
        <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">
          You can use this resource here but not change its settings.
        </p>
      )}
      {!stored?.config && canEdit && !fromGit && (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
          Not configured in this environment yet. Fill in the settings and save.
        </p>
      )}
      {fromGit && (
        <p
          className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent"
          data-testid="settings-from-git"
        >
          {stored?.config
            ? 'These settings come from Git: change them with Save to branch. Secrets are this instance’s own and are saved here.'
            : 'Git has no settings for this environment: add them with Save to branch.'}
        </p>
      )}
      {stored?.needsSecrets && (
        <p
          className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-strong"
          data-testid="needs-secrets"
        >
          Deployed from Git without its secrets: fill them in for this environment and save.
        </p>
      )}
      <Card className="space-y-5 p-5">
        {resource.type === 'bigquery' ? (
          <BigQueryFields {...props} />
        ) : resource.type === 's3' ? (
          <S3Fields {...props} />
        ) : resource.type === 'slack' ? (
          <SlackFields {...props} resourceId={resource.id} />
        ) : resource.type === 'hubspot' ? (
          <HubSpotFields {...props} resourceId={resource.id} />
        ) : resource.type === 'sendgrid' ? (
          <SendGridFields {...props} />
        ) : resource.type === 'stripe' ? (
          <StripeFields {...props} />
        ) : resource.type === 'anthropic' ? (
          <AnthropicFields {...props} />
        ) : resource.type === 'openai_compatible' ? (
          <OpenAiCompatibleFields {...props} />
        ) : resource.type === 'gemini' ? (
          <GeminiFields {...props} />
        ) : resource.type === 'airtable' ? (
          <AirtableFields {...props} />
        ) : resource.type === 'jira' ? (
          <JiraFields {...props} />
        ) : resource.type === 'notion' ? (
          <NotionFields {...props} />
        ) : resource.type === 'salesforce' ? (
          <SalesforceFields {...props} resourceId={resource.id} />
        ) : resource.type === 'googlesheets' ? (
          <GoogleSheetsFields {...props} resourceId={resource.id} />
        ) : resource.type === 'gmail' ? (
          <GmailFields {...props} resourceId={resource.id} />
        ) : resource.type === 'msteams' ? (
          <TeamsFields {...props} resourceId={resource.id} />
        ) : resource.type === 'sdk' ? (
          <SdkFields {...props} resourceId={resource.id} />
        ) : resource.type === 'jdbc' ? (
          <JdbcFields {...props} resourceId={resource.id} />
        ) : isSqlType(resource.type) ? (
          <SqlFields {...props} type={resource.type} />
        ) : (
          <>
            <RestFields {...props} resourceId={resource.id} graphql={resource.type === 'graphql'} />
            {resource.type === 'openapi' && (
              <OpenApiSpecFields {...props} resourceId={resource.id} environmentId={environmentId} />
            )}
          </>
        )}
      </Card>
      {fromGit && stored?.config && (
        <OverridesCard resource={resource} environmentId={environmentId} canEdit={canEdit} />
      )}

      {canEdit && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {fromGit ? (
              <>
                <Button
                  variant="primary"
                  loading={save.isPending}
                  disabled={!stored?.config || !secretsOnly.secrets}
                  onClick={() => save.mutate(secretsOnly)}
                >
                  Save secrets
                </Button>
                <Button
                  disabled={!changedHere && !!stored?.config}
                  onClick={() => setSavingToBranch(true)}
                  data-testid="save-to-branch"
                >
                  <GitBranch className="size-4" /> Save to branch…
                </Button>
              </>
            ) : (
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(request)}>
                Save
              </Button>
            )}
            <Button loading={test.isPending} onClick={() => test.mutate(request)}>
              Test connection
            </Button>
            {stored?.config && !fromGit && (
              <Button
                variant="danger"
                className="ml-auto"
                loading={remove.isPending}
                onClick={async () => {
                  if (
                    await confirmDialog('Remove this environment’s settings and credentials?', {
                      danger: true,
                      confirm: 'Remove',
                    })
                  ) {
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
          {test.data?.ssh && (
            <SshTestSteps
              steps={test.data.ssh}
              hops={(config.ssh as SshConfig | undefined)?.hops ?? []}
              disabled={!canEdit}
              onTrust={(hop, hostKey) => {
                const ssh = config.ssh as SshConfig
                const next = {
                  ...config,
                  ssh: { hops: ssh.hops.map((h) => (h.id === hop ? { ...h, hostKey } : h)) },
                }
                setConfig(next)
                // Tried again with the key trusted: the next hop, or the resource itself.
                test.mutate({ ...request, config: next })
              }}
            />
          )}
          {unsavedTrust && test.data && (
            <p className="text-sm text-muted">Save to keep the trusted host key.</p>
          )}
          {test.data?.ok && (
            <p className="flex items-center gap-2 text-sm text-success">
              <CircleCheck className="size-4" /> Connected{test.data.message ? ` · ${test.data.message}` : ''}{' '}
              · {test.data.durationMs} ms
            </p>
          )}
          {/* A hop that failed shows its own error; anything else (the last SSH server couldn't reach the database, the
              database refused) shows here. */}
          {test.data && !test.data.ok && !test.data.ssh?.some((step) => !step.ok) && (
            <ConnectorErrorNote error={test.data.error} onConnected={() => test.mutate(request)} />
          )}
        </div>
      )}
      {stored?.config && <OAuthConnections resource={resource} environmentId={environmentId} />}
      {savingToBranch && (
        <SaveToBranchDialog
          kind="resource"
          object={resource}
          edit={{ configs: { [environmentId]: config } }}
          onClose={() => setSavingToBranch(false)}
        />
      )}
    </div>
  )
}

export const isSet = (secrets: Mask, key: string) => !!secrets && key in secrets
const num = (v: string) => (v === '' ? undefined : Number(v))

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
}

export function Checkbox({
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

/** The SSH tunnel section of a Postgres, MySQL, SQL Server, JDBC or REST resource's settings (M17). */
export function Tunnel({
  config,
  set,
  secrets,
  edits,
  setEdit,
  disabled,
  sshKeys,
  iapKeys,
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
      iapKeys={iapKeys}
      disabled={disabled}
      target={target}
    />
  )
}

/** Postgres, MySQL and SQL Server settings: the same fields, with each one's TLS modes and SQL Server's sign-ins. */
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
        {type === 'mssql' && (
          <Field
            label="Instance name"
            hint="A named instance (SQLEXPRESS): its port is looked up instead. Leave empty to use the port."
          >
            <Input
              value={String(config.instanceName ?? '')}
              disabled={disabled}
              data-testid="mssql-instance"
              onChange={(e) => set('instanceName', e.target.value.trim() || undefined)}
            />
          </Field>
        )}
        <Field label="Database">
          <Input {...text('database')} />
        </Field>
        {type === 'mssql' ? (
          <MssqlSignIn {...props} />
        ) : (
          <>
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
          </>
        )}
        <Field label={type === 'mssql' ? 'Encryption' : 'SSL'}>
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
        <Field
          label="Statement timeout (ms)"
          hint="For queries without a timeout of their own; a block's or query's timeout overrides it."
        >
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
        hint={
          type === 'mssql'
            ? 'Runs every query in a transaction that is always rolled back; a query that changes rows fails. A guard against mistakes; use a login with only db_datareader for security.'
            : `${
                type === 'mysql'
                  ? 'Makes the session read-only'
                  : 'Runs every query in a read-only transaction'
              }. A guard against mistakes; use a SELECT-only user for security.`
        }
      />
      <Tunnel {...props} target="the database" />
    </>
  )
}

/** How a SQL Server resource signs in (M38): a SQL login, a Windows account, or Entra ID (a user or an app). */
function MssqlSignIn({ config, set, secrets, edits, setEdit, disabled }: FieldsProps) {
  const auth = String(config.auth ?? 'sql')
  const text = (key: string, testId: string) => ({
    value: String(config[key] ?? ''),
    disabled,
    'data-testid': testId,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  })
  const secret = (key: 'password' | 'clientSecret') => (
    <SecretField
      isSet={isSet(secrets, key)}
      edit={edits[key] as SecretEdit}
      onChange={(e) => setEdit(key, e)}
      disabled={disabled}
    />
  )
  return (
    <>
      <Field label="Sign in with">
        <Select
          value={auth}
          disabled={disabled}
          data-testid="mssql-auth"
          onChange={(e) => set('auth', e.target.value)}
        >
          <option value="sql">SQL Server login</option>
          <option value="ntlm">Windows account (NTLM)</option>
          <option value="entra-password">Entra ID user and password</option>
          <option value="entra-service-principal">Entra ID app (service principal)</option>
        </Select>
      </Field>
      {auth === 'ntlm' && (
        <Field label="Windows domain">
          <Input {...text('domain', 'mssql-domain')} placeholder="CORP" />
        </Field>
      )}
      {auth !== 'entra-service-principal' && (
        <Field
          label={auth === 'entra-password' ? 'Entra user' : auth === 'ntlm' ? 'Windows user' : 'Login'}
          hint={
            auth === 'entra-password'
              ? 'name@yourcompany.com. Accounts that need MFA can’t sign in this way: use an app instead.'
              : 'For read-only use, connect as a login that only has db_datareader.'
          }
        >
          <Input {...text('user', 'mssql-user')} />
        </Field>
      )}
      {(auth === 'entra-password' || auth === 'entra-service-principal') && (
        <>
          <Field
            label="Entra app (client) id"
            hint={
              auth === 'entra-password'
                ? 'A public client app registered in your directory, allowed to sign users in with a password.'
                : 'The app registration whose service principal is a user in the database.'
            }
          >
            <Input {...text('clientId', 'mssql-client-id')} />
          </Field>
          <Field
            label="Directory (tenant) id"
            hint={
              auth === 'entra-password'
                ? 'Optional: your directory, if the user’s domain isn’t enough.'
                : undefined
            }
          >
            <Input {...text('tenantId', 'mssql-tenant-id')} />
          </Field>
        </>
      )}
      <Field label={auth === 'entra-service-principal' ? 'Client secret' : 'Password'}>
        {secret(auth === 'entra-service-principal' ? 'clientSecret' : 'password')}
      </Field>
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
        <Field
          label="Statement timeout (ms)"
          hint="The job is cancelled when it runs longer. A block's or query's own timeout overrides it."
        >
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

/** A REST resource's settings, and GraphQL's (M27), whose base URL is the endpoint queries are posted to. */
function RestFields(props: FieldsProps & { resourceId: string; graphql?: boolean }) {
  const { config, set, secrets, edits, setEdit, disabled, resourceId, graphql } = props
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
        label={graphql ? 'Endpoint URL' : 'Base URL'}
        hint={
          graphql
            ? 'Queries are posted here as JSON. Test connection fetches the schema for the editor.'
            : "Queries add a path to this; they can't reach other hosts unless allowed below."
        }
      >
        <Input
          value={String(config.baseUrl ?? '')}
          placeholder={graphql ? 'https://api.example.com/graphql' : 'https://api.example.com/v1'}
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
