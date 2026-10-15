import { type ReactNode, useId } from 'react'
import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'

const CONTROL =
  'h-8 w-full rounded-md border border-border bg-surface px-2.5 text-sm shadow-xs outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-canvas disabled:text-muted'

/** What every input shares: its label (with a mark when required) and the control. */
function Labelled({ name, id, children }: { name: string; id: string; children: ReactNode }) {
  const label = useAppValue<string>(`${name}.label`)
  const required = useAppValue<boolean>(`${name}.required`)
  return (
    <div className="flex h-full flex-col justify-end gap-1">
      {label && (
        <label htmlFor={id} className="truncate text-xs font-medium text-ink">
          {label}
          {required && (
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          )}
        </label>
      )}
      {children}
    </div>
  )
}

/** Sets the input's value and fires `change`, the way every input reports what the user did. */
function useChange(name: string) {
  const host = useAppHostContext()
  return (value: unknown) => {
    host.set({ [`${name}.value`]: value })
    host.fire(name, 'change')
  }
}

function useCommon(name: string) {
  return {
    disabled: useAppValue<boolean>(`${name}.disabled`),
    required: useAppValue<boolean>(`${name}.required`),
    placeholder: useAppValue<string>(`${name}.placeholder`),
  }
}

export function TextInputRenderer({ component }: RendererProps) {
  const host = useAppHostContext()
  const id = useId()
  const name = component.name
  const value = useAppValue<unknown>(`${name}.value`)
  const { disabled, required, placeholder } = useCommon(name)
  const change = useChange(name)
  return (
    <Labelled name={name} id={id}>
      <input
        id={id}
        className={CONTROL}
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          // Inside a form, Enter submits the form instead.
          if (e.key === 'Enter' && !e.currentTarget.form) host.fire(name, 'submit')
        }}
      />
    </Labelled>
  )
}

export function NumberInputRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const value = useAppValue<number | null>(`${name}.value`)
  const { disabled, required, placeholder } = useCommon(name)
  const min = useAppValue<number | null>(`${name}.min`)
  const max = useAppValue<number | null>(`${name}.max`)
  const step = useAppValue<number | null>(`${name}.step`)
  const change = useChange(name)
  return (
    <Labelled name={name} id={id}>
      <input
        id={id}
        type="number"
        className={CONTROL}
        value={value === null || value === undefined ? '' : value}
        min={min ?? undefined}
        max={max ?? undefined}
        step={step ?? 'any'}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        onChange={(e) => change(e.target.value === '' ? null : e.target.valueAsNumber)}
      />
    </Labelled>
  )
}

export function DateInputRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const value = useAppValue<string | null>(`${name}.value`)
  const { disabled, required } = useCommon(name)
  const min = useAppValue<string | null>(`${name}.min`)
  const max = useAppValue<string | null>(`${name}.max`)
  const change = useChange(name)
  return (
    <Labelled name={name} id={id}>
      <input
        id={id}
        type="date"
        className={CONTROL}
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        min={min ?? undefined}
        max={max ?? undefined}
        disabled={disabled}
        required={required}
        onChange={(e) => change(e.target.value || null)}
      />
    </Labelled>
  )
}

/** Options are plain values or `{ label, value }` objects. */
function normalizeOptions(options: unknown): { label: string; value: unknown }[] {
  if (!Array.isArray(options)) return []
  return options.map((o) =>
    o && typeof o === 'object' && 'value' in o
      ? {
          label: String((o as { label?: unknown }).label ?? (o as { value: unknown }).value),
          value: (o as { value: unknown }).value,
        }
      : { label: String(o), value: o },
  )
}

export function SelectRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const value = useAppValue<unknown>(`${name}.value`)
  const options = normalizeOptions(useAppValue<unknown>(`${name}.options`))
  const { disabled, required, placeholder } = useCommon(name)
  const change = useChange(name)
  // Values can be anything (numbers, objects): the <select> works with positions.
  const index = options.findIndex((o) => JSON.stringify(o.value) === JSON.stringify(value))
  return (
    <Labelled name={name} id={id}>
      <select
        id={id}
        className={cn(CONTROL, index === -1 && 'text-muted')}
        value={index === -1 ? '' : String(index)}
        disabled={disabled}
        required={required}
        onChange={(e) => change(e.target.value === '' ? null : options[Number(e.target.value)]!.value)}
      >
        <option value="">{placeholder || 'Select…'}</option>
        {options.map((o, i) => (
          <option key={`${o.label}:${JSON.stringify(o.value)}`} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    </Labelled>
  )
}

export function CheckboxRenderer({ component }: RendererProps) {
  const id = useId()
  const name = component.name
  const value = useAppValue<boolean>(`${name}.value`)
  const label = useAppValue<string>(`${name}.label`)
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  const change = useChange(name)
  return (
    <div className="flex h-full items-center gap-2">
      <input
        id={id}
        type="checkbox"
        className="size-4 accent-accent"
        checked={value === true}
        disabled={disabled}
        onChange={(e) => change(e.target.checked)}
      />
      <label htmlFor={id} className="truncate text-sm">
        {label || name}
      </label>
    </div>
  )
}
