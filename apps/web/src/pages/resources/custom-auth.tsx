import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { CustomSignInDialog } from '@/components/custom-sign-in'
import { type MultipartPart, MultipartParts } from '@/components/multipart-parts'
import { Badge, Button, Card, Checkbox, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { type FieldsProps, SecretRecord } from './settings-forms'
import { type KeyValue, KeyValueEditor, type ResourceDetail } from './shared'

type Auth = { type: string; [key: string]: unknown }
type Body =
  | { type: 'none' }
  | { type: 'json'; json: string }
  | { type: 'form'; fields: KeyValue[] }
  | { type: 'raw'; raw: string; contentType?: string }
  | { type: 'multipart'; parts: MultipartPart[] }
type Step =
  | {
      type: 'request'
      name: string
      method: string
      path: string
      params: KeyValue[]
      headers: KeyValue[]
      body: Body
    }
  | { type: 'code'; name: string; code: string }
  | { type: 'variable'; name: string; value: string; secret?: boolean }
  | { type: 'form'; name: string; title: string; fields: FormField[] }
type FormField = { name: string; label: string; kind: 'text' | 'password' }

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** A name no other step uses yet: `login`, `login2`, … */
function freeName(steps: Step[], base: string): string {
  const taken = new Set(steps.map((s) => s.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`
}

function newStep(type: Step['type'], name: string): Step {
  switch (type) {
    case 'request':
      return {
        type,
        name,
        method: 'POST',
        path: '',
        params: [],
        headers: [],
        body: { type: 'json', json: '{}' },
      }
    case 'code':
      return { type, name, code: 'return ' }
    case 'variable':
      return { type, name, value: '', secret: true }
    case 'form':
      return {
        type,
        name,
        title: '',
        fields: [
          { name: 'username', label: 'Username', kind: 'text' },
          { name: 'password', label: 'Password', kind: 'password' },
        ],
      }
  }
}

const DEFAULT_NAMES: Record<Step['type'], string> = {
  request: 'login',
  code: 'result',
  variable: 'token',
  form: 'signin',
}
const STEP_LABELS: Record<Step['type'], string> = {
  request: 'Request',
  code: 'Code',
  variable: 'Variable',
  form: 'Form',
}

/**
 * A custom auth flow: secret values, the sign-in steps, optional refresh steps and how long the variables last.
 * The variables are used in the resource's headers and query parameters (below this in the form) as
 * `{{ auth.NAME }}`.
 */
export function CustomAuthFields({
  auth,
  setAuth,
  secrets,
  edits,
  setEdit,
  disabled,
}: { auth: Auth; setAuth: (patch: Partial<Auth>) => void } & Pick<
  FieldsProps,
  'secrets' | 'edits' | 'setEdit' | 'disabled'
>) {
  const ttl = auth.ttlSeconds as number | undefined
  return (
    <div className="space-y-5 rounded-lg border border-border bg-canvas/50 p-4">
      <p className="text-sm text-muted">
        Signs in with your own steps. Each <strong>variable</strong> becomes{' '}
        <code className="text-xs">{'{{ auth.NAME }}'}</code>, for the headers and query parameters below.
        Steps read secret values as <code className="text-xs">{'{{ secrets.NAME }}'}</code> and earlier steps
        by their name (a request’s <code className="text-xs">data</code>,{' '}
        <code className="text-xs">status</code> and <code className="text-xs">headers</code>).
      </p>
      <SecretRecord
        field="values"
        label="Secret values"
        hint="Encrypted and never shown again."
        namePlaceholder="password"
        addLabel="Add secret value"
        secrets={secrets}
        edits={edits}
        setEdit={setEdit}
        disabled={disabled}
      />
      <StepsEditor
        label="Sign-in steps"
        hint="A Form step asks each person for their own details (e.g. {{ signin.username }}): the variables are then each person's own, and workflows that run on their own can't use the resource."
        steps={(auth.steps as Step[] | undefined) ?? []}
        onChange={(steps) => setAuth({ steps })}
        disabled={disabled}
        allowForm
      />
      <StepsEditor
        label="Refresh steps"
        hint="Optional. Run when an API answers 401, with auth holding the current variables; the request is then retried once. Without them (or if they fail), the sign-in steps run again."
        steps={(auth.refreshSteps as Step[] | undefined) ?? []}
        onChange={(refreshSteps) => setAuth({ refreshSteps })}
        disabled={disabled}
      />
      <Field
        label="Sign in again after (seconds)"
        hint="Optional. Without it, the variables last until an API answers 401."
      >
        <Input
          type="number"
          min={1}
          className="max-w-48"
          value={ttl === undefined ? '' : String(ttl)}
          disabled={disabled}
          onChange={(e) =>
            setAuth({ ttlSeconds: e.target.value === '' ? undefined : Number(e.target.value) })
          }
        />
      </Field>
    </div>
  )
}

function StepsEditor({
  label,
  hint,
  steps,
  onChange,
  disabled,
  allowForm = false,
}: {
  label: string
  hint?: string
  steps: Step[]
  onChange: (steps: Step[]) => void
  disabled: boolean
  /** Sign-in steps may ask for a form; refresh steps run with nobody there to fill one in. */
  allowForm?: boolean
}) {
  const types: Step['type'][] = allowForm
    ? ['request', 'code', 'variable', 'form']
    : ['request', 'code', 'variable']
  const prefix = label.split(' ')[0]!
  const update = (i: number, step: Step) => onChange(steps.map((s, j) => (i === j ? step : s)))
  const move = (i: number, by: number) => {
    const next = [...steps]
    const [step] = next.splice(i, 1)
    next.splice(i + by, 0, step!)
    onChange(next)
  }
  return (
    <section className="space-y-2" aria-label={label}>
      <div>
        <h3 className="text-sm font-medium">{label}</h3>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {steps.map((step, i) => {
        const at = `${prefix} step ${i + 1}`
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are edited in place; names change as people type
          <div key={i} className="space-y-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{i + 1}</Badge>
              <Select
                aria-label={`${at} kind`}
                className="w-36"
                value={step.type}
                disabled={disabled}
                onChange={(e) => update(i, newStep(e.target.value as Step['type'], step.name))}
              >
                {types.map((type) => (
                  <option key={type} value={type}>
                    {STEP_LABELS[type]}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`${at} name`}
                className="w-48 font-mono"
                value={step.name}
                disabled={disabled}
                onChange={(e) => update(i, { ...step, name: e.target.value })}
              />
              {!disabled && (
                <div className="ml-auto flex">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Move down"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title={`Remove ${at.toLowerCase()}`}
                    onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </div>
            {step.type === 'request' && (
              <RequestStep at={at} step={step} onChange={(s) => update(i, s)} disabled={disabled} />
            )}
            {step.type === 'code' && (
              <Textarea
                aria-label={`${at} code`}
                rows={4}
                className="font-mono"
                value={step.code}
                disabled={disabled}
                onChange={(e) => update(i, { ...step, code: e.target.value })}
              />
            )}
            {step.type === 'form' && (
              <FormStep at={at} step={step} onChange={(s) => update(i, s)} disabled={disabled} />
            )}
            {step.type === 'variable' && (
              <div className="space-y-2">
                <Input
                  aria-label={`${at} value`}
                  className="font-mono"
                  placeholder="{{ login.data.token }}"
                  value={step.value}
                  disabled={disabled}
                  onChange={(e) => update(i, { ...step, value: e.target.value })}
                />
                <Checkbox
                  checked={step.secret !== false}
                  disabled={disabled}
                  onChange={(e) => update(i, { ...step, secret: e.target.checked })}
                  label="Hide from query results (a credential). Untick for values that aren't secret, like a tenant ID."
                />
              </div>
            )}
          </div>
        )
      })}
      {!disabled && (
        <div className="flex flex-wrap gap-1">
          {types.map((type) => (
            <Button
              key={type}
              size="sm"
              variant="ghost"
              onClick={() => onChange([...steps, newStep(type, freeName(steps, DEFAULT_NAMES[type]))])}
            >
              <Plus className="size-4" /> {prefix} {type}
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}

/** A form step: an optional title and the fields each person fills in (`{{ <step>.<field> }}` in later steps). */
function FormStep({
  at,
  step,
  onChange,
  disabled,
}: {
  at: string
  step: Extract<Step, { type: 'form' }>
  onChange: (step: Step) => void
  disabled: boolean
}) {
  const setField = (i: number, field: FormField) =>
    onChange({ ...step, fields: step.fields.map((f, j) => (i === j ? field : f)) })
  return (
    <div className="space-y-3">
      <Input
        aria-label={`${at} title`}
        placeholder="Title, e.g. Sign in with your Acme account (optional)"
        value={step.title}
        disabled={disabled}
        onChange={(e) => onChange({ ...step, title: e.target.value })}
      />
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted">Fields</p>
        {step.fields.map((field, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fields are edited in place; names change as people type
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`${at} field ${i + 1} name`}
              className="w-40 font-mono"
              placeholder="username"
              value={field.name}
              disabled={disabled}
              onChange={(e) => setField(i, { ...field, name: e.target.value })}
            />
            <Input
              aria-label={`${at} field ${i + 1} label`}
              className="min-w-40 flex-1"
              placeholder="Label people see"
              value={field.label}
              disabled={disabled}
              onChange={(e) => setField(i, { ...field, label: e.target.value })}
            />
            <Select
              aria-label={`${at} field ${i + 1} kind`}
              className="w-32"
              value={field.kind}
              disabled={disabled}
              onChange={(e) => setField(i, { ...field, kind: e.target.value as FormField['kind'] })}
            >
              <option value="text">Text</option>
              <option value="password">Password</option>
            </Select>
            {!disabled && (
              <Button
                size="icon"
                variant="ghost"
                title={`Remove field ${i + 1}`}
                disabled={step.fields.length === 1}
                onClick={() => onChange({ ...step, fields: step.fields.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        ))}
        {!disabled && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({ ...step, fields: [...step.fields, { name: '', label: '', kind: 'text' }] })
            }
          >
            <Plus className="size-4" /> Field
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">
        Later steps read the values as{' '}
        <code>{`{{ ${step.name || 'signin'}.${step.fields[0]?.name || 'username'} }}`}</code>. What people
        type is sent to sign in and never stored.
      </p>
    </div>
  )
}

function RequestStep({
  at,
  step,
  onChange,
  disabled,
}: {
  at: string
  step: Extract<Step, { type: 'request' }>
  onChange: (step: Step) => void
  disabled: boolean
}) {
  const body = step.body
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Select
          aria-label={`${at} method`}
          className="w-28"
          value={step.method}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...step,
              method: e.target.value,
              ...(e.target.value === 'GET' ? { body: { type: 'none' } as Body } : {}),
            })
          }
        >
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Input
          aria-label={`${at} path`}
          className="font-mono"
          placeholder="login, or https://auth.example.com/login on an allowed host"
          value={step.path}
          disabled={disabled}
          onChange={(e) => onChange({ ...step, path: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">Query parameters</p>
          <KeyValueEditor
            rows={step.params}
            onChange={(params) => onChange({ ...step, params })}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">Headers</p>
          <KeyValueEditor
            rows={step.headers}
            onChange={(headers) => onChange({ ...step, headers })}
            disabled={disabled}
            keyPlaceholder="Header"
          />
        </div>
      </div>
      {step.method !== 'GET' && (
        <div className="space-y-2">
          <Select
            aria-label={`${at} body`}
            className="w-52"
            value={body.type}
            disabled={disabled}
            onChange={(e) => {
              const type = e.target.value as Body['type']
              const next: Body =
                type === 'json'
                  ? { type, json: '{}' }
                  : type === 'form'
                    ? { type, fields: [] }
                    : type === 'raw'
                      ? { type, raw: '', contentType: 'text/plain' }
                      : type === 'multipart'
                        ? { type, parts: [] }
                        : { type: 'none' }
              onChange({ ...step, body: next })
            }}
          >
            <option value="none">No body</option>
            <option value="json">JSON</option>
            <option value="form">Form</option>
            <option value="raw">Raw</option>
            <option value="multipart">Multipart (form-data)</option>
          </Select>
          {body.type === 'json' && (
            <Textarea
              aria-label={`${at} JSON body`}
              rows={3}
              className="font-mono"
              value={body.json}
              disabled={disabled}
              onChange={(e) => onChange({ ...step, body: { ...body, json: e.target.value } })}
            />
          )}
          {body.type === 'form' && (
            <KeyValueEditor
              rows={body.fields}
              onChange={(fields) => onChange({ ...step, body: { ...body, fields } })}
              disabled={disabled}
              keyPlaceholder="Field"
            />
          )}
          {body.type === 'raw' && (
            <Textarea
              aria-label={`${at} raw body`}
              rows={3}
              className="font-mono"
              value={body.raw}
              disabled={disabled}
              onChange={(e) => onChange({ ...step, body: { ...body, raw: e.target.value } })}
            />
          )}
          {body.type === 'multipart' && (
            <MultipartParts
              parts={body.parts}
              onChange={(parts) => onChange({ ...step, body: { ...body, parts } })}
              disabled={disabled}
            />
          )}
        </div>
      )}
    </div>
  )
}

const STATE_BADGE = {
  none: { label: 'Not signed in', tone: undefined },
  signedIn: { label: 'Signed in', tone: 'success' },
  expired: { label: 'Expired', tone: undefined },
  settingsChanged: { label: 'Settings changed', tone: undefined },
  failed: { label: 'Sign-in failed', tone: 'danger' },
} as const

const STATE_TEXT = {
  none: 'Not signed in yet: the first query signs in.',
  signedIn: null,
  expired: 'The sign-in ran out: the next query signs in again.',
  settingsChanged: 'The flow changed since it signed in: the next query signs in again.',
  failed: 'The last sign-in a query needed failed. Queries try again (waiting longer after each failure).',
} as const

/** The same, for a flow asking each person for their own details: only they can sign in again. */
const OWN_STATE_TEXT = {
  none: 'You haven’t signed in here yet.',
  signedIn: null,
  expired: 'Your sign-in ran out: queries renew it if the flow can, else sign in again.',
  settingsChanged: 'The sign-in flow changed since you signed in: sign in again.',
  failed: 'Your sign-in stopped working: sign in again.',
} as const

const when = (value: string | Date) => new Date(value).toLocaleString()

/**
 * A custom auth flow's sign-in in one environment: whether it's signed in, since and until when, the variables it
 * defines, and the last failure. People with Edit sign in now (to check the flow, or after fixing a password) or
 * sign out (the next query signs in again). Uses the saved settings. On a flow with a form step it's the viewer's own
 * sign-in: they sign in with the form (and out), and people with Edit see how many people have.
 */
export function CustomAuthStatus({
  resource,
  environmentId,
}: {
  resource: ResourceDetail
  environmentId: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const options = trpc.resources.customAuthStatus.queryOptions({ resourceId: resource.id })
  const { data } = useQuery(options)
  const env = data?.environments.find((e) => e.environmentId === environmentId)
  const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey })
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const signIn = useMutation(
    trpc.resources.customAuthSignIn.mutationOptions({
      onSuccess: async (result) => {
        setMessage(result.ok ? { ok: true, text: 'Signed in.' } : { ok: false, text: result.error.message })
        await refresh()
      },
    }),
  )
  const signOut = useMutation(
    trpc.resources.customAuthSignOut.mutationOptions({
      onSuccess: async () => {
        setMessage(null)
        await refresh()
      },
    }),
  )
  if (!env?.status) return null

  const status = env.status
  const own = env.perUser
  const badge = STATE_BADGE[status.state]
  const text = (own ? OWN_STATE_TEXT : STATE_TEXT)[status.state]
  return (
    <Card className="space-y-4 p-5" role="region" aria-label="Sign-in status">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="flex-1 space-y-1">
          <h2 className="font-semibold">{own ? 'Your sign-in' : 'Sign-in'}</h2>
          <p className="text-sm text-muted">
            {own
              ? 'Each person signs in with their own details, and their queries here use their own sign-in. Workflows that run on their own can’t use this resource.'
              : 'The custom auth flow’s variables, shared by every query in this environment, including workflows that run on their own.'}
          </p>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {status.signedInAt && status.state !== 'none' && (
          <>
            <dt className="text-muted">Signed in on</dt>
            <dd>{when(status.signedInAt)}</dd>
          </>
        )}
        {status.state === 'signedIn' && (
          <>
            <dt className="text-muted">{own ? 'Runs out' : 'Signs in again'}</dt>
            <dd>{status.expiresAt ? when(status.expiresAt) : 'When an API answers 401'}</dd>
          </>
        )}
        <dt className="text-muted">Variables</dt>
        <dd className="font-mono text-xs leading-5">
          {env.variables.map((name) => `auth.${name}`).join(', ')}
        </dd>
      </dl>
      {text && <p className="text-sm text-muted">{text}</p>}
      {env.signedInPeople !== null && (
        <p className="text-sm text-muted">
          {env.signedInPeople === 1 ? '1 person has' : `${env.signedInPeople} people have`} signed in here.
        </p>
      )}
      {status.lastError && (
        <p className="text-sm text-danger">
          {status.state === 'failed' ? 'Why: ' : 'The last sign-in failed: '}
          {status.lastError}
        </p>
      )}

      {env.canSignIn && (
        <div className="flex flex-wrap items-center gap-2">
          {own ? (
            <Button
              variant="primary"
              onClick={() => {
                setMessage(null)
                setFormOpen(true)
              }}
            >
              {status.state === 'none' ? 'Sign in' : 'Sign in again'}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={signIn.isPending}
              onClick={() => {
                setMessage(null)
                signIn.mutate({ resourceId: resource.id, environmentId })
              }}
            >
              Sign in now
            </Button>
          )}
          {status.state !== 'none' && (
            <Button
              variant="danger"
              loading={signOut.isPending}
              onClick={async () => {
                if (
                  await confirmDialog(
                    own
                      ? 'Sign out? Your queries here will ask you to sign in again.'
                      : 'Sign out? The next query signs in again.',
                    { confirm: 'Sign out', danger: true },
                  )
                ) {
                  signOut.mutate({ resourceId: resource.id, environmentId })
                }
              }}
            >
              Sign out
            </Button>
          )}
          <span className="text-xs text-muted">Uses the saved settings.</span>
        </div>
      )}
      {formOpen && (
        <CustomSignInDialog
          resourceId={resource.id}
          environmentId={environmentId}
          onClose={() => setFormOpen(false)}
          onSignedIn={() => {
            setFormOpen(false)
            setMessage({ ok: true, text: 'Signed in.' })
          }}
        />
      )}
      {/* A failure kept on the row shows above; one that left nothing to keep it on (not signed in yet) shows here. */}
      {message && (message.ok || message.text !== status.lastError) && (
        <p className={message.ok ? 'text-sm text-success' : 'text-sm text-danger'}>{message.text}</p>
      )}
      <ErrorNote error={signIn.error ?? signOut.error} />
    </Card>
  )
}
