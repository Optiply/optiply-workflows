import { parseJsPackage, parseRequirement } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import CodeField from '@/components/code/code-field'
import { Field, Input, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { OAuthCodeFields } from './oauth'
import { Checkbox, type FieldsProps, Grid, isSet, SecretRecord } from './settings-forms'
import { type SecretEdit, SecretField } from './shared'

// SDK resources (M37, docs/architecture.md §2.41): the language and packages, where the SDK may connect, how it signs
// in, its options and secret values, and the setup code that makes the client (Monaco, a template per language).

export const SDK_TEMPLATES = {
  python: `# Makes the SDK's client. Any of these parameters may be left out.
#   token     the resource's token (pasted, OAuth client credentials, or the connected account's)
#   base_url  the resource's base URL
#   options   its options (JSON)
#   secrets   its secret values, by name
import acme_sdk


def client(token, base_url, options, secrets):
    return acme_sdk.Client(access_token=token, base_url=base_url)
`,
  javascript: `// Makes the SDK's client: { token, baseUrl, options, secrets } in, the client out (async works too).
//   token    the resource's token (pasted, OAuth client credentials, or the connected account's)
//   baseUrl  the resource's base URL
//   options  its options (JSON); secrets: its secret values, by name
import { Client } from 'acme-sdk'

export default ({ token, baseUrl, options, secrets }) => new Client({ token, baseUrl })
`,
} as const

type Language = keyof typeof SDK_TEMPLATES
type Auth = { type: string; [key: string]: unknown }

const appRoute = getRouteApi('/app')

/** Lines as a list (blank ones dropped) and back. */
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

export function SdkFields(props: FieldsProps & { resourceId: string }) {
  const { config, set, secrets, edits, setEdit, disabled, resourceId } = props
  const trpc = useTRPC()
  const { me } = appRoute.useRouteContext()
  const language = (config.language === 'javascript' ? 'javascript' : 'python') as Language
  const auth = (config.auth ?? { type: 'bearer' }) as Auth
  const setAuth = (patch: Partial<Auth>) => set('auth', { ...auth, ...patch })
  const indexes = useQuery({ ...trpc.pythonIndexes.list.queryOptions(), enabled: language === 'python' }).data

  const [packagesText, setPackagesText] = useState(
    ((config.packages as string[] | undefined) ?? []).join('\n'),
  )
  const [hostsText, setHostsText] = useState(((config.allowedHosts as string[] | undefined) ?? []).join('\n'))
  const [optionsText, setOptionsText] = useState(JSON.stringify(config.options ?? {}, null, 2))
  const [optionsError, setOptionsError] = useState<string | null>(null)
  // Another environment's settings replace the text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change from outside the boxes resets them
  useEffect(() => {
    setPackagesText(((config.packages as string[] | undefined) ?? []).join('\n'))
    setHostsText(((config.allowedHosts as string[] | undefined) ?? []).join('\n'))
    setOptionsText(JSON.stringify(config.options ?? {}, null, 2))
  }, [JSON.stringify([config.packages, config.allowedHosts, config.options])])

  const problems = lines(packagesText).flatMap((line) => {
    const parsed = language === 'python' ? parseRequirement(line) : parseJsPackage(line)
    return 'error' in parsed ? [`${line}: ${parsed.error}`] : []
  })
  const switchLanguage = (next: Language) => {
    set('language', next)
    // The other language's template, unless the setup code is the user's own.
    const setup = String(config.setup ?? '')
    if (!setup.trim() || setup === SDK_TEMPLATES[language]) set('setup', SDK_TEMPLATES[next])
  }
  const secret = (key: string, label: string, hint?: string) => (
    <Field label={label} {...(hint && { hint })}>
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
      <Grid>
        <Field label="Language" hint="The SDK runs in Python 3.12 or Node 24, in a jail of its own.">
          <Select
            value={language}
            disabled={disabled}
            data-testid="sdk-language"
            onChange={(e) => switchLanguage(e.target.value as Language)}
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </Select>
        </Field>
        {language === 'python' ? (
          <Field
            label="Package index"
            hint="Where pip finds the SDK: PyPI, or an admin's index (Settings → Python)."
          >
            <Select
              value={String(config.pythonIndex ?? '')}
              disabled={disabled}
              data-testid="sdk-python-index"
              onChange={(e) => set('pythonIndex', e.target.value || undefined)}
            >
              <option value="">The default index</option>
              {(indexes ?? []).map((i: { slug: string; name: string }) => (
                <option key={i.slug} value={i.slug}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field
            label="Registry"
            hint="npm uses the registries in Settings → npm registries, by scope (@acme/…)."
          >
            <p className="pt-1.5 text-sm text-muted">From Settings → npm registries</p>
          </Field>
        )}
      </Grid>
      <Field
        label="Packages"
        hint={
          language === 'python'
            ? 'One per line, as pip takes them: acme-sdk==1.4.2. Wheels only; installed when Test connection or a query first needs them.'
            : 'One per line, as npm takes them: acme-sdk@^2.1.0, @acme/sdk. No install scripts run; installed when Test connection or a query first needs them.'
        }
      >
        <Textarea
          rows={3}
          className="font-mono"
          value={packagesText}
          disabled={disabled}
          data-testid="sdk-packages"
          placeholder={language === 'python' ? 'acme-sdk==1.4.2' : 'acme-sdk@^2.1.0'}
          onChange={(e) => {
            setPackagesText(e.target.value)
            set('packages', lines(e.target.value))
          }}
        />
        {problems.map((p) => (
          <p key={p} className="mt-1 text-xs text-danger">
            {p}
          </p>
        ))}
      </Field>
      <Grid>
        <Field
          label="Base URL"
          hint="Given to the setup code; its host is the one the SDK may reach unless listed below."
        >
          <Input
            value={String(config.baseUrl ?? '')}
            disabled={disabled}
            placeholder="https://api.acme.com/v2"
            data-testid="sdk-base-url"
            onChange={(e) => set('baseUrl', e.target.value.trim() || undefined)}
          />
        </Field>
        <Field
          label="Allowed hosts"
          hint="One per line: api.acme.com, *.acme.com, host:8443. Empty: the base URL's host."
        >
          <Textarea
            rows={2}
            className="font-mono"
            value={hostsText}
            disabled={disabled}
            data-testid="sdk-hosts"
            onChange={(e) => {
              setHostsText(e.target.value)
              set(
                'allowedHosts',
                lines(e.target.value).map((h) => h.toLowerCase()),
              )
            }}
          />
        </Field>
      </Grid>
      <Checkbox
        label="Allow a private network address"
        hint={
          me.isAdmin
            ? 'The hosts may be inside Optiply’s network (admins only).'
            : 'Only admins can let an SDK reach the private network.'
        }
        checked={config.allowPrivateNetwork === true}
        disabled={disabled || !me.isAdmin}
        onChange={(v) => set('allowPrivateNetwork', v)}
      />

      <Field label="Sign in with" hint="The token the setup code gets.">
        <Select
          value={auth.type}
          disabled={disabled}
          data-testid="sdk-auth"
          onChange={(e) =>
            set('auth', {
              type: e.target.value,
              ...(e.target.value === 'oauth2ClientCredentials' ? { clientAuth: 'body' } : {}),
              ...(e.target.value === 'oauth2AuthorizationCode'
                ? { provider: 'custom', scope: '', authorizeParams: [], pkce: true, tokens: 'shared' }
                : {}),
            })
          }
        >
          <option value="bearer">A token (pasted)</option>
          <option value="oauth2ClientCredentials">OAuth 2.0 client credentials</option>
          <option value="oauth2AuthorizationCode">OAuth 2.0 sign-in (a connected account)</option>
          <option value="none">None</option>
        </Select>
      </Field>
      {auth.type === 'bearer' && (
        <Grid>{secret('bearerToken', 'Token', 'Kept encrypted; never sent to the browser.')}</Grid>
      )}
      {auth.type === 'oauth2ClientCredentials' && (
        <Grid>
          {authText('tokenUrl', 'Token URL', 'https://auth.acme.com/oauth/token')}
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

      <Field
        label="Options"
        hint="Plain settings for the setup code (JSON): a tenant, a region, a page size…"
      >
        <Textarea
          rows={3}
          className="font-mono"
          value={optionsText}
          disabled={disabled}
          data-testid="sdk-options"
          onChange={(e) => {
            setOptionsText(e.target.value)
            try {
              const parsed = JSON.parse(e.target.value || '{}')
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('An object')
              setOptionsError(null)
              set('options', parsed)
            } catch {
              setOptionsError('Options are a JSON object')
            }
          }}
        />
        {optionsError && <p className="mt-1 text-xs text-danger">{optionsError}</p>}
      </Field>
      <SecretRecord
        field="values"
        label="Secret values"
        hint="For the setup code as secrets.<name> (an API key besides the token, a signing secret). Encrypted, never shown again, removed from logs and results."
        namePlaceholder="Name"
        addLabel="Add secret value"
        secrets={secrets}
        edits={edits}
        setEdit={setEdit}
        disabled={disabled}
      />

      {/* A div, not a label: a label would send Monaco's clicks to its hidden textarea. */}
      <Field
        as="div"
        label="Setup code"
        hint={
          language === 'python'
            ? 'Defines client(...): returns the SDK’s client. It runs before every query; the network reaches only the allowed hosts, through a proxy the SDK must honour (requests, httpx and urllib do).'
            : 'Exports a default function returning the SDK’s client. It runs before every query; fetch and Node’s http go through a proxy to the allowed hosts only.'
        }
      >
        <div className="overflow-hidden rounded-md border border-border" data-testid="sdk-setup">
          <CodeField
            path={`resource-${resourceId}-sdk-setup-${language}.${language === 'python' ? 'py' : 'mjs'}`}
            language={language}
            value={String(config.setup ?? '')}
            onChange={(v) => set('setup', v)}
            height={260}
            readOnly={disabled}
          />
        </div>
      </Field>
      <p className="text-xs text-muted">
        Test connection installs the packages (the first time can take a minute), makes the client and
        describes it.
      </p>
    </>
  )
}
