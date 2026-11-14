import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
} from '@ow/connectors/ai-models'
import { oauthPresets } from '@ow/connectors/oauth-presets'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { Field, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { RedirectUri } from './oauth'
import { Checkbox, type FieldsProps, Grid, isSet } from './settings-forms'
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

/** Stripe (M29): a secret or restricted key, an optional API version pin and connected account. */
export function StripeFields(props: FieldsProps) {
  const text = (key: string) => ({
    value: String(props.config[key] ?? ''),
    disabled: props.disabled,
    onChange: (e: { target: { value: string } }) => props.set(key, e.target.value.trim() || undefined),
  })
  return (
    <>
      <SecretInput
        props={props}
        name="token"
        label="Secret key"
        placeholder="rk_live_… or sk_test_…"
        hint="Developers → API keys. A restricted key with only the rights your queries need is safer."
      />
      <Grid>
        <Field label="API version" hint="Optional: pins Stripe-Version (empty: the account's default).">
          <Input {...text('apiVersion')} placeholder="2025-01-27.acacia" data-testid="stripe-version" />
        </Field>
        <Field label="Connected account" hint="Optional: act as a Connect account (Stripe-Account).">
          <Input {...text('account')} placeholder="acct_…" data-testid="stripe-account" />
        </Field>
      </Grid>
    </>
  )
}

/** Airtable (M29): a personal access token and an optional default base. */
export function AirtableFields(props: FieldsProps) {
  return (
    <>
      <SecretInput
        props={props}
        name="token"
        label="Personal access token"
        placeholder="pat…"
        hint="airtable.com/create/tokens: the data.records and schema.bases scopes, on the bases your queries use."
      />
      <Field
        label="Default base"
        hint="Optional: queries that name no base use this one (app…, from the base's URL)."
      >
        <Input
          value={String(props.config.base ?? '')}
          disabled={props.disabled}
          placeholder="appXXXXXXXXXXXXXX"
          data-testid="airtable-base"
          onChange={(e) => props.set('base', e.target.value.trim() || undefined)}
        />
      </Field>
    </>
  )
}

/** Jira (M29): the site, Cloud (an email and API token) or Data Center (a personal access token). */
export function JiraFields(props: FieldsProps) {
  const cloud = (props.config.deployment ?? 'cloud') === 'cloud'
  return (
    <>
      <Grid>
        <Field
          label="Site URL"
          hint="Cloud: https://your-team.atlassian.net. Data Center: your Jira's address."
        >
          <Input
            value={String(props.config.siteUrl ?? '')}
            disabled={props.disabled}
            placeholder="https://optiply.atlassian.net"
            data-testid="jira-site"
            onChange={(e) => props.set('siteUrl', e.target.value.trim())}
          />
        </Field>
        <Field label="Jira">
          <Select
            value={cloud ? 'cloud' : 'datacenter'}
            disabled={props.disabled}
            data-testid="jira-deployment"
            onChange={(e) => props.set('deployment', e.target.value)}
          >
            <option value="cloud">Cloud</option>
            <option value="datacenter">Data Center / Server</option>
          </Select>
        </Field>
      </Grid>
      {cloud && (
        <Field label="Email" hint="The Atlassian account the API token belongs to.">
          <Input
            value={String(props.config.email ?? '')}
            disabled={props.disabled}
            placeholder="ops@optiply.nl"
            data-testid="jira-email"
            onChange={(e) => props.set('email', e.target.value.trim() || undefined)}
          />
        </Field>
      )}
      <SecretInput
        props={props}
        name="token"
        label={cloud ? 'API token' : 'Personal access token'}
        placeholder={cloud ? 'ATATT…' : ''}
        hint={
          cloud
            ? 'id.atlassian.com → Security → API tokens. It acts with the account’s permissions.'
            : 'Profile → Personal Access Tokens.'
        }
      />
      <Checkbox
        label="Allow a private network address"
        hint="For a Data Center site inside Optiply's network."
        checked={props.config.allowPrivateNetwork === true}
        disabled={props.disabled}
        onChange={(v) => props.set('allowPrivateNetwork', v)}
      />
    </>
  )
}

/** Notion (M29): an internal integration's token. */
export function NotionFields(props: FieldsProps) {
  return (
    <SecretInput
      props={props}
      name="token"
      label="Integration token"
      placeholder="ntn_…"
      hint="notion.so/profile/integrations → an internal integration. Share each page or database with it (••• → Connections)."
    />
  )
}

const SALESFORCE_APP = {
  label: 'Salesforce',
  consoleUrl: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm',
  scope: 'api refresh_token',
}

/**
 * Salesforce (M29): the org's My Domain URL, the API version, and a connected app: OAuth sign-in (M9; each
 * environment's account or each person's) or its client credentials flow (it runs as the app's Run As user).
 */
export function SalesforceFields(props: FieldsProps & { resourceId: string }) {
  const auth = (props.config.auth ?? { type: 'oauth' }) as Auth
  return (
    <>
      <Grid>
        <Field label="My Domain URL" hint="Setup → My Domain, e.g. https://optiply.my.salesforce.com">
          <Input
            value={String(props.config.domain ?? '')}
            disabled={props.disabled}
            placeholder="https://optiply.my.salesforce.com"
            data-testid="salesforce-domain"
            onChange={(e) => props.set('domain', e.target.value.trim())}
          />
        </Field>
        <Field label="API version">
          <Input
            value={String(props.config.apiVersion ?? 'v62.0')}
            disabled={props.disabled}
            onChange={(e) => props.set('apiVersion', e.target.value.trim() || undefined)}
          />
        </Field>
      </Grid>
      <Field label="Sign in with">
        <Select
          value={auth.type}
          disabled={props.disabled}
          data-testid="service-auth"
          onChange={(e) => props.set('auth', { type: e.target.value, clientId: auth.clientId ?? '' })}
        >
          <option value="oauth">OAuth sign-in (a connected app)</option>
          <option value="clientCredentials">Client credentials (a connected app's Run As user)</option>
        </Select>
      </Field>
      {auth.type === 'clientCredentials' ? (
        <Grid>
          <Field label="Consumer key">
            <Input
              value={auth.clientId ?? ''}
              disabled={props.disabled}
              data-testid="oauth-client-id"
              onChange={(e) => props.set('auth', { ...auth, clientId: e.target.value })}
            />
          </Field>
          <SecretInput props={props} name="clientSecret" label="Consumer secret" />
        </Grid>
      ) : (
        <OAuthApp
          props={props}
          auth={auth}
          preset={SALESFORCE_APP}
          resourceId={props.resourceId}
          scopeHint="Space-separated: api to call the API, refresh_token to stay signed in."
        />
      )}
    </>
  )
}

const appRoute = getRouteApi('/app')

/**
 * Gmail (M37): Google sign-in (one mailbox, shared or per person), or a Workspace service account with domain-wide
 * delegation acting as a default mailbox (admins only: it reaches every mailbox of the domain).
 */
export function GmailFields(props: FieldsProps & { resourceId: string }) {
  const { me } = appRoute.useRouteContext()
  const auth = (props.config.auth ?? { type: 'oauth' }) as Auth & { mailbox?: string }
  const delegation = auth.type === 'delegation'
  return (
    <>
      <Field label="Sign in with">
        <Select
          value={auth.type}
          disabled={props.disabled || (delegation && !me.isAdmin)}
          data-testid="service-auth"
          onChange={(e) => props.set('auth', { type: e.target.value })}
        >
          <option value="oauth">Google sign-in (one mailbox)</option>
          <option value="delegation" disabled={!me.isAdmin}>
            A Workspace service account (domain-wide delegation)
          </option>
        </Select>
      </Field>
      {delegation ? (
        <>
          <SecretInput
            props={props}
            name="serviceAccountKey"
            label="Service account key"
            placeholder='{ "type": "service_account", … }'
            hint="Its client id needs domain-wide delegation for https://www.googleapis.com/auth/gmail.modify (Workspace admin console → Security → API controls)."
          />
          <Field label="Mailbox" hint="The address queries act as unless they name another.">
            <Input
              value={auth.mailbox ?? ''}
              disabled={props.disabled}
              placeholder="support@optiply.nl"
              data-testid="gmail-mailbox"
              onChange={(e) => props.set('auth', { ...auth, mailbox: e.target.value.trim() || undefined })}
            />
          </Field>
          {!me.isAdmin && <p className="text-xs text-muted">Chosen by an admin.</p>}
        </>
      ) : (
        <>
          <OAuthApp
            props={props}
            auth={auth}
            preset={{
              ...oauthPresets.google,
              scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
            }}
            resourceId={props.resourceId}
            scopeHint="Space-separated. gmail.modify reads, labels, drafts and sends; gmail.readonly only reads."
          />
          {!me.isAdmin && (
            <p className="text-xs text-muted">
              Only admins can choose a service account with domain-wide delegation.
            </p>
          )}
        </>
      )}
    </>
  )
}

/**
 * Microsoft Teams (M37): Microsoft sign-in through an Entra ID app registration (its tenant, client id and secret;
 * delegated permissions), or a channel's Workflows webhook (posting only).
 */
export function TeamsFields(props: FieldsProps & { resourceId: string }) {
  const auth = (props.config.auth ?? { type: 'oauth' }) as Auth & { tenant?: string }
  return (
    <>
      <Field label="Sign in with">
        <Select
          value={auth.type}
          disabled={props.disabled}
          data-testid="service-auth"
          onChange={(e) => props.set('auth', { type: e.target.value })}
        >
          <option value="oauth">Microsoft sign-in (Graph: teams, channels, chats)</option>
          <option value="webhook">A channel’s Workflows webhook (posting only)</option>
        </Select>
      </Field>
      {auth.type === 'webhook' ? (
        <SecretInput
          props={props}
          name="webhookUrl"
          label="Webhook URL"
          placeholder="https://….logic.azure.com/workflows/…"
          hint="In the channel: ··· → Workflows → “Post to a channel when a webhook request is received”; copy its URL. Kept encrypted."
        />
      ) : (
        <>
          <Field
            label="Tenant"
            hint="Your Entra ID tenant id or domain (optiply.nl); organizations lets any work account sign in."
          >
            <Input
              value={auth.tenant ?? ''}
              disabled={props.disabled}
              placeholder="organizations"
              data-testid="teams-tenant"
              onChange={(e) => props.set('auth', { ...auth, tenant: e.target.value.trim() || undefined })}
            />
          </Field>
          <OAuthApp
            props={props}
            auth={auth}
            preset={{
              ...oauthPresets.microsoft,
              scope:
                'offline_access openid email User.Read User.ReadBasic.All Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send ChannelMessage.Read.All Chat.ReadWrite TeamMember.Read.All',
            }}
            resourceId={props.resourceId}
            scopeHint="Delegated Graph permissions, space-separated; keep offline_access. ChannelMessage.Read.All needs an admin’s consent."
          />
        </>
      )}
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

/**
 * A whole number or a price in a text box: what's typed stays as typed (`1.` on the way to `1.25`), the setting is its
 * value (empty: none). A setting changed elsewhere (another environment's) replaces the text.
 */
function NumberInput({
  props,
  name,
  integer,
  ...rest
}: {
  props: FieldsProps
  name: string
  integer: boolean
  placeholder: string
  'data-testid': string
}) {
  const stored = props.config[name] === undefined ? '' : String(props.config[name])
  const [text, setText] = useState(stored)
  const parse = (t: string) => {
    const n = integer ? Number.parseInt(t, 10) : Number(t)
    return t.trim() === '' || !Number.isFinite(n) ? undefined : n
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change from outside the box resets it
  useEffect(() => {
    if (parse(text) !== props.config[name]) setText(stored)
  }, [stored])
  return (
    <Input
      {...rest}
      value={text}
      disabled={props.disabled}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value)
        props.set(name, parse(e.target.value))
      }}
    />
  )
}

/** What both AI resources share (M35): the run's token budget, prompts kept out of run history, private networks. */
function AiCommonFields({ props, privateHint }: { props: FieldsProps; privateHint: string }) {
  return (
    <>
      <Field
        label="Token budget per run"
        hint="Input and output tokens a run's AI calls may use in all, across its blocks; a call is refused once they're spent. Empty: no limit."
      >
        <NumberInput props={props} name="budgetTokens" integer placeholder="200000" data-testid="ai-budget" />
      </Field>
      <Checkbox
        label="Hide prompts in run history"
        hint="The system prompt and prompt sent aren't kept with the run (for prompts holding personal data). Tokens and cost still are."
        checked={props.config.hidePrompts === true}
        disabled={props.disabled}
        onChange={(v) => props.set('hidePrompts', v)}
      />
      <Checkbox
        label="Allow a private network address"
        hint={privateHint}
        checked={props.config.allowPrivateNetwork === true}
        disabled={props.disabled}
        onChange={(v) => props.set('allowPrivateNetwork', v)}
      />
    </>
  )
}

/** Anthropic (M35): an API key, the default model, an optional base URL (a proxy), the budget and switches. */
export function AnthropicFields(props: FieldsProps) {
  return (
    <>
      <SecretInput
        props={props}
        name="apiKey"
        label="API key"
        placeholder="sk-ant-…"
        hint="console.anthropic.com → API keys. Kept encrypted; never sent to the browser."
      />
      <Grid>
        <Field
          label="Default model"
          hint="Blocks and queries that name no model use this one. Any model id works."
        >
          <Input
            value={String(props.config.model ?? '')}
            disabled={props.disabled}
            placeholder={DEFAULT_ANTHROPIC_MODEL}
            onChange={(e) => props.set('model', e.target.value.trim() || undefined)}
            list="anthropic-models"
            data-testid="ai-model"
          />
          <datalist id="anthropic-models">
            {ANTHROPIC_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Base URL"
          hint="Optional: a proxy or gateway in front of Anthropic's API (empty: api.anthropic.com)."
        >
          <Input
            value={String(props.config.baseUrl ?? '')}
            disabled={props.disabled}
            onChange={(e) => props.set('baseUrl', e.target.value.trim() || undefined)}
            placeholder="https://api.anthropic.com"
            data-testid="ai-base-url"
          />
        </Field>
      </Grid>
      <AiCommonFields props={props} privateHint="For a proxy inside Optiply's network." />
      <Checkbox
        label="Fall back on refusal"
        hint="When the model declines, Anthropic answers with its fallback model instead (on the models that offer it)."
        checked={props.config.fallback !== false}
        disabled={props.disabled}
        onChange={(v) => props.set('fallback', v)}
      />
    </>
  )
}

/**
 * Gemini (M37): the Gemini API with an API key, or Vertex AI in a Google Cloud project with a service account's key or
 * this server's Google identity (admins only); the default model, the budget and switches.
 */
export function GeminiFields(props: FieldsProps) {
  const trpc = useTRPC()
  const server = useQuery(trpc.resources.serverIdentity.queryOptions()).data
  const canChoose = !!server?.allowed && server.canChoose
  const platform = String(props.config.platform ?? 'gemini')
  const identity = String(props.config.identity ?? 'key')
  return (
    <>
      <Field
        label="Use"
        hint="Google AI Studio’s Gemini API, or Vertex AI in a Google Cloud project (billing and data stay there)."
      >
        <Select
          value={platform}
          disabled={props.disabled}
          data-testid="gemini-platform"
          onChange={(e) => {
            props.set('platform', e.target.value)
            // A base URL is one platform's: the other's paths differ.
            props.set('baseUrl', undefined)
          }}
        >
          <option value="gemini">Gemini API (AI Studio)</option>
          <option value="vertex">Vertex AI (a Google Cloud project)</option>
        </Select>
      </Field>
      {platform === 'gemini' ? (
        <SecretInput
          props={props}
          name="apiKey"
          label="API key"
          placeholder="AIza…"
          hint="aistudio.google.com → Get API key. Kept encrypted; never sent to the browser."
        />
      ) : (
        <>
          <Field label="Sign in with">
            <Select
              value={identity}
              disabled={props.disabled || (identity === 'server' && !canChoose)}
              data-testid="gemini-identity"
              onChange={(e) => props.set('identity', e.target.value)}
            >
              <option value="key">A service account key</option>
              <option value="server" disabled={!canChoose}>
                This server's Google identity
              </option>
            </Select>
          </Field>
          {identity === 'key' ? (
            <SecretInput
              props={props}
              name="serviceAccountKey"
              label="Service account key"
              placeholder='{ "type": "service_account", … }'
              hint="The JSON key file of a service account with the Vertex AI User role in the project."
            />
          ) : (
            server && (
              <div className="space-y-1 text-xs" data-testid="gemini-server-note">
                {server.allowed ? (
                  <>
                    {server.identity && (
                      <p className="text-muted">
                        Signs in as <code className="text-ink">{server.identity}</code>: it needs the Vertex
                        AI User role in the project.
                      </p>
                    )}
                    {server.error && <p className="text-danger">{server.error}</p>}
                    {!canChoose && <p className="text-muted">Chosen by an admin.</p>}
                  </>
                ) : (
                  <p className="text-danger">
                    This instance doesn't let resources use its own Google identity (any more): choose a
                    service account key.
                  </p>
                )}
              </div>
            )
          )}
          {identity === 'key' && server && !canChoose && (
            <p className="text-xs text-muted">
              {server.allowed
                ? "Only admins can choose this server's own Google identity."
                : "This instance doesn't let resources use its own Google identity (GOOGLE_SERVER_IDENTITY)."}
            </p>
          )}
          <Grid>
            <Field
              label="Project"
              hint={
                identity === 'server'
                  ? 'The Google Cloud project id (required).'
                  : "Optional: the key's own project when empty."
              }
            >
              <Input
                value={String(props.config.project ?? '')}
                disabled={props.disabled}
                placeholder="my-project"
                data-testid="gemini-project"
                onChange={(e) => props.set('project', e.target.value.trim() || undefined)}
              />
            </Field>
            <Field label="Region" hint="global, or a region such as europe-west4 (keeps data in the EU).">
              <Input
                value={String(props.config.location ?? '')}
                disabled={props.disabled}
                placeholder="global"
                data-testid="gemini-location"
                onChange={(e) => props.set('location', e.target.value.trim() || undefined)}
              />
            </Field>
          </Grid>
        </>
      )}
      <Grid>
        <Field
          label="Default model"
          hint="Blocks and queries that name no model use this one. Any model id works."
        >
          <Input
            value={String(props.config.model ?? '')}
            disabled={props.disabled}
            placeholder={DEFAULT_GEMINI_MODEL}
            onChange={(e) => props.set('model', e.target.value.trim() || undefined)}
            list="gemini-models"
            data-testid="ai-model"
          />
          <datalist id="gemini-models">
            {GEMINI_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Base URL"
          hint="Optional: a proxy or gateway in front of Google's API (empty: Google's)."
        >
          <Input
            value={String(props.config.baseUrl ?? '')}
            disabled={props.disabled}
            onChange={(e) => props.set('baseUrl', e.target.value.trim() || undefined)}
            placeholder={
              platform === 'gemini'
                ? 'https://generativelanguage.googleapis.com/v1beta'
                : 'https://aiplatform.googleapis.com/v1'
            }
            data-testid="ai-base-url"
          />
        </Field>
      </Grid>
      <AiCommonFields props={props} privateHint="For a proxy inside Optiply's network." />
    </>
  )
}

/** OpenAI-compatible (M35): the API's base URL, an optional key, the model, its prices, the budget and switches. */
export function OpenAiCompatibleFields(props: FieldsProps) {
  return (
    <>
      <Grid>
        <Field
          label="Base URL"
          hint="Up to /v1: https://api.openai.com/v1, Azure OpenAI's …/openai/v1, http://ollama:11434/v1."
        >
          <Input
            value={String(props.config.baseUrl ?? '')}
            disabled={props.disabled}
            onChange={(e) => props.set('baseUrl', e.target.value.trim())}
            placeholder="https://api.openai.com/v1"
            data-testid="ai-base-url"
          />
        </Field>
        <Field label="Model" hint="The model's id at that API (required).">
          <Input
            value={String(props.config.model ?? '')}
            disabled={props.disabled}
            onChange={(e) => props.set('model', e.target.value.trim())}
            placeholder="gpt-5.1"
            data-testid="ai-model"
          />
        </Field>
      </Grid>
      <SecretInput
        props={props}
        name="apiKey"
        label="API key"
        placeholder="sk-…"
        hint="Optional (a local model may need none). Kept encrypted; never sent to the browser."
      />
      <Grid>
        <Field label="Input price" hint="US dollars per million input tokens, for the cost. Empty: unknown.">
          <NumberInput
            props={props}
            name="inputPrice"
            integer={false}
            placeholder="1.25"
            data-testid="ai-input-price"
          />
        </Field>
        <Field label="Output price" hint="US dollars per million output tokens.">
          <NumberInput
            props={props}
            name="outputPrice"
            integer={false}
            placeholder="10"
            data-testid="ai-output-price"
          />
        </Field>
      </Grid>
      <AiCommonFields
        props={props}
        privateHint="For a model served inside Optiply's network (Ollama, vLLM)."
      />
    </>
  )
}
