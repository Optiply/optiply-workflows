import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronRight, Info, XCircle } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'
import { formatStatistic } from './display-model'

/*
 * Session 41's presentation components, after Retool's palette: statistic, image, divider, alert, progress bar,
 * key value and JSON explorer. They show values; only the image fires an event (click).
 */

export function StatisticRenderer({ component }: RendererProps) {
  const name = component.name
  const label = useAppValue<string>(`${name}.label`)
  const value = useAppValue<unknown>(`${name}.value`)
  const format = useAppValue<string>(`${name}.format`)
  const currency = useAppValue<string>(`${name}.currency`)
  const decimals = useAppValue<number | null>(`${name}.decimals`)
  const caption = useAppValue<string>(`${name}.caption`)
  const trend = useAppValue<number | null>(`${name}.trend`)
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 overflow-hidden rounded-lg bg-surface px-4 py-3">
      <span className="truncate text-xs font-medium text-muted">{label}</span>
      <span className="truncate text-2xl leading-8 font-semibold tabular-nums">
        {formatStatistic(value, format, { currency, decimals })}
      </span>
      {(typeof trend === 'number' || caption) && (
        <span className="flex items-center gap-1 truncate text-xs text-muted">
          {typeof trend === 'number' && trend !== 0 && (
            <span className={cn('flex items-center font-medium', trend > 0 ? 'text-success' : 'text-danger')}>
              {trend > 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
              {formatStatistic(
                Math.abs(trend),
                format === 'currency' ? 'currency' : format === 'percent' ? 'percent' : 'number',
                { currency, decimals },
              )}
            </span>
          )}
          {caption}
        </span>
      )}
    </div>
  )
}

const FITS = { contain: 'object-contain', cover: 'object-cover', fill: 'object-fill' } as const

export function ImageRenderer({ component }: RendererProps) {
  const host = useAppHostContext()
  const name = component.name
  const src = useAppValue<string>(`${name}.src`)
  const alt = useAppValue<string>(`${name}.alt`)
  const fit = useAppValue<keyof typeof FITS>(`${name}.fit`)
  const safe = typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim())
  if (!safe)
    return (
      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-xs text-muted">
        {src ? 'Only http(s) and data:image sources show' : 'No image source'}
      </div>
    )
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noNoninteractiveElementInteractions: a click handler is the app's own, optional
    <img
      src={src}
      alt={alt || ''}
      referrerPolicy="no-referrer"
      onClick={() => host.fire(name, 'click')}
      className={cn('h-full w-full rounded-md', FITS[fit] ?? FITS.contain)}
    />
  )
}

export function DividerRenderer({ component }: RendererProps) {
  const label = useAppValue<string>(`${component.name}.label`)
  return (
    <div className="flex h-full items-center gap-3">
      <hr className="flex-1 border-border" />
      {label && <span className="shrink-0 text-xs font-medium text-muted">{label}</span>}
      {label && <hr className="flex-1 border-border" />}
    </div>
  )
}

const TONES = {
  info: { icon: Info, className: 'border-accent/30 bg-accent-soft text-ink', iconClass: 'text-accent' },
  success: {
    icon: CheckCircle2,
    className: 'border-success/30 bg-success-soft text-ink',
    iconClass: 'text-success',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-warning/30 bg-warning-soft text-ink',
    iconClass: 'text-warning-strong',
  },
  error: { icon: XCircle, className: 'border-danger/30 bg-danger-soft text-ink', iconClass: 'text-danger' },
} as const

export function AlertRenderer({ component }: RendererProps) {
  const name = component.name
  const title = useAppValue<string>(`${name}.title`)
  const description = useAppValue<string>(`${name}.description`)
  const tone = TONES[useAppValue<keyof typeof TONES>(`${name}.tone`)] ?? TONES.info
  const Icon = tone.icon
  return (
    <div
      role="status"
      className={cn('flex h-full gap-2.5 overflow-auto rounded-lg border px-3 py-2.5', tone.className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone.iconClass)} />
      <div className="min-w-0 text-sm">
        {title && <p className="font-medium">{title}</p>}
        {description && <p className="mt-0.5 whitespace-pre-wrap text-muted">{description}</p>}
      </div>
    </div>
  )
}

const BAR_TONES = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
} as const

export function ProgressBarRenderer({ component }: RendererProps) {
  const name = component.name
  const label = useAppValue<string>(`${name}.label`)
  const raw = useAppValue<number | null>(`${name}.value`)
  const showValue = useAppValue<boolean>(`${name}.showValue`)
  const tone = BAR_TONES[useAppValue<keyof typeof BAR_TONES>(`${name}.tone`)] ?? BAR_TONES.accent
  const value = Math.min(100, Math.max(0, typeof raw === 'number' && Number.isFinite(raw) ? raw : 0))
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      {(label || showValue) && (
        <div className="flex justify-between gap-2 text-xs">
          <span className="truncate font-medium">{label}</span>
          {showValue && <span className="text-muted tabular-nums">{Math.round(value)}%</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-label={label || name}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-full bg-canvas"
      >
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

const cellText = (value: unknown) =>
  value === null || value === undefined
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)

export function KeyValueRenderer({ component }: RendererProps) {
  const data = useAppValue<unknown>(`${component.name}.data`)
  const entries = data && typeof data === 'object' && !Array.isArray(data) ? Object.entries(data) : []
  if (!entries.length) return <p className="py-1 text-sm text-muted">No data</p>
  return (
    <dl className="grid h-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)] content-start overflow-auto text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="col-span-2 grid grid-cols-subgrid border-b border-border/60 py-1.5">
          <dt className="truncate pr-3 text-muted">{key}</dt>
          <dd className="break-words">{cellText(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function JsonExplorerRenderer({ component }: RendererProps) {
  const value = useAppValue<unknown>(`${component.name}.value`)
  const depth = useAppValue<number | null>(`${component.name}.expandDepth`)
  return (
    <div className="h-full overflow-auto rounded-md bg-canvas p-2 font-mono text-xs">
      <JsonNode value={value} depth={0} open={depth ?? 1} />
    </div>
  )
}

function JsonNode({
  name,
  value,
  depth,
  open,
}: {
  name?: string
  value: unknown
  depth: number
  open: number
}) {
  const [expanded, setExpanded] = useState(depth < open)
  const key = name !== undefined && <span className="text-accent">{name}: </span>
  if (value === null || typeof value !== 'object')
    return (
      <div className="truncate" style={{ paddingLeft: depth * 12 }}>
        {key}
        <span className={typeof value === 'string' ? 'text-success' : 'text-warning-strong'}>
          {value === undefined ? 'undefined' : JSON.stringify(value)}
        </span>
      </div>
    )
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value)
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-0.5 hover:text-accent"
        style={{ paddingLeft: depth * 12 }}
      >
        <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        {key}
        <span className="text-muted">{summary}</span>
      </button>
      {expanded &&
        entries.map(([k, v]) => <JsonNode key={k} name={k} value={v} depth={depth + 1} open={open} />)}
    </div>
  )
}
