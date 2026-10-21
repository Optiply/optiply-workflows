import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  DEFAULT_SIGNED_PAYLOAD,
  type ResolvedWebhook,
  WEBHOOK_HMAC_ALGORITHMS,
  WEBHOOK_PRESETS,
  WEBHOOK_SIGNATURE_ENCODINGS,
  WEBHOOK_SIGNATURE_PRESETS,
  type WebhookAuth,
  type WebhookSignatureAuth,
  type WebhookTrigger,
} from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileJson, RefreshCw, ShieldAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Badge, Button, Checkbox, Field, Input, linkClass, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { draftSchema } from './schema-draft'
import { useEditor } from './store'

const LazyCodeField = lazy(() => import('./code-field'))

/**
 * The webhook's M15 settings in the trigger panel: how callers authenticate, the rate limit, the environments
 * `?environment=` may pick, the idempotency header, and the latest calls the live webhook refused.
 */

type Set = (patch: Partial<WebhookTrigger>) => void
type ProblemsAt = (...path: (string | number)[]) => { message: string; hint?: string }[]

const PRESET_LABELS: Record<WebhookSignatureAuth['preset'], string> = {
  ...Object.fromEntries(Object.entries(WEBHOOK_PRESETS).map(([k, v]) => [k, v.label])),
  custom: 'Custom HMAC',
} as Record<WebhookSignatureAuth['preset'], string>

function FieldProblems({ problems }: { problems: { message: string; hint?: string }[] }) {
  if (!problems.length) return null
  return (
    <div className="flex flex-col gap-0.5">
      {problems.map((p) => (
        <span key={p.message} className="text-xs text-danger">
          {p.message}
          {p.hint && <span className="text-muted"> · {p.hint}</span>}
        </span>
      ))}
    </div>
  )
}

export function WebhookAuthFields({
  webhook,
  set,
  problemsAt,
}: {
  webhook: WebhookTrigger
  set: Set
  problemsAt: ProblemsAt
}) {
  const auth: WebhookAuth = webhook.auth ?? { type: 'apiKey' }
  const setType = (type: WebhookAuth['type']) =>
    set({
      // Public webhooks ignore idempotency headers (the validator refuses one).
      ...(type === 'public' && { idempotencyHeader: undefined }),
      auth:
        type === 'apiKey'
          ? undefined
          : type === 'public'
            ? { type }
            : { type, preset: 'stripe', secret: auth.type === 'signature' ? auth.secret : '' },
    })
  return (
    <Field label="Authentication">
      <div className="flex flex-col gap-2">
        <Select
          aria-label="Authentication"
          value={auth.type}
          onChange={(e) => setType(e.target.value as WebhookAuth['type'])}
        >
          <option value="apiKey">API key</option>
          <option value="signature">Signature (Stripe, GitHub, Slack, …)</option>
          <option value="public">Public (no authentication)</option>
        </Select>
        {auth.type === 'apiKey' && (
          <span className="text-xs text-muted">
            Callers send one of your API keys (Settings → API keys) in{' '}
            <code className="font-mono">X-Api-Key</code>.
          </span>
        )}
        {auth.type === 'public' && (
          <div className="flex gap-2 rounded-md bg-warning-soft p-2 text-xs text-warning-strong" role="note">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Anyone who knows the URL can start this workflow. It's rate limited and runs only in the
              environments allowed below; don't trust what the body says without checking it.
            </span>
          </div>
        )}
        {auth.type === 'signature' && (
          <SignatureFields
            auth={auth}
            set={(patch) => set({ auth: { ...auth, ...patch } })}
            problemsAt={problemsAt}
          />
        )}
      </div>
    </Field>
  )
}

function SignatureFields({
  auth,
  set,
  problemsAt,
}: {
  auth: WebhookSignatureAuth
  set: (patch: Partial<WebhookSignatureAuth>) => void
  problemsAt: ProblemsAt
}) {
  const trpc = useTRPC()
  const { data: vars } = useQuery(trpc.configVars.list.queryOptions())
  const secrets = (vars ?? []).filter((v) => v.isSecret)
  const custom = auth.preset === 'custom'
  const preset = auth.preset === 'custom' ? undefined : WEBHOOK_PRESETS[auth.preset]
  const timestamped = custom ? auth.timestampHeader !== undefined : preset!.timestamped
  const text = (field: 'header' | 'prefix' | 'timestampHeader' | 'signedPayload') => (value: string) =>
    set({ [field]: value || undefined })

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label="Provider"
          value={auth.preset}
          onChange={(e) => {
            const next = e.target.value as WebhookSignatureAuth['preset']
            // Custom fields belong to the custom preset only (the validator says so too).
            set({
              preset: next,
              header: undefined,
              algorithm: undefined,
              encoding: undefined,
              prefix: undefined,
              timestampHeader: undefined,
              signedPayload: undefined,
              toleranceSeconds: undefined,
            })
          }}
        >
          {WEBHOOK_SIGNATURE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Signing secret"
          value={auth.secret}
          onChange={(e) => set({ secret: e.target.value })}
        >
          <option value="">Choose the secret…</option>
          {secrets.map((v) => (
            <option key={v.id} value={v.name}>
              {v.name}
            </option>
          ))}
          {auth.secret && !secrets.some((v) => v.name === auth.secret) && (
            <option value={auth.secret}>{auth.secret} (not a secret config var)</option>
          )}
        </Select>
      </div>
      <FieldProblems problems={problemsAt('auth', 'secret')} />
      <span className="text-xs text-muted">
        The signing secret is a secret config var, set per environment (one secret per line while you rotate
        it):{' '}
        <Link to="/settings/config-vars" className={linkClass}>
          Settings → Config vars
        </Link>
        .
        {preset && (
          <>
            {' '}
            Checks the <code className="font-mono">{preset.header}</code> header.
          </>
        )}
      </span>

      {custom && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            aria-label="Signature header"
            className="font-mono"
            placeholder="signature header"
            value={auth.header ?? ''}
            onChange={(e) => text('header')(e.target.value)}
          />
          <Input
            aria-label="Prefix"
            className="font-mono"
            placeholder="prefix (sha256=)"
            value={auth.prefix ?? ''}
            onChange={(e) => text('prefix')(e.target.value)}
          />
          <Select
            aria-label="Algorithm"
            value={auth.algorithm ?? 'sha256'}
            onChange={(e) =>
              set({
                algorithm:
                  e.target.value === 'sha256'
                    ? undefined
                    : (e.target.value as WebhookSignatureAuth['algorithm']),
              })
            }
          >
            {WEBHOOK_HMAC_ALGORITHMS.map((a) => (
              <option key={a} value={a}>
                HMAC-{a.toUpperCase()}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Encoding"
            value={auth.encoding ?? 'hex'}
            onChange={(e) =>
              set({
                encoding:
                  e.target.value === 'hex' ? undefined : (e.target.value as WebhookSignatureAuth['encoding']),
              })
            }
          >
            {WEBHOOK_SIGNATURE_ENCODINGS.map((enc) => (
              <option key={enc} value={enc}>
                {enc}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Timestamp header"
            className="font-mono"
            placeholder="timestamp header (optional)"
            value={auth.timestampHeader ?? ''}
            onChange={(e) => text('timestampHeader')(e.target.value)}
          />
          <Input
            aria-label="Signed payload"
            className="font-mono"
            placeholder={DEFAULT_SIGNED_PAYLOAD}
            title="What is signed: {timestamp}, {body}, {method} and {url}"
            value={auth.signedPayload ?? ''}
            onChange={(e) => text('signedPayload')(e.target.value)}
          />
        </div>
      )}
      {custom && (
        <FieldProblems
          problems={['header', 'prefix', 'timestampHeader', 'signedPayload'].flatMap((f) =>
            problemsAt('auth', f),
          )}
        />
      )}

      {timestamped && (
        <div className="flex items-center gap-2 text-xs text-muted">
          Accept timestamps up to
          <Input
            aria-label="Tolerance in seconds"
            type="number"
            min={1}
            max={86_400}
            className="h-8 w-24"
            value={auth.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS}
            onChange={(e) => {
              const seconds = Math.min(86_400, Math.max(1, Number(e.target.value) || 1))
              set({ toleranceSeconds: seconds === DEFAULT_SIGNATURE_TOLERANCE_SECONDS ? undefined : seconds })
            }}
          />
          seconds old
        </div>
      )}
      <FieldProblems problems={problemsAt('auth', 'toleranceSeconds')} />
    </div>
  )
}

export function WebhookLimitFields({
  webhook,
  resolved,
  set,
  problemsAt,
}: {
  webhook: WebhookTrigger
  resolved: ResolvedWebhook
  set: Set
  problemsAt: ProblemsAt
}) {
  const trpc = useTRPC()
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const keyed = resolved.auth.type === 'apiKey'
  const limit = webhook.rateLimit
  const defaultLimit = keyed ? null : resolved.rateLimit
  const listed = webhook.environments ?? []
  const defaultEnv = environments?.find((e) => e.isDefault)
  const setLimit = (requests: number, windowSeconds: number) =>
    set({
      rateLimit:
        defaultLimit && requests === defaultLimit.requests && windowSeconds === defaultLimit.windowSeconds
          ? undefined
          : { requests, windowSeconds },
    })

  return (
    <>
      <Field
        label="Rate limit"
        hint={
          keyed
            ? 'Optional for API-key webhooks. Calls over the limit get 429 with Retry-After.'
            : 'Signed and public webhooks are always limited. Calls over the limit get 429 with Retry-After.'
        }
      >
        <div className="flex items-center gap-2 text-sm">
          {keyed && (
            <Checkbox
              label="Limit"
              checked={Boolean(limit)}
              onChange={(e) =>
                set({ rateLimit: e.target.checked ? { requests: 60, windowSeconds: 60 } : undefined })
              }
            />
          )}
          {(limit ?? defaultLimit) && (
            <>
              <Input
                aria-label="Requests"
                type="number"
                min={1}
                className="h-8 w-24"
                value={(limit ?? defaultLimit)!.requests}
                onChange={(e) =>
                  setLimit(Math.max(1, Number(e.target.value) || 1), (limit ?? defaultLimit)!.windowSeconds)
                }
              />
              <span className="text-muted">calls per</span>
              <Input
                aria-label="Window in seconds"
                type="number"
                min={1}
                max={86_400}
                className="h-8 w-24"
                value={(limit ?? defaultLimit)!.windowSeconds}
                onChange={(e) =>
                  setLimit(
                    (limit ?? defaultLimit)!.requests,
                    Math.min(86_400, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
              />
              <span className="text-muted">seconds</span>
            </>
          )}
        </div>
      </Field>

      <Field
        label="Environments"
        hint={
          listed.length
            ? 'Callers pick one with ?environment=; without it, the default environment (or the first one ticked).'
            : keyed
              ? 'Any environment the API key allows (none ticked). Tick some to allow only those.'
              : `Only ${defaultEnv?.name ?? 'the default environment'} (none ticked). Tick some to allow others.`
        }
      >
        <div className="flex flex-wrap gap-3">
          {environments?.map((env) => (
            <Checkbox
              key={env.id}
              label={env.name}
              checked={listed.includes(env.slug)}
              onChange={(e) => {
                const next = e.target.checked
                  ? environments
                      .filter((x) => x.slug === env.slug || listed.includes(x.slug))
                      .map((x) => x.slug)
                  : listed.filter((s) => s !== env.slug)
                set({ environments: next.length ? next : undefined })
              }}
            />
          ))}
        </div>
        <FieldProblems problems={problemsAt('environments')} />
      </Field>

      {!(resolved.auth.type === 'public') && (
        <Field
          label="Idempotency header"
          hint="A repeat with the same value replays the earlier run instead of starting another (Idempotency-Key always works)."
        >
          <Input
            aria-label="Idempotency header"
            className="font-mono"
            placeholder={
              resolved.auth.type === 'signature' && resolved.auth.preset !== 'custom'
                ? (WEBHOOK_PRESETS[resolved.auth.preset].idempotencyHeader ?? 'none')
                : 'none'
            }
            value={webhook.idempotencyHeader ?? ''}
            onChange={(e) => set({ idempotencyHeader: e.target.value || undefined })}
          />
          <FieldProblems problems={problemsAt('idempotencyHeader')} />
        </Field>
      )}
    </>
  )
}

/** What each rejection reason means, for whoever is setting up the sender. */
const REASONS: Record<string, string> = {
  signature_mismatch:
    "Signature didn't match: check the secret, and that nothing rewrites the body on the way",
  missing_signature: 'No signature header',
  malformed_signature: "The signature header isn't in the provider's format",
  missing_timestamp: 'No signing time, or not a number',
  expired_timestamp: "Signing time too far from the server's clock (a replay, or a clock out of sync)",
  secret_unset: 'The signing secret has no value in this environment',
  rate_limited: 'Over the rate limit',
  invalid_body: "The body didn't match the body schema",
  method_not_allowed: "A method this webhook doesn't accept",
  forbidden: "An environment this webhook (or the API key) doesn't allow",
  unauthorized: 'No API key, or an unknown one',
  resource_not_configured: "A resource the workflow queries isn't configured in that environment",
  too_many_parts: 'A multipart body with too many parts',
  invalid_request: 'A malformed request',
}

/** The latest calls the live webhook refused. Shown to editors only (the list holds callers' IP addresses). */
export function WebhookRejections({ workflowId }: { workflowId: string }) {
  const trpc = useTRPC()
  const { data, error, refetch, isFetching } = useQuery({
    ...trpc.workflows.webhookRejections.queryOptions({ id: workflowId }),
    refetchInterval: 15_000,
    retry: false,
  })
  if (error || !data) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="webhook-rejections">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Refused calls</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" title="Refresh" onClick={() => void refetch()}>
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>
      {!data.length ? (
        <span className="text-xs text-muted">None in the last 7 days.</span>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {data.map((r) => (
            <li key={r.id} className="rounded-md bg-canvas px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <Badge tone={r.status === 429 ? 'warning' : 'danger'}>{r.status}</Badge>
                <span className="font-medium">{REASONS[r.reason] ?? r.reason}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-muted">
                <time dateTime={new Date(r.at).toISOString()}>{new Date(r.at).toLocaleString()}</time>
                {r.environment && <span>{r.environment}</span>}
                {r.ip && <span className="font-mono">{r.ip}</span>}
                {r.userAgent && (
                  <span className="truncate" title={r.userAgent}>
                    {r.userAgent}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const pretty = (schema: unknown) => (schema === undefined ? '' : JSON.stringify(schema, null, 2))

/**
 * The webhook's body schema as JSON in Monaco. Text that isn't a JSON object yet stays here (and isn't saved), so
 * typing never stores half a schema; the validator's problems (a schema Ajv can't compile) show below. Drafts come
 * from the start trigger's test input or a pasted sample, for the person to tighten.
 */
export function BodySchemaField({
  webhook,
  set,
  problemsAt,
  testInput,
}: {
  webhook: WebhookTrigger
  set: Set
  problemsAt: ProblemsAt
  testInput: unknown
}) {
  const workflowId = useEditor((s) => s.workflowId)
  const [text, setText] = useState(() => pretty(webhook.bodySchema))
  const [parseError, setParseError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [sample, setSample] = useState('')
  const [sampleError, setSampleError] = useState<string | null>(null)
  // The schema this field last saved: anything else (undo, redo, a paste) replaces the text.
  const saved = useRef(JSON.stringify(webhook.bodySchema ?? null))
  useEffect(() => {
    const current = JSON.stringify(webhook.bodySchema ?? null)
    if (current === saved.current) return
    saved.current = current
    setText(pretty(webhook.bodySchema))
    setParseError(null)
  }, [webhook.bodySchema])

  const save = (schema: Record<string, unknown> | undefined) => {
    saved.current = JSON.stringify(schema ?? null)
    set({ bodySchema: schema })
  }
  const edit = (next: string) => {
    setText(next)
    if (!next.trim()) {
      setParseError(null)
      save(undefined)
      return
    }
    try {
      const value: unknown = JSON.parse(next)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        setParseError('A schema is a JSON object: { "type": "object", … }')
        return
      }
      setParseError(null)
      save(value as Record<string, unknown>)
    } catch (err) {
      setParseError(`Not valid JSON yet (not saved): ${(err as Error).message}`)
    }
  }
  const applyDraft = (value: unknown) => {
    const schema = draftSchema(value)
    setText(pretty(schema))
    setParseError(null)
    save(schema)
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="body-schema">
      <span className="text-sm font-medium text-ink">Body schema</span>
      <Suspense
        fallback={
          <div style={{ height: 160 }} className="animate-pulse rounded-md border border-border bg-canvas" />
        }
      >
        <LazyCodeField
          path={`file:///${workflowId}/_/startTrigger/body-schema.json`}
          language="json"
          height={160}
          value={text}
          onChange={edit}
        />
      </Suspense>
      {parseError && <span className="text-xs text-danger">{parseError}</span>}
      <FieldProblems problems={problemsAt('bodySchema')} />
      <div className="flex flex-wrap gap-1.5">
        {testInput !== undefined && testInput !== null && (
          <Button size="sm" variant="ghost" onClick={() => applyDraft(testInput)}>
            <FileJson className="size-3.5" /> Draft from the test input
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setPasting((p) => !p)}>
          <FileJson className="size-3.5" /> Draft from a sample…
        </Button>
      </div>
      {pasting && (
        <div className="flex flex-col gap-1.5">
          <Textarea
            aria-label="Sample body"
            rows={5}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder='{ "orderId": 7, "lines": [{ "sku": "A", "qty": 1 }] }'
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
          {sampleError && <span className="text-xs text-danger">{sampleError}</span>}
          <Button
            size="sm"
            className="self-start"
            onClick={() => {
              try {
                applyDraft(JSON.parse(sample))
                setSampleError(null)
                setPasting(false)
                setSample('')
              } catch (err) {
                setSampleError(`Not valid JSON: ${(err as Error).message}`)
              }
            }}
          >
            Draft the schema
          </Button>
        </div>
      )}
      <span className="text-xs text-muted">
        Optional. A body that doesn't match gets 400 with what's wrong, and no run starts; completions for{' '}
        <code className="font-mono">startTrigger.data</code> follow it. A draft lists every key it saw;
        tighten it before you publish.
      </span>
    </div>
  )
}
