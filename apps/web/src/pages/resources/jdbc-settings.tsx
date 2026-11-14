import { JDBC_URL_TEMPLATES, type JdbcDriver, type JdbcUrlFields, jdbcUrl } from '@ow/connectors/jdbc-urls'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Field, Input, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { walletAliases } from '@/lib/wallet'
import { RedirectUri } from './oauth'
import { Checkbox, type FieldsProps, Grid, isSet, SecretRecord, Tunnel } from './settings-forms'
import { KeyValueEditor, type SecretEdit, SecretField } from './shared'

// A JDBC resource's settings (M38, docs/runbooks/jdbc.md): the driver, its connection as fields or a URL, its sign-in
// (a password; Snowflake's key pair or OAuth; Oracle's wallet), the driver's properties, the guards.

const LABELS: Record<Exclude<JdbcDriver, 'uploaded'>, string> = {
  oracle: 'Oracle',
  snowflake: 'Snowflake',
  clickhouse: 'ClickHouse',
}

const READ_ONLY_HINT: Record<JdbcDriver, string> = {
  oracle: 'Runs every query in a transaction that is always rolled back; a query that changes rows fails.',
  snowflake: 'Runs every query in a transaction that is always rolled back; a query that changes rows fails.',
  clickhouse: 'ClickHouse’s own readonly setting: the server refuses writes and schema changes.',
  uploaded:
    'A rolled-back transaction if the driver has them; otherwise the database user is the only guard.',
}

const num = (v: string) => (v === '' ? undefined : Number(v))

export function JdbcFields(props: FieldsProps & { resourceId: string }) {
  const { config, set, secrets, edits, setEdit, disabled, resourceId } = props
  const trpc = useTRPC()
  const drivers = useQuery(trpc.jdbcDrivers.list.queryOptions()).data ?? []
  const driver = (config.driver as JdbcDriver | undefined) ?? 'oracle'
  const builtIn = driver !== 'uploaded'
  const mode = builtIn ? ((config.mode as string | undefined) ?? 'fields') : 'url'
  const auth = (config.auth as string | undefined) ?? 'password'
  const fields = config as unknown as JdbcUrlFields
  const text = (key: string, testId?: string) => ({
    value: String(config[key] ?? ''),
    disabled,
    ...(testId ? { 'data-testid': testId } : {}),
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  })
  const number = (key: string) => ({
    type: 'number',
    value: config[key] === undefined ? '' : String(config[key]),
    disabled,
    onChange: (e: { target: { value: string } }) => set(key, num(e.target.value)),
  })
  const secret = (key: string) => (
    <SecretField
      isSet={isSet(secrets, key)}
      edit={edits[key] as SecretEdit}
      onChange={(e) => setEdit(key, e)}
      disabled={disabled}
    />
  )

  const chooseDriver = (value: string) => {
    if (value.startsWith('uploaded:')) {
      set('driver', 'uploaded')
      set('driverId', value.slice('uploaded:'.length))
      set('mode', 'url')
      if (!String(config.url ?? '').startsWith('jdbc:')) set('url', JDBC_URL_TEMPLATES.uploaded)
    } else {
      set('driver', value)
      set('driverId', undefined)
      if (!config.mode || driver === 'uploaded') set('mode', 'fields')
    }
    if (value !== 'snowflake') set('auth', 'password')
    if (value !== 'oracle') set('wallet', false)
    // Each driver's own default port (1521, 8443…), not the last one's.
    if (value !== driver) set('port', undefined)
  }

  const chooseMode = (next: string) => {
    // The URL mode starts from what the fields make, so switching doesn't lose them.
    if (next === 'url' && !String(config.url ?? '').trim()) set('url', jdbcUrl(fields))
    set('mode', next)
  }

  return (
    <>
      <Grid>
        <Field label="Driver">
          <Select
            value={builtIn ? driver : `uploaded:${String(config.driverId ?? '')}`}
            disabled={disabled}
            data-testid="jdbc-driver"
            onChange={(e) => chooseDriver(e.target.value)}
          >
            <optgroup label="Built in">
              {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((d) => (
                <option key={d} value={d}>
                  {LABELS[d]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Uploaded">
              {drivers.map((d) => (
                <option key={d.id} value={`uploaded:${d.id}`}>
                  {d.name}
                </option>
              ))}
              {!builtIn && !drivers.some((d) => d.id === config.driverId) && (
                <option value={`uploaded:${String(config.driverId ?? '')}`}>A driver that was deleted</option>
              )}
            </optgroup>
          </Select>
          {drivers.length === 0 && (
            <p className="mt-1 text-xs text-muted">
              Another database? An admin uploads its driver in{' '}
              <Link to="/settings/jdbc" className="text-accent hover:underline">
                Settings → JDBC drivers
              </Link>
              .
            </p>
          )}
        </Field>
        {builtIn && (
          <Field label="Connect with">
            <Select
              value={mode}
              disabled={disabled}
              data-testid="jdbc-mode"
              onChange={(e) => chooseMode(e.target.value)}
            >
              <option value="fields">Fields</option>
              <option value="url">A JDBC URL</option>
            </Select>
          </Field>
        )}
      </Grid>

      {mode === 'url' ? (
        <Field
          label="JDBC URL"
          hint={
            builtIn
              ? `Starts with ${JDBC_URL_TEMPLATES[driver].split('//')[0]}… Put passwords and keys in the sign-in or secret properties, not here.`
              : 'As the driver’s documentation writes it. Put passwords and keys in the sign-in or secret properties, not here.'
          }
        >
          <Input
            {...text('url', 'jdbc-url')}
            className="font-mono"
            placeholder={JDBC_URL_TEMPLATES[driver]}
          />
        </Field>
      ) : (
        <>
          <DriverFields {...props} driver={driver} text={text} number={number} />
          <p className="text-xs text-muted">
            Connects to{' '}
            <code className="break-all text-ink" data-testid="jdbc-url-preview">
              {jdbcUrl(fields)}
            </code>
          </p>
        </>
      )}

      <Grid>
        {driver === 'snowflake' && (
          <Field label="Sign in with">
            <Select
              value={auth}
              disabled={disabled}
              data-testid="jdbc-auth"
              onChange={(e) => set('auth', e.target.value)}
            >
              <option value="password">A password</option>
              <option value="keyPair">A key pair</option>
              <option value="oauth">Snowflake OAuth</option>
            </Select>
          </Field>
        )}
        {auth !== 'oauth' && (
          <Field label="User" hint="For read-only use, sign in as a user that can only read.">
            <Input {...text('user', 'jdbc-user')} />
          </Field>
        )}
        {auth === 'password' && <Field label="Password">{secret('password')}</Field>}
      </Grid>

      {auth === 'keyPair' && (
        <Grid>
          <Field
            label="Private key"
            hint="PEM (PKCS#8), the one whose public key is set on the Snowflake user."
          >
            {isSet(secrets, 'privateKey') && edits.privateKey === undefined ? (
              secret('privateKey')
            ) : (
              <Textarea
                rows={4}
                className="font-mono text-xs"
                placeholder="-----BEGIN PRIVATE KEY-----"
                value={String(edits.privateKey ?? '')}
                disabled={disabled}
                data-testid="jdbc-private-key"
                onChange={(e) => setEdit('privateKey', e.target.value)}
              />
            )}
          </Field>
          <Field label="Passphrase" hint="Only for an encrypted key.">
            {secret('privateKeyPassphrase')}
          </Field>
        </Grid>
      )}

      {auth === 'oauth' && (
        <div className="space-y-4">
          <Grid>
            <Field label="OAuth client id" hint="The security integration’s OAUTH_CLIENT_ID.">
              <Input {...text('oauthClientId', 'jdbc-oauth-client')} />
            </Field>
            <Field label="OAuth client secret">{secret('clientSecret')}</Field>
            <Field label="Whose account">
              <Select
                value={String(config.oauthTokens ?? 'perUser')}
                disabled={disabled}
                onChange={(e) => set('oauthTokens', e.target.value)}
              >
                <option value="perUser">Each person signs in as themselves</option>
                <option value="shared">One shared account for everyone</option>
              </Select>
            </Field>
          </Grid>
          <p className="text-xs text-muted">
            A Snowflake admin creates the OAuth app first:{' '}
            <code className="text-ink">
              CREATE SECURITY INTEGRATION … TYPE = OAUTH OAUTH_CLIENT = CUSTOM OAUTH_CLIENT_TYPE =
              'CONFIDENTIAL' OAUTH_REDIRECT_URI = '…' OAUTH_ISSUE_REFRESH_TOKENS = TRUE
            </code>{' '}
            with the redirect URI below, then reads the client id and secret with{' '}
            <code className="text-ink">SYSTEM$SHOW_OAUTH_CLIENT_SECRETS</code>. The role above is the one
            sessions take.
          </p>
          <RedirectUri resourceId={resourceId} />
        </div>
      )}

      {driver === 'oracle' && <WalletFields {...props} />}

      <Field label="Connection properties" hint="The driver’s own settings, as its documentation names them.">
        <KeyValueEditor
          rows={Object.entries((config.properties as Record<string, string> | undefined) ?? {}).map(
            ([key, value]) => ({
              key,
              value,
            }),
          )}
          onChange={(rows) =>
            set(
              'properties',
              Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])),
            )
          }
          disabled={disabled}
          keyPlaceholder="Property"
          valuePlaceholder="Value"
        />
      </Field>
      <SecretRecord
        field="properties"
        label="Secret connection properties"
        hint="Properties that are secrets (an API key, a token): stored encrypted, never shown again."
        namePlaceholder="Property"
        addLabel="Add a secret property"
        secrets={secrets}
        edits={edits}
        setEdit={setEdit}
        disabled={disabled}
      />

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
        hint={`${READ_ONLY_HINT[driver]} A guard against mistakes; for security, sign in as a user that can only read.`}
      />
      <Tunnel {...props} target="the database" />
      {!!config.ssh && <TunnelHosts {...props} />}
    </>
  )
}

/**
 * Which hosts the runner reaches through the tunnel (M38 step 4): `host:port`, as the URL writes them (TLS still checks
 * those names). The fields' own host is offered.
 */
function TunnelHosts({ config, set, disabled }: FieldsProps) {
  const hosts = (config.tunnelHosts as string[] | undefined) ?? []
  const [draft, setDraft] = useState(hosts.join('\n'))
  const fields = config as unknown as JdbcUrlFields
  const suggestion =
    config.mode !== 'url' && fields.host?.trim()
      ? `${fields.host.trim()}:${fields.port ?? (fields.driver === 'oracle' ? 1521 : fields.https === false ? 8123 : 8443)}`
      : null
  const save = (text: string) => {
    setDraft(text)
    set(
      'tunnelHosts',
      text
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean),
    )
  }
  return (
    <Field
      label="Hosts to reach through the tunnel"
      hint="host:port, one per line, as the URL writes them: the database's names stay as they are, so TLS still checks them. Several for a cluster (Oracle RAC, ClickHouse replicas)."
    >
      <Textarea
        rows={2}
        className="font-mono text-xs"
        value={draft}
        disabled={disabled}
        placeholder="db.internal:1521"
        data-testid="jdbc-tunnel-hosts"
        onChange={(e) => save(e.target.value)}
      />
      {suggestion && !hosts.includes(suggestion) && !disabled && (
        <button
          type="button"
          className="mt-1 text-xs text-accent hover:underline"
          data-testid="jdbc-tunnel-suggest"
          onClick={() => save([...hosts, suggestion].join('\n'))}
        >
          Add {suggestion}
        </button>
      )}
    </Field>
  )
}

function DriverFields({
  config,
  set,
  disabled,
  driver,
  text,
  number,
}: FieldsProps & {
  driver: JdbcDriver
  text: (key: string, testId?: string) => Record<string, unknown>
  number: (key: string) => Record<string, unknown>
}) {
  if (driver === 'snowflake') {
    return (
      <Grid>
        <Field label="Account identifier" hint="orgname-account, or the locator (xy12345.eu-west-1).">
          <Input {...text('account', 'jdbc-account')} placeholder="acme-prod" />
        </Field>
        <Field label="Warehouse">
          <Input {...text('warehouse', 'jdbc-warehouse')} />
        </Field>
        <Field label="Database">
          <Input {...text('database', 'jdbc-database')} />
        </Field>
        <Field label="Schema">
          <Input {...text('schema', 'jdbc-schema')} />
        </Field>
        <Field label="Role" hint="Optional: the user's default role otherwise.">
          <Input {...text('role', 'jdbc-role')} />
        </Field>
      </Grid>
    )
  }
  if (driver === 'clickhouse') {
    return (
      <>
        <Grid>
          <Field label="Host">
            <Input {...text('host', 'jdbc-host')} placeholder="abc123.eu-west-1.aws.clickhouse.cloud" />
          </Field>
          <Field label="Port" hint="Its HTTP interface: 8443 with HTTPS, 8123 without.">
            <Input {...number('port')} placeholder={config.https === false ? '8123' : '8443'} />
          </Field>
          <Field label="Database">
            <Input {...text('database', 'jdbc-database')} placeholder="default" />
          </Field>
        </Grid>
        <Checkbox
          checked={config.https !== false}
          disabled={disabled}
          onChange={(v) => set('https', v)}
          label="HTTPS"
          hint="Encrypt the connection (ClickHouse Cloud needs it)."
        />
      </>
    )
  }
  const connect = String(config.oracleConnect ?? 'service')
  return (
    <Grid>
      <Field label="Connect by">
        <Select
          value={connect}
          disabled={disabled}
          data-testid="jdbc-oracle-connect"
          onChange={(e) => set('oracleConnect', e.target.value)}
        >
          <option value="service">Service name</option>
          <option value="sid">SID</option>
          <option value="tns">A TNS alias (from a wallet)</option>
        </Select>
      </Field>
      {connect !== 'tns' && (
        <>
          <Field label="Host">
            <Input {...text('host', 'jdbc-host')} />
          </Field>
          <Field label="Port">
            <Input {...number('port')} placeholder="1521" />
          </Field>
        </>
      )}
      {connect === 'service' && (
        <Field label="Service name">
          <Input {...text('serviceName', 'jdbc-service')} placeholder="ORCLPDB1" />
        </Field>
      )}
      {connect === 'sid' && (
        <Field label="SID">
          <Input {...text('sid', 'jdbc-sid')} />
        </Field>
      )}
      {connect === 'tns' && (
        <Field label="TNS alias" hint="One of the wallet's tnsnames.ora entries (e.g. mydb_high).">
          <Input {...text('tnsAlias', 'jdbc-tns')} list="jdbc-tns-aliases" />
        </Field>
      )}
    </Grid>
  )
}

/** Oracle's wallet: the zip (stored encrypted), its password, and the TNS aliases it names, for the alias field. */
function WalletFields({ config, set, secrets, edits, setEdit, disabled }: FieldsProps) {
  const [aliases, setAliases] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const walletEdit = edits.wallet as SecretEdit
  return (
    <div className="space-y-3">
      <Checkbox
        checked={!!config.wallet}
        disabled={disabled}
        onChange={(v) => set('wallet', v)}
        label="Connect with a wallet"
        hint="For Autonomous Database and mTLS: the wallet zip from the console (cwallet.sso, tnsnames.ora, …)."
      />
      {!!config.wallet && (
        <Grid>
          <Field label="Wallet zip" hint="At most 1 MB; stored encrypted.">
            {isSet(secrets, 'wallet') && walletEdit === undefined ? (
              <SecretField
                isSet
                edit={walletEdit}
                onChange={(e) => setEdit('wallet', e)}
                disabled={disabled}
              />
            ) : (
              <div className="space-y-1">
                <input
                  type="file"
                  accept=".zip,application/zip"
                  disabled={disabled}
                  className="text-sm"
                  data-testid="jdbc-wallet-file"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    setProblem(null)
                    if (!file) return
                    if (file.size > 1024 * 1024) {
                      setProblem('A wallet is at most 1 MB')
                      return
                    }
                    const bytes = new Uint8Array(await file.arrayBuffer())
                    let binary = ''
                    for (const b of bytes) binary += String.fromCharCode(b)
                    setEdit('wallet', btoa(binary))
                    const found = await walletAliases(bytes)
                    setAliases(found)
                    if (found.length && !config.tnsAlias) set('tnsAlias', found[0])
                  }}
                />
                {walletEdit && (
                  <p className="text-xs text-muted" data-testid="jdbc-wallet-aliases">
                    {aliases.length
                      ? `Aliases: ${aliases.join(', ')}`
                      : 'No tnsnames.ora aliases found in it'}
                  </p>
                )}
                {problem && <p className="text-xs text-danger">{problem}</p>}
              </div>
            )}
          </Field>
          <Field label="Wallet password" hint="Only for a wallet without auto-login (ewallet.p12).">
            <SecretField
              isSet={isSet(secrets, 'walletPassword')}
              edit={edits.walletPassword as SecretEdit}
              onChange={(e) => setEdit('walletPassword', e)}
              disabled={disabled}
            />
          </Field>
        </Grid>
      )}
      <datalist id="jdbc-tns-aliases">
        {aliases.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </div>
  )
}
