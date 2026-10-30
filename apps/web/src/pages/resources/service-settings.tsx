import { oauthPresets } from '@ow/connectors/oauth-presets'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Field, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { RedirectUri } from './oauth'
import { type FieldsProps, Grid, isSet } from './settings-forms'
import { type SecretEdit, SecretField } from './shared'

// The service resources' settings (M27): Slack, HubSpot and Google Sheets sign in with a token (or key) or M9's OAuth;
// SendGrid with an API key and its region.

type Auth = { type: string; clientId?: string; scope?: string; tokens?: string }

function SecretInput({
  props,
  name,
  label,
  hint,
  placeholder,
}: {
  props: FieldsProps
  name: string
  label: string
  hint?: string
  placeholder?: string
}) {
  return (
    <Field label={label} {...(hint && { hint })}>
      <SecretField
        isSet={isSet(props.secrets, name)}
        edit={props.edits[name] as SecretEdit}
        onChange={(e) => props.setEdit(name, e)}
        disabled={props.disabled}
        {...(placeholder && { placeholder })}
      />
    </Field>
  )
}

/** M9's sign-in for a service: the OAuth app's client id and secret, the scopes, and whose account it is. */
function OAuthApp({
  props,
  auth,
  preset,
  resourceId,
  scopeHint,
}: {
  props: FieldsProps
  auth: Auth
  preset: { label: string; consoleUrl: string; scope: string }
  resourceId: string
  scopeHint: string
}) {
  const setAuth = (patch: Partial<Auth>) => props.set('auth', { ...auth, ...patch })
  return (
    <div className="space-y-4">
      <Grid>
        <Field label="Client ID">
          <Input
            value={auth.clientId ?? ''}
            disabled={props.disabled}
            data-testid="oauth-client-id"
            onChange={(e) => setAuth({ clientId: e.target.value })}
          />
        </Field>
        <SecretInput props={props} name="clientSecret" label="Client secret" />
      </Grid>
      <Field label="Scopes" hint={scopeHint}>
        <Input
          value={auth.scope ?? preset.scope}
          disabled={props.disabled}
          onChange={(e) => setAuth({ scope: e.target.value })}
        />
      </Field>
      <Field label="Accounts">
        <Select
          value={auth.tokens ?? 'shared'}
          disabled={props.disabled}
          onChange={(e) => setAuth({ tokens: e.target.value })}
        >
          <option value="shared">One shared account per environment</option>
          <option value="perUser">Each person connects their own</option>
        </Select>
      </Field>
      <RedirectUri resourceId={resourceId} preset={preset} />
    </div>
  )
}

function SignIn({
  props,
  tokenLabel,
  children,
}: {
  props: FieldsProps
  tokenLabel: string
  children?: ReactNode
}) {
  const auth = (props.config.auth ?? { type: 'token' }) as Auth
  return (
    <Field label="Sign in with">
      <Select
        value={auth.type}
        disabled={props.disabled}
        data-testid="service-auth"
        onChange={(e) => props.set('auth', { type: e.target.value })}
      >
        <option value="token">{tokenLabel}</option>
        {children}
        <option value="oauth">OAuth sign-in (an app you register)</option>
      </Select>
    </Field>
  )
}

export function SlackFields(props: FieldsProps & { resourceId: string }) {
  const auth = (props.config.auth ?? { type: 'token' }) as Auth
  return (
    <>
      <SignIn props={props} tokenLabel="A bot or user token" />
      {auth.type === 'oauth' ? (
        <OAuthApp
          props={props}
          auth={auth}
          preset={oauthPresets.slack}
          resourceId={props.resourceId}
          scopeHint="Comma-separated bot scopes: chat:write to post, channels:read to list channels, files:write to upload, users:read(.email) for people."
        />
      ) : (
        <SecretInput
          props={props}
          name="token"
          label="Token"
          placeholder="xoxb-…"
          hint="From your Slack app’s OAuth & Permissions page. Invite the bot to the channels it posts in."
        />
      )}
    </>
  )
}

export function HubSpotFields(props: FieldsProps & { resourceId: string }) {
  const auth = (props.config.auth ?? { type: 'token' }) as Auth
  return (
    <>
      <SignIn props={props} tokenLabel="A private app’s access token" />
      {auth.type === 'oauth' ? (
        <OAuthApp
          props={props}
          auth={auth}
          preset={oauthPresets.hubspot}
          resourceId={props.resourceId}
          scopeHint="Space-separated; they must match the app’s scopes (crm.objects.contacts.read, crm.objects.deals.write, …)."
        />
      ) : (
        <SecretInput
          props={props}
          name="token"
          label="Access token"
          placeholder="pat-…"
          hint="Settings → Integrations → Private apps. Give it the CRM scopes your queries need."
        />
      )}
    </>
  )
}

export function SendGridFields(props: FieldsProps) {
  return (
    <>
      <SecretInput
        props={props}
        name="token"
        label="API key"
        placeholder="SG.…"
        hint="Settings → API Keys. Mail Send access is enough to send."
      />
      <Field label="Region" hint="EU for subusers pinned to the EU; their keys work only there.">
        <Select
          value={String(props.config.region ?? 'global')}
          disabled={props.disabled}
          data-testid="sendgrid-region"
          onChange={(e) => props.set('region', e.target.value)}
        >
          <option value="global">Global (api.sendgrid.com)</option>
          <option value="eu">EU (api.eu.sendgrid.com)</option>
        </Select>
      </Field>
    </>
  )
}

export function GoogleSheetsFields(props: FieldsProps & { resourceId: string }) {
  const trpc = useTRPC()
  const server = useQuery(trpc.resources.serverIdentity.queryOptions()).data
  const canChoose = !!server?.allowed && server.canChoose
  const auth = (props.config.auth ?? { type: 'serviceAccount' }) as Auth
  return (
    <>
      <Field label="Sign in with">
        <Select
          value={auth.type}
          disabled={props.disabled || (auth.type === 'server' && !canChoose)}
          data-testid="service-auth"
          onChange={(e) => props.set('auth', { type: e.target.value })}
        >
          <option value="serviceAccount">A service account key</option>
          <option value="server" disabled={!canChoose}>
            This server's Google identity
          </option>
          <option value="oauth">OAuth sign-in (a Google account)</option>
        </Select>
      </Field>
      {auth.type === 'serviceAccount' && (
        <>
          <SecretInput
            props={props}
            name="serviceAccountKey"
            label="Service account key"
            placeholder='{ "type": "service_account", … }'
            hint="The JSON key file. Share each spreadsheet with the service account’s email (as an editor to write)."
          />
          {server && !canChoose && (
            <p className="text-xs text-muted">
              {server.allowed
                ? "Only admins can choose this server's own Google identity."
                : "This instance doesn't let resources use its own Google identity (GOOGLE_SERVER_IDENTITY)."}
            </p>
          )}
        </>
      )}
      {auth.type === 'server' &&
        server &&
        (server.allowed ? (
          <div className="space-y-1 text-xs" data-testid="sheets-server-note">
            {server.identity && (
              <p className="text-muted">
                Signs in as <code className="text-ink">{server.identity}</code>: share spreadsheets with it.
              </p>
            )}
            {server.error && <p className="text-danger">{server.error}</p>}
            {!canChoose && <p className="text-muted">Chosen by an admin.</p>}
          </div>
        ) : (
          <p className="text-xs text-danger" data-testid="sheets-server-note">
            This instance doesn't let resources use its own Google identity (any more): choose a service
            account key.
          </p>
        ))}
      {auth.type === 'oauth' && (
        <OAuthApp
          props={props}
          auth={auth}
          preset={{
            ...oauthPresets.google,
            scope: `openid email https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file`,
          }}
          resourceId={props.resourceId}
          scopeHint="Space-separated. spreadsheets reads and writes every sheet the account can; drive.file lets it share the ones it creates."
        />
      )}
      <Field label="Test spreadsheet" hint="Optional: an id or URL Test connection opens, to check access.">
        <Input
          value={String(props.config.testSpreadsheet ?? '')}
          disabled={props.disabled}
          placeholder="https://docs.google.com/spreadsheets/d/…"
          onChange={(e) => props.set('testSpreadsheet', e.target.value || undefined)}
        />
      </Field>
    </>
  )
}
