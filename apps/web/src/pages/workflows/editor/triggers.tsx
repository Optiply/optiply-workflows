import {
  DEFAULT_TIMEZONE,
  DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS,
  type Diagnostic,
  isValidTimeZone,
  type KafkaTrigger,
  type KinesisTrigger,
  type PubSubTrigger,
  parseCron,
  type QueueTriggerKind,
  type RabbitmqTrigger,
  resolveWebhookSettings,
  type ScheduleTrigger,
  type SqsTrigger,
  signatureHeaderOf,
  upcomingCronFires,
  WEBHOOK_METHODS,
  type WebhookMethod,
  type WebhookTrigger,
  type WorkflowDefinition,
} from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { Clock, Inbox, Plus, Trash2, Webhook } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, Button, Checkbox, CopyButton, Field, Input, linkClass, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { useRun } from './run-state'
import { useEditor } from './store'
import { BodySchemaField, WebhookAuthFields, WebhookLimitFields, WebhookRejections } from './webhook-settings'

type Triggers = NonNullable<WorkflowDefinition['triggers']>

/** Edits the definition's triggers, dropping empty parts so the stored JSON stays sparse. */
function updateTriggers(edit: (triggers: Triggers) => Triggers) {
  useEditor.getState().update((def) => {
    const next = edit(def.triggers ?? {})
    const { webhook, schedules, pubsub, sqs, kafka, rabbitmq, kinesis } = next
    const sparse: Triggers = {
      ...(webhook && { webhook }),
      ...(schedules?.length && { schedules }),
      ...(pubsub?.length && { pubsub }),
      ...(sqs?.length && { sqs }),
      ...(kafka?.length && { kafka }),
      ...(rabbitmq?.length && { rabbitmq }),
      ...(kinesis?.length && { kinesis }),
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

/**
 * The start trigger's webhook, schedules and queue triggers (Pub/Sub, SQS, Kafka). They take effect when the workflow
 * is published.
 */
export function TriggersForm({ testInput }: { testInput: unknown }) {
  const triggers = useEditor((s) => s.definition.triggers)
  return (
    <div className="flex flex-col gap-5">
      <WebhookSection webhook={triggers?.webhook} testInput={testInput} />
      <SchedulesSection schedules={triggers?.schedules ?? []} />
      <QueueSection kind="pubsub" triggers={triggers?.pubsub ?? []} />
      <QueueSection kind="sqs" triggers={triggers?.sqs ?? []} />
      <QueueSection kind="kafka" triggers={triggers?.kafka ?? []} />
      <QueueSection kind="rabbitmq" triggers={triggers?.rabbitmq ?? []} />
      <QueueSection kind="kinesis" triggers={triggers?.kinesis ?? []} />
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
  const signatureHeader = auth.type === 'signature' ? (signatureHeaderOf(auth) ?? 'X-Signature') : null
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
                set({
                  syncTimeoutMs:
                    seconds * 1000 === DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS ? undefined : seconds * 1000,
                })
              }}
            />
          </Field>
          <WebhookAuthFields webhook={webhook!} set={set} problemsAt={problemsAt} />
          <WebhookLimitFields webhook={webhook!} resolved={resolved} set={set} problemsAt={problemsAt} />
          <BodySchemaField webhook={webhook!} set={set} problemsAt={problemsAt} testInput={testInput} />
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
              <code className="font-mono">?environment=staging</code> to pick an environment.{' '}
              <a className={linkClass} href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
                OpenAPI document
              </a>{' '}
              (your live webhooks, for whoever writes the caller).
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

type QueueKind = QueueTriggerKind
type QueueTrigger = PubSubTrigger | SqsTrigger | KafkaTrigger | RabbitmqTrigger | KinesisTrigger

/** What differs between the queue triggers' sections (Pub/Sub M19, SQS and Kafka M26). */
const QUEUES: Record<
  QueueKind,
  {
    title: string
    noun: string
    resourceKind: string
    maxHoldMinutes: number
    fresh: (name: string, resource: string) => QueueTrigger
    empty: string
    explain: React.ReactNode
    receiving: string
  }
> = {
  pubsub: {
    title: 'Pub/Sub',
    noun: 'subscription',
    resourceKind: 'Google Cloud Pub/Sub',
    maxHoldMinutes: 24 * 60,
    fresh: (name, resource) => ({ name, enabled: true, resource, subscription: '' }),
    empty: 'run this workflow for each message published to its topic',
    explain: (
      <>
        Each message runs the workflow: <code>startTrigger.data</code> is its data (JSON or text),{' '}
        <code>startTrigger.message</code> its id, attributes and more. It's acked when the run succeeds, and
        redelivered by Pub/Sub when it fails.
      </>
    ),
    receiving: 'pulling',
  },
  sqs: {
    title: 'SQS',
    noun: 'queue',
    resourceKind: 'Amazon SQS',
    maxHoldMinutes: 12 * 60,
    fresh: (name, resource) => ({ name, enabled: true, resource, queue: '' }),
    empty: 'run this workflow for each message sent to the queue',
    explain: (
      <>
        Each message runs the workflow: <code>startTrigger.data</code> is its body (JSON or text),{' '}
        <code>startTrigger.message</code> its id, attributes and receive count. It's deleted when the run
        succeeds, and visible again at once when it fails, so the queue's redrive policy (a dead-letter queue)
        applies. A FIFO queue's groups run in order.
      </>
    ),
    receiving: 'receiving',
  },
  kafka: {
    title: 'Kafka',
    noun: 'topic trigger',
    resourceKind: 'Apache Kafka',
    maxHoldMinutes: 24 * 60,
    fresh: (name, resource) => ({ name, enabled: true, resource, topics: [] }),
    empty: 'run this workflow for each message on its topics',
    explain: (
      <>
        Each message runs the workflow: <code>startTrigger.data</code> is its value (JSON or text; null for a
        tombstone), <code>startTrigger.message</code> its key, headers, partition, offset and attempt.
        Messages with the same key run one at a time, in order. A run that fails is retried; after the last
        attempt the message goes to the dead-letter topic (or is dropped) and the partition moves on.
      </>
    ),
    receiving: 'consuming',
  },
  rabbitmq: {
    title: 'RabbitMQ',
    noun: 'queue trigger',
    resourceKind: 'RabbitMQ',
    maxHoldMinutes: 24 * 60,
    fresh: (name, resource) => ({ name, enabled: true, resource, queue: '' }),
    empty: 'run this workflow for each message in a queue',
    explain: (
      <>
        Each message runs the workflow: <code>startTrigger.data</code> is its body (JSON or text),{' '}
        <code>startTrigger.message</code> its exchange, routing key, headers and properties. It's acked when
        the run succeeds and rejected without requeueing when it fails, so the queue's dead-letter exchange
        takes it (without one, RabbitMQ drops it). Give messages a message id so a redelivery is recognised.
      </>
    ),
    receiving: 'consuming',
  },
  kinesis: {
    title: 'Kinesis',
    noun: 'stream trigger',
    resourceKind: 'Amazon Kinesis',
    maxHoldMinutes: 24 * 60,
    fresh: (name, resource) => ({ name, enabled: true, resource, stream: '' }),
    empty: 'run this workflow for each record in a stream',
    explain: (
      <>
        Each record runs the workflow: <code>startTrigger.data</code> is its data (JSON or text),{' '}
        <code>startTrigger.message</code> its shard, sequence number, partition key and attempt. A shard's
        records run one at a time, in order; where each shard has got to is kept, so a restart carries on
        there. A run that fails is retried; after the last attempt the record is skipped.
      </>
    ),
    receiving: 'reading',
  },
}

/** Queue triggers that start this workflow, a run per message: Pub/Sub (M19), SQS and Kafka (M26). */
function QueueSection({ kind, triggers }: { kind: QueueKind; triggers: QueueTrigger[] }) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.resources.list.queryOptions())
  const resources = (data?.resources ?? []).filter((r) => r.type === kind)
  const q = QUEUES[kind]
  const prefix =
    kind === 'pubsub'
      ? 'subscription'
      : kind === 'sqs' || kind === 'rabbitmq'
        ? 'queue'
        : kind === 'kinesis'
          ? 'stream'
          : 'topic'
  const add = () =>
    updateTriggers((t) => {
      const list = (t[kind] ?? []) as QueueTrigger[]
      const taken = new Set(list.map((p) => p.name))
      let n = list.length + 1
      while (taken.has(`${prefix}-${n}`)) n++
      return { ...t, [kind]: [...list, q.fresh(`${prefix}-${n}`, resources[0]?.slug ?? '')] }
    })
  return (
    <section className="flex flex-col gap-3" data-testid={`${kind}-triggers`}>
      <SectionTitle icon={<Inbox className="size-4" />} title={q.title}>
        <Button size="sm" variant="ghost" onClick={add}>
          <Plus className="size-3.5" /> Add
        </Button>
      </SectionTitle>
      {!triggers.length && (
        <p className="text-xs text-muted">
          {resources.length
            ? `No ${q.noun}s. Add one to ${q.empty}.`
            : `No ${q.noun}s. Add an ${q.resourceKind} resource first, then a ${q.noun} to ${q.empty}.`}
        </p>
      )}
      {triggers.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the name is edited in place; keying by it would remount the card on every keystroke
        <QueueCard key={i} kind={kind} index={i} trigger={t} resources={resources} />
      ))}
    </section>
  )
}

function QueueCard({
  kind,
  index,
  trigger,
  resources,
}: {
  kind: QueueKind
  index: number
  trigger: QueueTrigger
  resources: { slug: string; name: string }[]
}) {
  const trpc = useTRPC()
  const q = QUEUES[kind]
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const workflowId = useEditor((s) => s.workflowId)
  const { data: live } = useQuery({
    ...trpc.workflows.triggers.queryOptions({ id: workflowId ?? '' }),
    enabled: !!workflowId,
    // The worker reports each trigger every few seconds.
    refetchInterval: 5_000,
  })
  const problems = useTriggerProblems(kind, index)
  const at = (field: string) => problems.filter((p) => p.path[3] === field)
  const general = problems.filter((p) => p.path.length === 3 || p.path[3] === 'name')
  const patch = (fields: Record<string, unknown>) =>
    updateTriggers((t) => ({
      ...t,
      [kind]: ((t[kind] ?? []) as QueueTrigger[]).map((p, i) => {
        if (i !== index) return p
        const next: Record<string, unknown> = { ...p, ...fields }
        for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
        return next as QueueTrigger
      }),
    }))
  const projected = live?.find((t) => t.kind === kind && t.name === trigger.name)
  const state = projected && 'queue' in projected ? projected.queue : undefined
  const number = (value: string, max: number) =>
    value === '' ? undefined : Math.min(max, Math.max(1, Math.round(Number(value) || 1)))
  const text = (field: string, label: string, hint: string, placeholder: string) => (
    <Field label={label} hint={hint}>
      <Input
        className={cn('font-mono', at(field).length && 'border-danger')}
        placeholder={placeholder}
        data-testid={`${kind}-${field}`}
        value={String((trigger as unknown as Record<string, unknown>)[field] ?? '')}
        // Required: kept even when emptied (the validator says so), so the card keeps its kind's fields.
        onChange={(e) => patch({ [field]: e.target.value })}
      />
      <Problems problems={at(field)} />
    </Field>
  )

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      data-testid={`${kind}-${trigger.name}`}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label={`${q.title} trigger name`}
          className="h-8 flex-1 font-mono"
          value={trigger.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <Checkbox
          label="On"
          checked={trigger.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <Button
          size="icon"
          variant="ghost"
          title={`Remove ${q.noun}`}
          onClick={() =>
            updateTriggers((t) => ({
              ...t,
              [kind]: ((t[kind] ?? []) as QueueTrigger[]).filter((_, i) => i !== index),
            }))
          }
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Problems problems={general} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Resource">
          <Select value={trigger.resource} onChange={(e) => patch({ resource: e.target.value })}>
            {!resources.some((r) => r.slug === trigger.resource) && (
              <option value={trigger.resource}>
                {trigger.resource || `Choose an ${q.resourceKind} resource`}
              </option>
            )}
            {resources.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name} ({r.slug})
              </option>
            ))}
          </Select>
          <Problems problems={at('resource')} />
        </Field>
        <Field label="Environment">
          <Select
            value={trigger.environment ?? ''}
            onChange={(e) => patch({ environment: e.target.value || undefined })}
          >
            <option value="">Default</option>
            {environments?.map((env) => (
              <option key={env.slug} value={env.slug}>
                {env.name}
              </option>
            ))}
          </Select>
          <Problems problems={at('environment')} />
        </Field>
      </div>
      {kind === 'pubsub' ? (
        <Field label="Subscription" hint="Its id in the resource's project, or projects/…/subscriptions/….">
          <Input
            className={cn('font-mono', at('subscription').length && 'border-danger')}
            placeholder="orders-workflow"
            value={(trigger as PubSubTrigger).subscription ?? ''}
            onChange={(e) => patch({ subscription: e.target.value })}
          />
          <Problems problems={at('subscription')} />
        </Field>
      ) : kind === 'sqs' ? (
        text(
          'queue',
          'Queue',
          "Its name in the resource's region and account (name.fifo for FIFO), or its URL.",
          'orders',
        )
      ) : kind === 'rabbitmq' ? (
        text(
          'queue',
          'Queue',
          'The queue to consume (it must exist; declare it with its dead-letter exchange).',
          'orders',
        )
      ) : kind === 'kinesis' ? (
        <>
          {text('stream', 'Stream', 'Its name in the resource’s region and account, or its ARN.', 'orders')}
          <div className="grid grid-cols-3 gap-2">
            <Field label="A new shard starts at" hint="Until it has a checkpoint.">
              <Select
                value={(trigger as KinesisTrigger).startAt ?? 'latest'}
                onChange={(e) => patch({ startAt: e.target.value })}
              >
                <option value="latest">New records only</option>
                <option value="trimHorizon">The oldest kept</option>
              </Select>
            </Field>
            <Field label="Attempts" hint="Runs per record.">
              <Input
                type="number"
                min={1}
                max={20}
                placeholder="3"
                data-testid="kinesis-maxAttempts"
                value={(trigger as KinesisTrigger).maxAttempts ?? ''}
                onChange={(e) => patch({ maxAttempts: number(e.target.value, 20) })}
              />
            </Field>
            <Field label="Retry after (s)" hint="Doubling, at most 15 min.">
              <Input
                type="number"
                min={1}
                max={900}
                placeholder="10"
                value={(trigger as KinesisTrigger).retryBackoffSeconds ?? ''}
                onChange={(e) => patch({ retryBackoffSeconds: number(e.target.value, 900) })}
              />
            </Field>
          </div>
        </>
      ) : (
        <KafkaFields trigger={trigger as KafkaTrigger} patch={patch} at={at} number={number} />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="At once" hint="Messages whose runs may be under way together.">
          <Input
            type="number"
            min={1}
            max={100}
            placeholder="4"
            data-testid={`${kind}-maxInFlight`}
            value={trigger.maxInFlight ?? ''}
            onChange={(e) => patch({ maxInFlight: number(e.target.value, 100) })}
          />
          <Problems problems={at('maxInFlight')} />
        </Field>
        <Field
          label="Hold up to (minutes)"
          hint={
            kind === 'rabbitmq'
              ? "Longer runs: the message is acked and the run goes on. Keep it below the broker's consumer_timeout (30 min by default)."
              : 'Longer runs: the message is let go and the run goes on.'
          }
        >
          <Input
            type="number"
            min={1}
            placeholder={kind === 'rabbitmq' ? '25' : '60'}
            value={trigger.maxHoldMinutes ?? ''}
            onChange={(e) => patch({ maxHoldMinutes: number(e.target.value, q.maxHoldMinutes) })}
          />
          <Problems problems={at('maxHoldMinutes')} />
        </Field>
      </div>
      <p className="text-xs text-muted">{q.explain}</p>
      <div className="flex flex-col gap-1 text-xs text-muted" data-testid={`${kind}-state`}>
        {projected ? (
          <>
            <span>
              <Badge tone={projected.enabled ? 'success' : 'neutral'}>Live</Badge>{' '}
              {!projected.enabled
                ? 'turned off'
                : state?.worker
                  ? `${q.receiving} · ${state.state?.inFlight ?? 0} in flight`
                  : `waiting for a worker to ${q.receiving === 'pulling' ? 'pull' : 'receive'} it`}
              {state &&
                ` · last day: ${state.lastDay.messages} message${state.lastDay.messages === 1 ? '' : 's'}, ${state.lastDay.failed} failed`}
              {state && state.lastDay.deadLettered > 0 && ` (${state.lastDay.deadLettered} dead-lettered)`}
              {state?.state?.lastMessageAt &&
                ` · last message ${new Date(state.state.lastMessageAt).toLocaleString()}`}
            </span>
            {state?.state?.lastError && (
              <span className="text-danger">
                {state.state.lastErrorAt ? `${new Date(state.state.lastErrorAt).toLocaleString()}: ` : ''}
                {state.state.lastError}
              </span>
            )}
          </>
        ) : kind === 'pubsub' ? (
          'Pulls once you publish.'
        ) : (
          'Receives once you publish.'
        )}
      </div>
    </div>
  )
}

/** Topics as typed: comma-separated, blanks dropped. */
function parseTopics(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** A Kafka trigger's own settings (M26): topics, its consumer group, where a new group starts, retries, dead letters. */
function KafkaFields({
  trigger,
  patch,
  at,
  number,
}: {
  trigger: KafkaTrigger
  patch: (fields: Record<string, unknown>) => void
  at: (field: string) => Diagnostic[]
  number: (value: string, max: number) => number | undefined
}) {
  const stored = (trigger.topics ?? []).join(', ')
  const [topics, setTopics] = useState(stored)
  // The text is the card's own (so a trailing comma survives typing), but follows the trigger when it changes
  // elsewhere: another card removed above this one, undo, a collaborator.
  useEffect(() => {
    setTopics((text) => (parseTopics(text).join(', ') === stored ? text : stored))
  }, [stored])
  return (
    <>
      <Field label="Topics" hint="One or more, separated by commas.">
        <Input
          className={cn('font-mono', at('topics').length && 'border-danger')}
          placeholder="orders, refunds"
          data-testid="kafka-topics"
          value={topics}
          onChange={(e) => {
            setTopics(e.target.value)
            patch({ topics: parseTopics(e.target.value) })
          }}
        />
        <Problems problems={at('topics')} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Consumer group" hint="Leave empty for one of its own, named after this workflow.">
          <Input
            className="font-mono"
            placeholder="ow-<workflow id>-<name>"
            value={trigger.groupId ?? ''}
            onChange={(e) => patch({ groupId: e.target.value || undefined })}
          />
          <Problems problems={at('groupId')} />
        </Field>
        <Field label="A new group starts at" hint="Only until it has committed offsets.">
          <Select value={trigger.startAt ?? 'latest'} onChange={(e) => patch({ startAt: e.target.value })}>
            <option value="latest">New messages only</option>
            <option value="earliest">The topics' beginning</option>
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Attempts" hint="Runs per message.">
          <Input
            type="number"
            min={1}
            max={20}
            placeholder="3"
            data-testid="kafka-maxAttempts"
            value={trigger.maxAttempts ?? ''}
            onChange={(e) => patch({ maxAttempts: number(e.target.value, 20) })}
          />
          <Problems problems={at('maxAttempts')} />
        </Field>
        <Field label="Retry after (s)" hint="Doubling, at most 15 min.">
          <Input
            type="number"
            min={1}
            max={900}
            placeholder="10"
            value={trigger.retryBackoffSeconds ?? ''}
            onChange={(e) => patch({ retryBackoffSeconds: number(e.target.value, 900) })}
          />
          <Problems problems={at('retryBackoffSeconds')} />
        </Field>
        <Field label="Dead-letter topic" hint="Empty: dropped after the last attempt.">
          <Input
            className={cn('font-mono', at('deadLetterTopic').length && 'border-danger')}
            placeholder="orders.dlt"
            data-testid="kafka-deadLetterTopic"
            value={trigger.deadLetterTopic ?? ''}
            onChange={(e) => patch({ deadLetterTopic: e.target.value.trim() || undefined })}
          />
          <Problems problems={at('deadLetterTopic')} />
        </Field>
      </div>
    </>
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
