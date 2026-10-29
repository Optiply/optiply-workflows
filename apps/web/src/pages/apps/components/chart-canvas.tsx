/**
 * The Chart's canvas, with Chart.js (MIT). Its own chunk: Chart.js loads with the first chart an app shows.
 * Marks follow the dataviz rules: bars at most 24 px thick with a 4 px rounded data end, 2 px lines with no
 * resting dots (8 px ringed dots on hover), area washes at 10 %, a 2 px gap in the surface color between touching
 * marks, hairline gridlines, one y axis with compact ticks, a legend from two series up, and a tooltip listing
 * every series at the hovered x (a crosshair on lines and areas).
 */
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  type ChartConfiguration,
  type ChartType,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  type Plugin,
  PointElement,
  Tooltip,
} from 'chart.js'
import { useEffect, useRef } from 'react'
import { type ChartModel, compactNumber, formatTime, sliceColors, withAlpha } from './chart-model'

Chart.register(
  BarController,
  LineController,
  PieController,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  Filler,
  Legend,
  Tooltip,
)
Chart.defaults.font.family =
  '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
Chart.defaults.font.size = 12

declare module 'chart.js' {
  interface PluginOptionsByType<TType extends ChartType> {
    owCrosshair?: { color?: string }
  }
}

/**
 * A vertical hairline at the hovered x, so lines are read by position rather than by hitting a 2 px stroke. Its color
 * is an option (`plugins.owCrosshair.color`), so an update in place (a new theme) recolors it.
 */
const crosshair: Plugin = {
  id: 'owCrosshair',
  afterDatasetsDraw(chart, _args, options: { color?: string }) {
    const active = chart.tooltip?.getActiveElements() ?? []
    if (!active.length) return
    const x = active[0]!.element.x
    const { top, bottom } = chart.chartArea
    const ctx = chart.ctx
    ctx.save()
    ctx.strokeStyle = options.color ?? '#999'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, top)
    ctx.lineTo(Math.round(x) + 0.5, bottom)
    ctx.stroke()
    ctx.restore()
  },
}

function config(model: ChartModel, opts: { stacked: boolean; showLegend: boolean }): ChartConfiguration {
  const { kind } = model
  const { ink } = model.palette
  const lines = kind === 'line' || kind === 'area'
  // Legend keys mirror the mark: a short line for lines and areas, a square for bars and slices.
  const legend = {
    display: opts.showLegend && (kind === 'pie' || model.series.length >= 2),
    position: 'bottom' as const,
    labels: {
      usePointStyle: true,
      pointStyle: lines ? ('line' as const) : ('rect' as const),
      ...(lines && { pointStyleWidth: 16 }),
      boxWidth: 10,
      boxHeight: 10,
      color: ink.secondary,
      // A line's default key takes the hover dots' white ring as its stroke: color it with the series instead.
      // (Only for lines: bars and pies keep their own keys; a pie's are its slices.)
      ...(lines && {
        generateLabels: (chart: Chart) =>
          Chart.defaults.plugins.legend.labels
            .generateLabels(chart)
            .map((item) =>
              item.datasetIndex === undefined
                ? item
                : { ...item, strokeStyle: model.series[item.datasetIndex]?.color, lineWidth: 2 },
            ),
      }),
    },
  }
  const tooltip = {
    backgroundColor: ink.surface,
    titleColor: ink.secondary,
    bodyColor: ink.text,
    borderColor: ink.grid,
    borderWidth: 1,
    padding: 8,
    usePointStyle: true,
    boxWidth: 8,
    boxHeight: 8,
    callbacks: {
      // Tooltip rows are keyed with a short stroke of the series color, not a filled box.
      labelPointStyle: () => ({ pointStyle: 'line' as const, rotation: 0 }),
      labelColor: (item: { datasetIndex: number; dataIndex: number }) => {
        const color =
          kind === 'pie'
            ? sliceColors(model.labels.length, model.folded, model.palette)[item.dataIndex]!
            : (model.series[item.datasetIndex]?.color ?? ink.muted)
        return { borderColor: color, backgroundColor: color, borderWidth: 2 }
      },
      // A point's time, not its number (M24).
      title: (items: { dataIndex: number }[]) => (items[0] ? (model.labels[items[0].dataIndex] ?? '') : ''),
      // Values lead, labels follow.
      label: (item: { parsed: unknown; dataset: { label?: string }; label: string }) => {
        const v = kind === 'pie' ? (item.parsed as number) : (item.parsed as { y: number }).y
        const value = v === null || v === undefined ? '—' : v.toLocaleString()
        return ` ${value}  ${kind === 'pie' ? item.label : (item.dataset.label ?? '')}`
      },
    },
  }

  if (kind === 'pie') {
    const s = model.series[0]
    return {
      type: 'pie',
      data: {
        labels: model.labels,
        datasets: [
          {
            label: s?.label ?? '',
            data: s?.values ?? [],
            backgroundColor: sliceColors(model.labels.length, model.folded, model.palette),
            borderColor: ink.surface,
            borderWidth: 2,
            hoverOffset: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        color: ink.secondary,
        animation: false,
        plugins: { legend, tooltip },
      },
    }
  }

  const area = kind === 'area'
  const datasets = model.series.map((s, i) =>
    kind === 'bar'
      ? {
          type: 'bar' as const,
          label: s.label,
          data: s.values,
          backgroundColor: s.color,
          hoverBackgroundColor: withAlpha(s.color, 0.8),
          // The surface-colored edge is the 2 px gap between touching bars and stacked segments.
          borderColor: ink.surface,
          borderWidth: 2,
          borderRadius: 4,
          borderSkipped: 'start' as const,
          maxBarThickness: 24,
        }
      : {
          type: 'line' as const,
          label: s.label,
          // On a time axis (M24), each point at its time.
          data: model.time ? s.values.map((y, j) => ({ x: model.time!.values[j]!, y })) : s.values,
          borderColor: s.color,
          backgroundColor: area ? withAlpha(s.color, 0.1) : s.color,
          borderWidth: 2,
          borderCapStyle: 'round' as const,
          borderJoinStyle: 'round' as const,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: s.color,
          pointBorderColor: ink.surface,
          pointHoverBorderWidth: 2,
          pointHitRadius: 12,
          fill: area ? (opts.stacked && i > 0 ? '-1' : 'origin') : false,
        },
  )
  return {
    type: kind === 'bar' ? 'bar' : 'line',
    data: { labels: model.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      color: ink.secondary,
      animation: false,
      interaction: { mode: 'index', intersect: kind === 'bar' },
      plugins: { legend, tooltip, owCrosshair: { color: ink.axis } },
      scales: {
        x: model.time
          ? {
              // Time as a number line (M24): points by their time, gaps kept; ticks on days, Mondays, months or
              // years, labelled in the viewer's language (no date adapter needed).
              type: 'linear' as const,
              min: model.time.min,
              max: model.time.max,
              grid: { display: false },
              border: { color: ink.axis },
              afterBuildTicks: (axis: { ticks: { value: number }[] }) => {
                axis.ticks = model.time!.ticks.map((value) => ({ value }))
              },
              ticks: {
                color: ink.muted,
                maxRotation: 0,
                autoSkip: true,
                callback: (v: string | number) => formatTime(Number(v), model.time!.unit, model.time!.utc),
              },
            }
          : {
              stacked: opts.stacked,
              grid: { display: false },
              border: { color: ink.axis },
              ticks: { color: ink.muted, maxRotation: 0, autoSkip: true },
            },
        y: {
          stacked: opts.stacked,
          beginAtZero: true,
          grid: { color: ink.grid, lineWidth: 1 },
          border: { display: false },
          ticks: { color: ink.muted, callback: (v) => compactNumber(Number(v)), maxTicksLimit: 6 },
        },
      },
    },
    plugins: kind === 'bar' ? [] : [crosshair],
  }
}

export default function ChartCanvas({
  model,
  stacked,
  showLegend,
  label,
}: {
  model: ChartModel
  stacked: boolean
  showLegend: boolean
  label: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    const next = config(model, { stacked, showLegend })
    const current = chartRef.current
    // Same chart type: update in place (no flicker as data arrives); another type: start over.
    if (current && (current.config as { type?: string }).type === next.type) {
      current.data = next.data
      current.options = next.options ?? {}
      current.update('none')
      return
    }
    current?.destroy()
    chartRef.current = new Chart(canvasRef.current!, next)
  }, [model, stacked, showLegend])

  // Drawn before the web font arrived (there's no animation to redraw it): draw again once fonts have loaded.
  useEffect(() => {
    const redraw = () => chartRef.current?.update('none')
    document.fonts?.addEventListener('loadingdone', redraw)
    return () => document.fonts?.removeEventListener('loadingdone', redraw)
  }, [])

  useEffect(
    () => () => {
      chartRef.current?.destroy()
      chartRef.current = null
    },
    [],
  )

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} role="img" aria-label={label} />
    </div>
  )
}
