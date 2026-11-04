import { containerViews } from '@ow/app-definition'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useContext, useEffect } from 'react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ChildGrid, EditingContext, ShownModalContext, shownViews } from '../grid-context'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'

const PADDING = { none: 'p-0', small: 'p-2', medium: 'p-4', large: 'p-6' } as const
const BACKGROUNDS: Record<string, string> = {
  surface: 'bg-surface',
  canvas: 'bg-canvas',
  accent: 'bg-accent-soft',
}
/** A color written as one: hex, rgb(), hsl(); nothing else goes into a style. */
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i

/**
 * A box holding other components on its own grid; with views (M24), one grid per view, the shown one switched by
 * tabs (or by `setView`): only its components render. Its header (title, tabs, the fold button and the `header`
 * slot) and its `footer` slot stay put; the content scrolls inside it when `scroll` is on. A collapsible container
 * folds to its header in a running app (the editor keeps it open, marked as folded).
 */
export function ContainerRenderer({ component, definition }: RendererProps) {
  const host = useAppHostContext()
  const editing = useContext(EditingContext)
  const name = component.name
  const title = useAppValue<string>(`${name}.title`)
  const border = useAppValue<boolean>(`${name}.showBorder`)
  const showTabs = useAppValue<boolean>(`${name}.showTabs`) !== false
  const collapsible = useAppValue<boolean>(`${name}.collapsible`) === true
  const expanded = useAppValue<boolean>(`${name}.expanded`) !== false
  const scroll = useAppValue<boolean>(`${name}.scroll`) !== false
  const background = useAppValue<string>(`${name}.background`)
  const padding = useAppValue<keyof typeof PADDING>(`${name}.padding`)
  // Names as written (children are placed in them by name); labels as evaluated (they may be templates).
  const evaluated = useAppValue<unknown>(`${name}.views`)
  const current = useAppValue<string>(`${name}.currentView`)
  const views = containerViews(component)
  const shown = views.length ? (views.some((v) => v.name === current) ? current : views[0]!.name) : undefined
  useEffect(() => {
    if (editing && shown) shownViews.set(name, shown)
  })
  const label = (view: string) => {
    const found = Array.isArray(evaluated)
      ? (evaluated as { name?: unknown; label?: unknown }[]).find((v) => v?.name === view)
      : undefined
    return typeof found?.label === 'string' && found.label ? found.label : view
  }
  const inSlot = (slot: string) => definition.components.some((c) => c.parent === name && c.slot === slot)
  const hasHeader = inSlot('header')
  const hasFooter = inSlot('footer')
  const folded = collapsible && !expanded && !editing
  const tabs = views.length > 0 && showTabs && !folded
  const named = typeof background === 'string' ? BACKGROUNDS[background] : undefined
  const color =
    typeof background === 'string' && !named && COLOR.test(background.trim()) ? background.trim() : undefined
  const body = cn('min-h-0 flex-1', scroll && 'overflow-auto')
  return (
    <div
      className={cn(
        'flex h-full flex-col rounded-lg',
        PADDING[padding ?? 'medium'] ?? PADDING.medium,
        border && 'border border-border',
        named ?? (border && 'bg-surface'),
      )}
      style={color ? { background: color } : undefined}
    >
      {(title || tabs || collapsible || hasHeader) && (
        <div className={cn('flex flex-wrap items-end gap-x-4 gap-y-1', !folded && 'mb-2')}>
          {collapsible && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Fold' : 'Unfold'} ${title || name}`}
              className="self-center rounded p-0.5 text-muted hover:bg-canvas hover:text-ink"
              onClick={() => host.call(name, 'toggle')}
            >
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          )}
          {title && <h2 className="text-base font-bold">{title}</h2>}
          {editing && collapsible && !expanded && (
            <span className="self-center rounded bg-subtle px-1.5 text-[11px] text-muted">
              folded in the app
            </span>
          )}
          {tabs && (
            <div role="tablist" aria-label={title || name} className="flex gap-1 border-b border-border">
              {views.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  role="tab"
                  aria-selected={v.name === shown}
                  className={cn(
                    '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium',
                    v.name === shown
                      ? 'border-accent text-accent'
                      : 'border-transparent text-muted hover:text-ink',
                  )}
                  onClick={() => host.call(name, 'setView', [v.name])}
                >
                  {label(v.name)}
                </button>
              ))}
            </div>
          )}
          {hasHeader && !folded && (
            <div className="min-w-0 flex-1" data-slot="header">
              <ChildGrid definition={definition} parent={name} slot="header" />
            </div>
          )}
        </div>
      )}
      {folded ? null : shown ? (
        <div className={body} role="tabpanel" aria-label={label(shown)}>
          <ChildGrid key={shown} definition={definition} parent={name} slot={shown} />
        </div>
      ) : (
        <div className={body}>
          <ChildGrid definition={definition} parent={name} />
        </div>
      )}
      {hasFooter && !folded && (
        <div className="pt-2" data-slot="footer">
          <ChildGrid definition={definition} parent={name} slot="footer" />
        </div>
      )}
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
