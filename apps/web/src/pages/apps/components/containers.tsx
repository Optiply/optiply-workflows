import { X } from 'lucide-react'
import { useContext } from 'react'
import { cn } from '@/lib/utils'
import { ChildGrid, EditingContext, ShownModalContext } from '../grid-context'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'

/** A box holding other components on its own grid. */
export function ContainerRenderer({ component, definition }: RendererProps) {
  const title = useAppValue<string>(`${component.name}.title`)
  const border = useAppValue<boolean>(`${component.name}.showBorder`)
  return (
    <div className={cn('flex h-full flex-col rounded-lg p-3', border && 'border border-border bg-surface')}>
      {title && <h2 className="mb-2 text-sm font-semibold">{title}</h2>}
      <div className="min-h-0 flex-1">
        <ChildGrid definition={definition} parent={component.name} />
      </div>
    </div>
  )
}

/** A container whose inputs make up `form.data`, with a submit button. */
export function FormRenderer({ component, definition }: RendererProps) {
  const host = useAppHostContext()
  const name = component.name
  const title = useAppValue<string>(`${name}.title`)
  const submitText = useAppValue<string>(`${name}.submitText`)
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  return (
    // The runtime checks required inputs (and says which); the browser's own checks would stop it hearing about it.
    <form
      noValidate
      className="flex h-full flex-col rounded-lg border border-border bg-surface p-3"
      aria-label={title || name}
      onSubmit={(e) => {
        e.preventDefault()
        host.call(name, 'submit')
      }}
    >
      {title && <h2 className="mb-2 text-sm font-semibold">{title}</h2>}
      <div className="min-h-0 flex-1">
        <ChildGrid definition={definition} parent={name} />
      </div>
      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={disabled}
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent shadow-sm hover:bg-accent/90 disabled:opacity-50"
        >
          {submitText || 'Submit'}
        </button>
      </div>
    </form>
  )
}

const MODAL_WIDTHS = { small: 'max-w-md', medium: 'max-w-2xl', large: 'max-w-5xl' } as const

/** Opens over the page while `isOpen` (in the editor, while it or something in it is selected). */
export function ModalRenderer({ component, definition }: RendererProps) {
  const host = useAppHostContext()
  const editing = useContext(EditingContext)
  const shown = useContext(ShownModalContext)
  const name = component.name
  const isOpen = useAppValue<boolean>(`${name}.isOpen`)
  const title = useAppValue<string>(`${name}.title`)
  const size = useAppValue<keyof typeof MODAL_WIDTHS>(`${name}.size`)
  const outside = useAppValue<boolean>(`${name}.closeOnOutsideClick`)
  if (editing ? shown.name !== name : !isOpen) return null
  const close = () => (editing ? shown.close() : host.call(name, 'close'))
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-app/80 p-4 pt-[8vh]">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={() => (outside || editing) && close()}
      />
      <div
        role="dialog"
        aria-modal="true"
        data-canvas-modal={editing || undefined}
        aria-label={title || name}
        className={cn(
          'relative w-full rounded-xl border border-border bg-surface shadow-lg',
          MODAL_WIDTHS[size] ?? MODAL_WIDTHS.medium,
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-semibold">{title || name}</h2>
          <button
            type="button"
            title="Close"
            onClick={close}
            className="rounded p-1 text-muted hover:bg-canvas hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <ChildGrid definition={definition} parent={name} />
        </div>
      </div>
    </div>
  )
}
