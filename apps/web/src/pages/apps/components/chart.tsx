import { lazy, Suspense, useMemo, useState } from 'react'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppValue } from '../runtime/react'
import { type ChartModel, chartModel } from './chart-model'

// Chart.js loads with the first chart.
const ChartCanvas = lazy(() => import('./chart-canvas'))

/**
 * A bar, line, area or pie chart of `data`. The x axis is `xKey` (or the first non-numeric key); the series are
 * `series` (or every numeric key). A Table view shows the same values without hovering, for the colors that are
 * light on white and for anyone who'd rather read numbers.
 */
export function ChartRenderer({ component }: RendererProps) {
  const name = component.name
  const title = useAppValue<string>(`${name}.title`)
  const kind = useAppValue<string>(`${name}.chartType`)
  const data = useAppValue<unknown>(`${name}.data`)
  const xKey = useAppValue<string>(`${name}.xKey`)
  const series = useAppValue<unknown>(`${name}.series`)
  const stacked = useAppValue<boolean>(`${name}.stacked`)
  const showLegend = useAppValue<boolean>(`${name}.showLegend`)
  const [asTable, setAsTable] = useState(false)
  const { theme } = useTheme()
  const model = useMemo(
    () => chartModel({ kind, data, xKey, series, theme }),
    [kind, data, xKey, series, theme],
  )
  const empty = !model.series.length || !model.labels.length
  const label = `${title || name}: ${model.kind} chart of ${model.series.map((s) => s.label).join(', ') || 'no data'}${model.xKey ? ` by ${model.xKey}` : ''}`

  return (
    <figure
      className="flex h-full flex-col rounded-lg border border-border bg-surface p-4"
      aria-label={title || name}
    >
      <figcaption className="mb-2 flex items-center gap-2">
        <span className="truncate text-base font-bold">{title}</span>
        {!empty && (
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable(!asTable)}
            className="ml-auto rounded px-1.5 py-0.5 text-xs text-muted hover:bg-canvas hover:text-ink"
          >
            {asTable ? 'Chart' : 'Table'}
          </button>
        )}
      </figcaption>
      <div className="relative min-h-0 flex-1">
        {empty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">No data to chart</div>
        ) : asTable ? (
          <ChartTable model={model} />
        ) : (
          <Suspense fallback={<div className="h-full animate-pulse rounded bg-canvas" />}>
            <ChartCanvas
              model={model}
              stacked={stacked === true}
              showLegend={showLegend !== false}
              label={label}
            />
          </Suspense>
        )}
      </div>
      {(model.omitted.length > 0 || model.folded > 0) && (
        <p className="mt-1 text-xs text-muted">
          {model.folded > 0 && `${model.folded} smaller slices are grouped as Other. `}
          {model.omitted.length > 0 &&
            `Not shown: ${model.omitted.join(', ')} (${model.kind === 'pie' ? 'a pie shows one series' : 'up to 8 series'}).`}
        </p>
      )}
    </figure>
  )
}

/** The chart's values as a table. */
function ChartTable({ model }: { model: ChartModel }) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-border text-left text-muted">
            <th className="px-2 py-1 font-medium">{model.xKey ?? ''}</th>
            {model.series.map((s) => (
              <th key={s.key} className="px-2 py-1 text-right font-medium">
                <span
                  className="mr-1.5 inline-block size-2 rounded-sm align-middle"
                  style={{ background: s.color }}
                />
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.labels.map((label, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions in the data (x labels can repeat)
            <tr key={`${i}:${label}`} className="border-b border-border/60">
              <td className="px-2 py-1">{label}</td>
              {model.series.map((s) => (
                <td
                  key={s.key}
                  className={cn('px-2 py-1 text-right tabular-nums', s.values[i] === null && 'text-muted')}
                >
                  {s.values[i] === null ? '—' : s.values[i]!.toLocaleString()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
