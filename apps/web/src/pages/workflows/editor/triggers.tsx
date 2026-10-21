import {
  DEFAULT_TIMEZONE,
  DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS,
  type Diagnostic,
  isValidTimeZone,
  parseCron,
  resolveWebhookSettings,
  type ScheduleTrigger,
  upcomingCronFires,
  WEBHOOK_METHODS,
  WEBHOOK_PRESETS,
  type WebhookMethod,
  type WebhookTrigger,
  type WorkflowDefinition,
} from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { Clock, Plus, Trash2, Webhook } from 'lucide-react'
import { Badge, Button, Checkbox, CopyButton, Field, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { useRun } from './run-state'
import { useEditor } from './store'
import { WebhookAuthFields, WebhookLimitFields, WebhookRejections } from './webhook-settings'

type Triggers = NonNullable<WorkflowDefinition['triggers']>

/** Edits the definition's triggers, dropping empty parts so the stored JSON stays sparse. */
function updateTriggers(edit: (triggers: Triggers) => Triggers) {
  useEditor.getState().update((def) => {
    const next = edit(def.triggers ?? {})
    const { webhook, schedules } = next
    const sparse: Triggers = {
      ...(webhook && { webhook }),
      ...(schedules?.length && { schedules }),
    }
    const { triggers: _, ...rest } = def
    return Object.keys(sparse).length ? { ...rest, triggers: sparse } : rest
  })
}

/** Problems whose path starts with `['triggers', ...prefix]`. */
function useTriggerProblems(...prefix: (string | number)[]): Diagnostic[] {
  const diagnostics = useEditor((s) => s.diagnostics)
  const path = ['triggers', ...prefix]
  return diagnostics.filter((d) => path.every((p, i) => d.path[i] === p))
}

function Problems({ problems }: { problems: Diagnostic[] }) {
  if (!problems.length) return null
  return (
    <div className="flex flex-col gap-0.5">
      {problems.map((p) => (
        <span key={`${p.code}:${p.path.join('.')}`} className="text-xs text-danger">
          {p.message}
          {p.hint && <span className="text-muted"> · {p.hint}</span>}
        </span>
      ))}
    </div>
  )
}

/** The start trigger's webhook and schedules. They take effect when the workflow is published. */
export function TriggersForm({ testInput }: { testInput: unknown }) {
  const triggers = useEditor((s) => s.definition.triggers)
  return (
    <div className="flex flex-col gap-5">
      <WebhookSection webhook={triggers?.webhook} testInput={testInput} />
      <SchedulesSection schedules={triggers?.schedules ?? []} />
    </div>
  )
}

function SectionTitle({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted">{icon}</span>
      <h3 className="text-sm font-semibold">{title}</h3>
      <span className="flex-1" />
      {children}
    </div>
  )
}

function WebhookSection({ webhook, testInput }: { webhook: WebhookTrigger | undefined; testInput: unknown }) {
  const slug = useRun((s) => s.slug)
  const workflowId = useEditor((s) => s.workflowId)
  const aliasProblems = useTriggerProblems('webhook', 'alias')
  const webhookProblems = useTriggerProblems('webhook')
  const problemsAt = (...path: (string | number)[]) =>
    webhookProblems.filter((d) => path.every((p, i) => d.path[i + 2] === p))
  const resolved = resolveWebhookSettings(webhook ?? { enabled: false })
  const auth = resolved.auth
  const set = (patch: Partial<WebhookTrigger>) =>
    updateTriggers((t) => ({ ...t, webhook: { enabled: false, ...t.webhook, ...patch } }))
  const enabled = webhook?.enabled ?? false
  const methods = webhook?.methods ?? ['POST']
  const origin = window.location.origin
  const urls = [
    `${origin}/api/v1/workflows/${slug}/webhook`,
    ...(webhook?.alias && !aliasProblems.length ? [`${origin}/api/v1/hooks/${webhook.alias}`] : []),
  ]
  const method = methods.includes('POST') ? 'POST' : methods[0]!
  const signatureHeader =
    auth.type !== 'signature'
      ? null
      : auth.preset === 'custom'
        ? auth.header || 'X-Signature'
        : WEBHOOK_PRESETS[auth.preset].header
  const curl = [
    `curl -X ${method} '${urls.at(-1)}'`,
    ...(auth.type === 'apiKey' ? [`  -H 'X-Api-Key: <your API key>'`] : []),
    ...(signatureHeader ? [`  -H '${signatureHeader}: <signature>'`] : []),
    ...(method === 'GET' || method === 'DELETE'
      ? []
      : [`  -H 'Content-Type: application/json'`, `  -d '${JSON.stringify(testInput ?? {})}'`]),
  ].join(' \\\n')

  return (
    <section className="flex flex-col gap-3" data-testid="webhook-trigger">
      <SectionTitle icon={<Webhook className="size-4" />} title="Webhook">
        <Checkbox label="Enabled" checked={enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      </SectionTitle>
      {enabled && (
        <>
          <div className="flex flex-wrap gap-3">
            {WEBHOOK_METHODS.map((m) => (
              <Checkbox
                key={m}
                label={<span className="font-mono text-xs">{m}</span>}
                checked={methods.includes(m)}
                disabled={methods.length === 1 && methods.includes(m)}
                onChange={(e) =>
                  set({
                    methods: e.target.checked
                      ? WEBHOOK_METHODS.filter((x) => x === m || methods.includes(x))
                      : methods.filter((x: WebhookMethod) => x !== m),
                  })
                }
              />
            ))}
          </div>
          <Field
            label="Alias"
            hint={
              <>
                Optional extra URL; <code className="font-mono">:name</code> segments arrive in{' '}
                <code className="font-mono">startTrigger.pathParams</code>.
              </>
            }
          >
            <div className="flex items-center">
              <span className="rounded-l-md border border-r-0 border-border bg-canvas px-2 py-2 font-mono text-xs text-muted">
                /api/v1/hooks/
              </span>
              <Input
                className={cn('rounded-l-none font-mono', aliasProblems.length && 'border-danger')}
                placeholder="orders/:orderId"
                value={webhook?.alias ?? ''}
                onChange={(e) => set({ alias: e.target.value || undefined })}
              />
            </div>
            <Problems problems={aliasProblems} />
          </Field>
          <Field
            label="Wait for the reply"
            hint="Seconds a call waits for the Response block before answering 202 with the run id."
          >
            <Input
              type="number"
              min={0}
              max={300}
              className="w-28"
              value={Math.round((webhook?.syncTimeoutMs ?? DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS) / 1000)}
              onChange={(e) => {
                const seconds = Math.min(300, Math.max(0, Number(e.target.value) || 0))
                set({ syncTimeoutMs: seconds === 30 ? undefined : seconds * 1000 })
              }}
            />
          </Field>
          <WebhookAuthFields webhook={webhook!} set={set} problemsAt={problemsAt} />
          <WebhookLimitFields webhook={webhook!} resolved={resolved} set={set} problemsAt={problemsAt} />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">URL{urls.length > 1 ? 's' : ''}</span>
            {urls.map((url) => (
              <div key={url} className="flex items-center gap-1 rounded-md bg-canvas pl-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
                  {url}
                </code>
                <CopyButton text={url} label="Copy URL" />
              </div>
            ))}
            <div className="rounded-md bg-canvas">
              <div className="flex items-center justify-between border-b border-border/60 pl-2 text-xs text-muted">
                Example call
                <CopyButton text={curl} label="Copy curl" />
              </div>
              <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed">{curl}</pre>
            </div>
            <span className="text-xs text-muted">
              {auth.type === 'apiKey'
                ? 'Calls need an API key (Settings → API keys). '
                : auth.type === 'signature'
                  ? `The sender signs each call with the secret; you only give it the URL. `
                  : 'Anyone with the URL can call it. '}
              Calls reach the live release once you publish. Add{' '}
              <code className="font-mono">?environment=staging</code> to pick an environment.
            </span>
          </div>
          {workflowId && <WebhookRejections workflowId={workflowId} />}
        </>
      )}
    </section>
  )
}

const TIME_ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return [DEFAULT_TIMEZONE, 'UTC']
  }
})()

function SchedulesSection({ schedules }: { schedules: ScheduleTrigger[] }) {
  const add = () =>
    updateTriggers((t) => {
      const taken = new Set((t.schedules ?? []).map((s) => s.name))
      let n = (t.schedules?.length ?? 0) + 1
      while (taken.has(`schedule-${n}`)) n++
      return {
        ...t,
        schedules: [...(t.schedules ?? []), { name: `schedule-${n}`, enabled: true, cron: '0 * * * *' }],
      }
    })
  return (
    <section className="flex flex-col gap-3" data-testid="schedule-triggers">
      <SectionTitle icon={<Clock className="size-4" />} title="Schedules">
        <Button size="sm" variant="ghost" onClick={add}>
          <Plus className="size-3.5" /> Add
        </Button>
      </SectionTitle>
      {!schedules.length && (
        <p className="text-xs text-muted">No schedules. Add one to run this workflow on a timer.</p>
      )}
      {schedules.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the name is edited in place; keying by it would remount the card on every keystroke
        <ScheduleCard key={i} index={i} schedule={s} />
      ))}
    </section>
  )
}

function ScheduleCard({ index, schedule }: { index: number; schedule: ScheduleTrigger }) {
  const trpc = useTRPC()
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const workflowId = useEditor((s) => s.workflowId)
  const { data: live } = useQuery({
    ...trpc.workflows.triggers.queryOptions({ id: workflowId ?? '' }),
    enabled: !!workflowId,
  })
  const problems = useTriggerProblems('schedules', index)
  const at = (field: string) => problems.filter((p) => p.path[3] === field)
  const general = problems.filter((p) => p.path.length === 3 || p.path[3] === 'name')
  const set = (edit: (s: ScheduleTrigger) => ScheduleTrigger) =>
    updateTriggers((t) => ({
      ...t,
      schedules: (t.schedules ?? []).map((s, i) => (i === index ? edit(s) : s)),
    }))
  const patch = (fields: Partial<ScheduleTrigger>) =>
    set((s) => {
      const next: Record<string, unknown> = { ...s, ...fields }
      for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
      return next as ScheduleTrigger
    })
  const kind = schedule.intervalMs !== undefined && schedule.cron === undefined ? 'interval' : 'cron'
  const timezone = schedule.timezone ?? DEFAULT_TIMEZONE
  const projected = live?.find((t) => t.kind === 'schedule' && t.name === schedule.name)

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      data-testid={`schedule-${schedule.name}`}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="Schedule name"
          className="h-8 flex-1 font-mono"
          value={schedule.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <Checkbox
          label="On"
          checked={schedule.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <Button
          size="icon"
          variant="ghost"
          title="Remove schedule"
          onClick={() =>
            updateTriggers((t) => ({ ...t, schedules: (t.schedules ?? []).filter((_, i) => i !== index) }))
          }
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Problems problems={general} />
      <div className="flex gap-2">
        <Select
          aria-label="Schedule kind"
          value={kind}
          onChange={(e) =>
            patch(
              e.target.value === 'interval'
                ? { cron: undefined, timezone: undefined, intervalMs: 60 * 60_000 }
                : { intervalMs: undefined, cron: '0 * * * *' },
            )
          }
        >
          <option value="cron">Cron</option>
          <option value="interval">Every</option>
        </Select>
        {kind === 'cron' ? (
          <Input
            aria-label="Cron expression"
            className={cn('font-mono', at('cron').length && 'border-danger')}
            placeholder="0 3 * * *"
            value={schedule.cron ?? ''}
            onChange={(e) => patch({ cron: e.target.value })}
          />
        ) : (
          <div className="flex items-center gap-2">
            <Input
              aria-label="Interval in minutes"
              type="number"
              min={1}
              className="w-24"
              value={Math.round((schedule.intervalMs ?? 0) / 60_000)}
              onChange={(e) =>
                patch({ intervalMs: Math.max(0, Math.round(Number(e.target.value) || 0)) * 60_000 })
              }
            />
            <span className="text-sm text-muted">minutes</span>
          </div>
        )}
      </div>
      <Problems problems={[...at('cron'), ...at('intervalMs')]} />
      {kind === 'cron' && (
        <Field label="Time zone">
          <Input
            list="ow-time-zones"
            className={cn(at('timezone').length && 'border-danger')}
            placeholder={DEFAULT_TIMEZONE}
            value={schedule.timezone ?? ''}
            onChange={(e) => patch({ timezone: e.target.value || undefined })}
          />
          <datalist id="ow-time-zones">
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <Problems problems={at('timezone')} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="If still running">
          <Select
            value={schedule.overlap ?? 'skip'}
            onChange={(e) =>
              patch({
                overlap: e.target.value === 'skip' ? undefined : (e.target.value as 'queue' | 'allow'),
              })
            }
          >
            <option value="skip">Skip this run</option>
            <option value="queue">Queue it</option>
            <option value="allow">Run both</option>
          </Select>
        </Field>
        <Field label="Environment">
          <Select
            value={schedule.environment ?? ''}
            onChange={(e) => patch({ environment: e.target.value || undefined })}
          >
            <option value="">Default</option>
            {environments?.map((env) => (
              <option key={env.slug} value={env.slug}>
                {env.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {kind === 'cron' && <NextFires cron={schedule.cron ?? ''} timezone={timezone} />}
      <div className="text-xs text-muted">
        {projected ? (
          <>
            <Badge tone={projected.enabled ? 'success' : 'neutral'}>Live</Badge>{' '}
            {projected.nextFireAt
              ? `next run ${new Date(projected.nextFireAt).toLocaleString()}`
              : 'not scheduled'}
          </>
        ) : (
          'Runs once you publish.'
        )}
      </div>
    </div>
  )
}

/** The next three fire times, shown on the schedule's own clock. */
function NextFires({ cron, timezone }: { cron: string; timezone: string }) {
  const parsed = parseCron(cron)
  if (!parsed.ok || !isValidTimeZone(timezone)) return null
  const fires = upcomingCronFires(parsed.cron, new Date(), 3, timezone)
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
  return (
    <div className="text-xs text-muted" data-testid="next-fires">
      Next: {fires.map((d) => format.format(d)).join(' · ')}
    </div>
  )
}
