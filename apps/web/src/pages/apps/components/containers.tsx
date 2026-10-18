import { X } from 'lucide-react'
import { useContext } from 'react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ChildGrid, EditingContext, ShownModalContext } from '../grid-context'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'

/** A box holding other components on its own grid. */
export function ContainerRenderer({ component, definition }: RendererProps) {
  const title = useAppValue<string>(`${component.name}.title`)
  const border = useAppValue<boolean>(`${component.name}.showBorder`)
  return (
    <div className={cn('flex h-full flex-col rounded-lg p-4', border && 'border border-border bg-surface')}>
      {title && <h2 className="mb-2 text-base font-bold">{title}</h2>}
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
      className="flex h-full flex-col rounded-lg border border-border bg-surface p-4"
      aria-label={title || name}
      onSubmit={(e) => {
        e.preventDefault()
        host.call(name, 'submit')
      }}
    >
      {title && <h2 className="mb-2 text-base font-bold">{title}</h2>}
      <div className="min-h-0 flex-1">
        <ChildGrid definition={definition} parent={name} />
      </div>
      <div className="flex justify-end pt-2">
        <button type="submit" disabled={disabled} className={buttonVariants({ variant: 'primary' })}>
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
          'relative w-full rounded-lg bg-surface p-6 text-ink shadow-menu',
          MODAL_WIDTHS[size] ?? MODAL_WIDTHS.medium,
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">{title || name}</h2>
          <button
            type="button"
            title="Close"
            onClick={close}
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), '-my-1 -mr-2')}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-4 max-h-[70vh] overflow-y-auto">
          <ChildGrid definition={definition} parent={name} />
        </div>
      </div>
    </div>
  )
}
