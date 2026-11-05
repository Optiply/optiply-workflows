import { Paperclip, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { FIELD } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppValue } from '../runtime/react'
import { CONTROL, Labelled, normalizeOptions, useChange, useCommon } from './inputs'

/*
 * Session 41's inputs, after Retool's palette: text area, switch, checkbox group, radio group, segmented control,
 * date range and file input. Like the first inputs, each sets its `value` and fires `change`.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function TextAreaRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const value = useAppValue<unknown>(`${name}.value`)
  const rows = useAppValue<number | null>(`${name}.rows`)
  const { disabled, required, placeholder } = useCommon(name)
  const change = useChange(name)
  return (
    <Labelled name={name} id={id}>
      <textarea
        id={id}
        rows={rows ?? 4}
        className={cn('min-h-0 w-full flex-1 resize-none rounded-md px-2.5 py-1.5', FIELD)}
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        onChange={(e) => change(e.target.value)}
      />
    </Labelled>
  )
}

export function SwitchRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const value = useAppValue<boolean>(`${name}.value`) === true
  const label = useAppValue<string>(`${name}.label`)
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  const change = useChange(name)
  return (
    <div className="flex h-full items-center gap-2">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label || name}
        disabled={disabled}
        onClick={() => change(!value)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-50',
          value ? 'bg-accent' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'inline-block size-4 rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-4.5' : 'translate-x-0.5',
          )}
        />
      </button>
      <label htmlFor={id} className="truncate text-sm">
        {label || name}
      </label>
    </div>
  )
}

/** A label over a group of choices, as a fieldset (radio groups, checkbox groups). */
function ChoiceGroup({
  name,
  horizontal,
  children,
}: {
  name: string
  horizontal: boolean
  children: React.ReactNode
}) {
  const label = useAppValue<string>(`${name}.label`)
  const required = useAppValue<boolean>(`${name}.required`)
  return (
    <fieldset className="flex h-full min-w-0 flex-col gap-1 overflow-auto">
      {label && (
        <legend className="mb-1 truncate text-xs font-medium text-ink">
          {label}
          {required && (
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          )}
        </legend>
      )}
      <div className={cn('flex gap-x-4 gap-y-1.5', horizontal ? 'flex-row flex-wrap' : 'flex-col')}>
        {children}
      </div>
    </fieldset>
  )
}

export function CheckboxGroupRenderer({ component }: RendererProps) {
  const name = component.name
  const raw = useAppValue<unknown>(`${name}.value`)
  const value = Array.isArray(raw) ? raw : []
  const options = normalizeOptions(useAppValue<unknown>(`${name}.options`))
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  const horizontal = useAppValue<string>(`${name}.orientation`) === 'horizontal'
  const change = useChange(name)
  return (
    <ChoiceGroup name={name} horizontal={horizontal}>
      {options.map((o) => {
        const checked = value.some((v) => same(v, o.value))
        return (
          <label key={`${o.label}:${JSON.stringify(o.value)}`} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 cursor-pointer rounded accent-accent"
              checked={checked}
              disabled={disabled}
              // In the options' order, whatever order they were checked in.
              onChange={() =>
                change(
                  options
                    .filter((x) => (same(x.value, o.value) ? !checked : value.some((v) => same(v, x.value))))
                    .map((x) => x.value),
                )
              }
            />
            <span className="truncate">{o.label}</span>
          </label>
        )
      })}
    </ChoiceGroup>
  )
}

export function RadioGroupRenderer({ component }: RendererProps) {
  const name = component.name
  const group = useId()
  const value = useAppValue<unknown>(`${name}.value`)
  const options = normalizeOptions(useAppValue<unknown>(`${name}.options`))
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  const horizontal = useAppValue<string>(`${name}.orientation`) === 'horizontal'
  const change = useChange(name)
  return (
    <ChoiceGroup name={name} horizontal={horizontal}>
      {options.map((o) => (
        <label key={`${o.label}:${JSON.stringify(o.value)}`} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={group}
            className="size-4 cursor-pointer accent-accent"
            checked={same(value, o.value)}
            disabled={disabled}
            onChange={() => change(o.value)}
          />
          <span className="truncate">{o.label}</span>
        </label>
      ))}
    </ChoiceGroup>
  )
}

export function SegmentedControlRenderer({ component }: RendererProps) {
  const name = component.name
  const value = useAppValue<unknown>(`${name}.value`)
  const options = normalizeOptions(useAppValue<unknown>(`${name}.options`))
  const label = useAppValue<string>(`${name}.label`)
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  const change = useChange(name)
  return (
    <div className="flex h-full flex-col justify-end gap-1">
      {label && <span className="truncate text-xs font-medium text-ink">{label}</span>}
      <div role="radiogroup" aria-label={label || name} className="flex h-8 rounded-md bg-canvas p-0.5">
        {options.map((o) => {
          const on = same(value, o.value)
          return (
            // biome-ignore lint/a11y/useSemanticElements: segments are buttons styled side by side, announced as radios
            <button
              key={`${o.label}:${JSON.stringify(o.value)}`}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => change(o.value)}
              className={cn(
                'min-w-0 flex-1 truncate rounded px-2 text-sm',
                on ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DateRangeRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const raw = useAppValue<{ start?: unknown; end?: unknown } | null>(`${name}.value`)
  const start = typeof raw?.start === 'string' ? raw.start.slice(0, 10) : ''
  const end = typeof raw?.end === 'string' ? raw.end.slice(0, 10) : ''
  const { disabled, required } = useCommon(name)
  const min = useAppValue<string | null>(`${name}.min`)
  const max = useAppValue<string | null>(`${name}.max`)
  const change = useChange(name)
  const set = (next: { start: string; end: string }) =>
    change(next.start || next.end ? { start: next.start || null, end: next.end || null } : null)
  return (
    <Labelled name={name} id={id}>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="date"
          aria-label="From"
          className={CONTROL}
          value={start}
          min={min ?? undefined}
          max={end || max || undefined}
          disabled={disabled}
          required={required}
          onChange={(e) => set({ start: e.target.value, end })}
        />
        <span aria-hidden className="text-muted">
          –
        </span>
        <input
          type="date"
          aria-label="To"
          className={CONTROL}
          value={end}
          min={start || min || undefined}
          max={max ?? undefined}
          disabled={disabled}
          required={required}
          onChange={(e) => set({ start, end: e.target.value })}
        />
      </div>
    </Labelled>
  )
}

/** The largest file a file input reads (its contents go to the app as base64). */
const MAX_FILE_BYTES = 5 * 1024 * 1024

interface PickedFile {
  name: string
  type: string
  size: number
  base64: string
}

function readFile(file: File): Promise<PickedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ name: file.name, type: file.type, size: file.size, base64: url.slice(url.indexOf(',') + 1) })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function FileInputRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const raw = useAppValue<unknown>(`${name}.value`)
  const files = (Array.isArray(raw) ? raw : []) as PickedFile[]
  const { disabled, required } = useCommon(name)
  const accept = useAppValue<string>(`${name}.accept`)
  const multiple = useAppValue<boolean>(`${name}.multiple`)
  const change = useChange(name)
  const input = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <Labelled name={name} id={id}>
      <div className={cn('flex h-8 items-center gap-2 rounded-md px-1.5', FIELD)}>
        <input
          ref={input}
          id={id}
          type="file"
          className="sr-only"
          accept={accept || undefined}
          multiple={multiple}
          disabled={disabled}
          required={required && !files.length}
          onChange={async (e) => {
            const picked = [...(e.target.files ?? [])]
            e.target.value = ''
            const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES)
            if (tooBig) {
              setProblem(`${tooBig.name} is over 5 MB`)
              return
            }
            setProblem(null)
            try {
              const read = await Promise.all(picked.map(readFile))
              change(multiple ? [...files, ...read] : read.slice(0, 1))
            } catch {
              setProblem('The file could not be read')
            }
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          className="flex shrink-0 items-center gap-1 rounded bg-canvas px-2 py-0.5 text-xs font-medium hover:bg-accent-soft"
        >
          <Paperclip className="size-3.5" /> Choose
        </button>
        <span className={cn('min-w-0 flex-1 truncate text-xs', problem ? 'text-danger' : 'text-muted')}>
          {problem ?? (files.length ? files.map((f) => f.name).join(', ') : 'No file chosen')}
        </span>
        {files.length > 0 && !disabled && (
          <button
            type="button"
            title="Remove the files"
            onClick={() => change([])}
            className="text-muted hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </Labelled>
  )
}
