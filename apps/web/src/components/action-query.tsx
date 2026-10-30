import {
  type ActionField,
  actionSpec,
  defaultActionQuery,
  SERVICE_ACTIONS,
  type ServiceType,
} from '@ow/connectors/actions'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Field, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

// The service resources' query forms (M27), drawn from `@ow/connectors/actions`: an action, then its fields. The same
// form in the workflow inspector, the playground and the app editor; each host brings its own code editor.

export interface CodeFieldProps {
  field: ActionField
  value: string
  onChange: (value: string) => void
  language: NonNullable<ActionField['language']>
  height: number
}

/** A new action keeps the fields it shares with the old one (the spreadsheet, the channel, the object). */
export function switchAction(
  type: ServiceType,
  query: Record<string, unknown>,
  action: string,
): Record<string, string> {
  const next = defaultActionQuery(type, action)
  for (const key of Object.keys(next)) {
    if (key !== 'action' && typeof query[key] === 'string' && query[key] !== '')
      next[key] = query[key] as string
  }
  return next
}

export function ActionQueryForm({
  type,
  query,
  onChange,
  code,
  disabled,
  lookup,
}: {
  type: ServiceType
  query: Record<string, unknown>
  /** A patch of fields, or (with `replace`) the whole query when the action changes. */
  onChange: (patch: Record<string, unknown>, replace?: boolean) => void
  /** The host's editor for long text and JSON fields. */
  code: (props: CodeFieldProps) => ReactNode
  disabled?: boolean
  /** Where to look things up for pickers (HubSpot's properties): the resource and environment, when known. */
  lookup?: { resourceId: string; environmentId: string } | undefined
}) {
  const action = typeof query.action === 'string' ? query.action : SERVICE_ACTIONS[type][0]!.id
  const spec = actionSpec(type, action)
  return (
    <div className="flex flex-col gap-4" data-testid={`action-query-${type}`}>
      <Field label="Action" {...(spec && { hint: spec.description })}>
        <Select
          value={action}
          disabled={disabled}
          data-testid="query-action"
          onChange={(e) => onChange(switchAction(type, query, e.target.value), true)}
        >
          {SERVICE_ACTIONS[type].map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </Select>
      </Field>
      {!spec && <p className="text-sm text-danger">Unknown action “{action}”: choose one.</p>}
      {spec?.fields.map((field) => {
        const value = typeof query[field.key] === 'string' ? (query[field.key] as string) : ''
        const set = (next: string) => onChange({ [field.key]: next })
        const label = field.required ? `${field.label} *` : field.label
        if (field.kind === 'long' || field.kind === 'json') {
          return (
            <Field key={field.key} label={label} {...(field.hint && { hint: field.hint })}>
              {code({
                field,
                value,
                onChange: set,
                language: field.kind === 'json' ? 'plaintext' : (field.language ?? 'plaintext'),
                height: field.kind === 'json' ? 120 : field.language === 'html' ? 200 : 100,
              })}
            </Field>
          )
        }
        if (field.kind === 'select' || field.kind === 'bool') {
          const options =
            field.kind === 'bool'
              ? [
                  { value: '', label: 'Default' },
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' },
                ]
              : (field.options ?? [])
          return (
            <Field key={field.key} label={label} {...(field.hint && { hint: field.hint })}>
              <Select
                value={value || (field.kind === 'select' ? (field.initial ?? '') : '')}
                disabled={disabled}
                data-testid={`query-field-${field.key}`}
                onChange={(e) => set(e.target.value)}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )
        }
        return (
          <Field key={field.key} label={label} {...(field.hint && { hint: field.hint })}>
            <Input
              className="font-mono"
              value={value}
              disabled={disabled}
              placeholder={field.placeholder ?? (field.kind === 'value' ? '{{ … }}' : undefined)}
              data-testid={`query-field-${field.key}`}
              onChange={(e) => set(e.target.value)}
            />
            {type === 'hubspot' && field.key === 'properties' && lookup && (
              <HubSpotPropertyHint lookup={lookup} objectType={String(query.objectType ?? '')} />
            )}
          </Field>
        )
      })}
    </div>
  )
}

/** The object type's property names, under a HubSpot properties field. */
function HubSpotPropertyHint({
  lookup,
  objectType,
}: {
  lookup: { resourceId: string; environmentId: string }
  objectType: string
}) {
  const trpc = useTRPC()
  const valid = /^[\w-]+$/.test(objectType)
  const { data } = useQuery({
    ...trpc.resources.hubspotProperties.queryOptions({ ...lookup, objectType }),
    enabled: valid,
    staleTime: 5 * 60_000,
  })
  if (!valid || !data?.ok) return null
  return (
    <span className="text-xs text-muted" data-testid="hubspot-properties">
      {objectType}:{' '}
      {data.properties
        .slice(0, 40)
        .map((p) => p.name)
        .join(', ')}
      {data.properties.length > 40 ? ', …' : ''}
    </span>
  )
}

type RequestAuth = {
  type: string
  token?: string
  username?: string
  password?: string
  in?: string
  name?: string
  value?: string
}

/** The built-in REST API resource's per-request sign-in (M27); every value a template. */
export function RequestAuthFields({
  auth,
  onChange,
  disabled,
  secretsHint,
}: {
  auth: RequestAuth | undefined
  onChange: (auth: RequestAuth) => void
  disabled?: boolean
  /** Where secrets come from here (workflows: secret config vars). */
  secretsHint?: string
}) {
  const current = auth ?? { type: 'none' }
  const set = (patch: Partial<RequestAuth>) => onChange({ ...current, ...patch })
  const text = (key: keyof RequestAuth, label: string, placeholder?: string) => (
    <Field label={label}>
      <Input
        className="font-mono"
        value={String(current[key] ?? '')}
        disabled={disabled}
        placeholder={placeholder}
        data-testid={`request-auth-${key}`}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </Field>
  )
  return (
    <div className="flex flex-col gap-3">
      <Field label="Authentication" {...(secretsHint && { hint: secretsHint })}>
        <Select
          value={current.type}
          disabled={disabled}
          data-testid="request-auth"
          onChange={(e) =>
            onChange(
              e.target.value === 'apiKey'
                ? { type: 'apiKey', in: 'header', name: 'X-API-Key', value: '' }
                : { type: e.target.value },
            )
          }
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
          <option value="apiKey">API key</option>
        </Select>
      </Field>
      {current.type === 'bearer' && text('token', 'Token', '{{ configVars.API_TOKEN }}')}
      {current.type === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          {text('username', 'Username')}
          {text('password', 'Password', '{{ configVars.API_PASSWORD }}')}
        </div>
      )}
      {current.type === 'apiKey' && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="Send in">
            <Select
              value={current.in ?? 'header'}
              disabled={disabled}
              onChange={(e) => set({ in: e.target.value })}
            >
              <option value="header">Header</option>
              <option value="query">Parameter</option>
            </Select>
          </Field>
          {text('name', 'Name', 'X-API-Key')}
          {text('value', 'Key', '{{ configVars.API_KEY }}')}
        </div>
      )}
    </div>
  )
}
