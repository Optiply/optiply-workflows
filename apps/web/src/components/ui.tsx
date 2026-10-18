import { cva, type VariantProps } from 'class-variance-authority'
import { Check, Copy, Loader2, X } from 'lucide-react'
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils'

/**
 * Optiply's buttons: `primary` (blue) for the main action, `secondary` (blue tint), `tertiary` (grey, the default),
 * `ghost` for icons and quiet actions, `danger` (red tint). 32px high; `sm` in dense toolbars and rows.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:shadow-focus disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent-strong disabled:bg-subtle disabled:text-faint',
        secondary:
          'bg-accent-soft text-accent hover:bg-accent-soft-hover hover:text-accent-strong disabled:bg-subtle disabled:text-faint',
        tertiary: 'bg-subtle text-muted hover:bg-app hover:text-ink disabled:text-faint',
        ghost: 'text-muted hover:bg-subtle hover:text-ink disabled:opacity-50',
        danger:
          'bg-danger-soft text-danger hover:bg-danger-soft-hover hover:text-danger-strong disabled:bg-subtle disabled:text-faint',
      },
      size: {
        sm: 'h-7 px-2.5 text-[13px]',
        md: 'h-8 px-4 text-sm',
        lg: 'h-10 px-4 text-sm',
        icon: 'size-8 text-sm',
      },
    },
    defaultVariants: { variant: 'tertiary', size: 'md' },
  },
)

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  disabled,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

/** Optiply's input look, shared by inputs, selects and text areas (and the app builder's inputs). */
export const FIELD =
  'border border-border bg-field text-sm text-ink outline-none transition-shadow enabled:hover:not-focus:ring-1 enabled:hover:not-focus:ring-border focus:border-transparent focus:shadow-focus aria-invalid:shadow-invalid disabled:text-faint'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('h-8 w-full rounded-md px-2.5', FIELD, className)} {...props} />
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper; callers pass htmlFor or nest the control
  return <label className={cn('text-sm font-medium text-ink', className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border border-border bg-surface', className)} {...props} />
}

/** A white container for a page's main content (a table with its tabs and filters), as Optiply's. */
export function PageContainer({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-panel bg-surface p-2 shadow-card', className)} {...props} />
}

const BADGE_TONES = {
  neutral: 'bg-subtle text-muted ring-divider',
  accent: 'bg-op-blue-1 text-op-blue-4 ring-op-blue-2',
  success: 'bg-op-green-1 text-op-green-4 ring-op-green-2',
  warning: 'bg-op-orange-1 text-op-orange-4 ring-op-orange-2',
  danger: 'bg-op-red-1 text-op-red-4 ring-op-red-2',
  yellow: 'bg-op-yellow-1 text-op-yellow-4 ring-op-yellow-2',
  purple: 'bg-op-purple-1 text-op-purple-4 ring-op-purple-2',
} as const
export type BadgeTone = keyof typeof BADGE_TONES

/** Optiply's tags: a tint with darker text, outlined with `outline`. */
export function Badge({
  className,
  tone = 'neutral',
  outline = false,
  ...props
}: ComponentProps<'span'> & { tone?: BadgeTone; outline?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-1 text-xs leading-4 font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        outline && 'ring-1',
        className,
      )}
      {...props}
    />
  )
}

export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
  return src ? (
    <img src={src} alt="" referrerPolicy="no-referrer" className={cn('size-7 rounded-full', className)} />
  ) : (
    <span
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent',
        className,
      )}
    >
      {initials}
    </span>
  )
}

/** A page's title with its actions on the right, over Optiply's divider. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-4 flex min-h-14 items-center justify-between gap-4 border-b-2 border-divider py-2">
      <div className="min-w-0">
        <h1 className="text-2xl leading-8 font-bold">{title}</h1>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** A small uppercase heading over a group of cards ("PURCHASING" in Optiply). */
export function SectionLabel({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn('mb-2 text-xs leading-4 font-semibold tracking-[1.8px] text-muted uppercase', className)}
      {...props}
    />
  )
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <Card className={cn('flex flex-col items-center px-6 py-16 text-center', className)}>
      <div className="mb-4 rounded-lg bg-accent-soft p-3 text-accent">{icon}</div>
      <h2 className="font-semibold">{title}</h2>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    </Card>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
      {error instanceof Error ? error.message : String(error)}
    </p>
  )
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12 text-muted">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

/** Optiply's data grid: 48px rows between lines, a quiet header, and an optional footer (`TableFooter`). */
export function Table({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm [&_tbody_tr:last-child_td]:border-b-0">{children}</table>
      </div>
      {footer}
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th className={cn('h-12 border-b border-border px-3 text-xs font-medium text-muted', className)}>
      {children}
    </th>
  )
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('h-12 border-b border-border px-3 py-2 align-middle', className)} {...props} />
}

/** Optiply's link in a table: blue and underlined. */
export const linkClass =
  'font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:text-accent-strong hover:decoration-current'

/** The bar of filters over a table (Optiply's action bar). */
export function ActionBar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex min-h-[50px] flex-wrap items-center gap-2 rounded-lg border border-border bg-canvas p-2',
        className,
      )}
      {...props}
    />
  )
}

/** Under a table: counts on the left, paging or "load more" on the right. */
export function TableFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex min-h-12 items-center justify-between gap-2 border-t border-border bg-canvas px-3 py-2 text-xs text-muted',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn('w-full rounded-md px-2.5 py-1.5', FIELD, className)} {...props} />
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn('h-8 cursor-pointer rounded-md px-2 disabled:cursor-default', FIELD, className)}
      {...props}
    />
  )
}

/** A labelled form control with an optional hint underneath. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

/** Optiply's tab look, for tabs that are links (settings) as well as buttons. */
export function tabClass(active: boolean): string {
  return cn(
    'inline-flex h-8 cursor-pointer items-center rounded-md px-2 text-sm whitespace-nowrap text-muted transition-colors outline-none hover:text-ink focus-visible:shadow-focus',
    active && 'bg-canvas font-semibold text-accent hover:text-accent',
  )
}

/** A row of tabs driven by local state. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T
  onChange: (value: T) => void
  tabs: { value: T; label: ReactNode }[]
  className?: string
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap gap-2', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          aria-pressed={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={tabClass(value === tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** A modal dialog, as Optiply's: a card over the faded page. Escape or a click outside closes it. */
export function Dialog({
  title,
  icon,
  onClose,
  children,
  footer,
  className,
}: {
  title: ReactNode
  /** Before the title, e.g. a question mark for a confirmation. */
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-app/80 p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn('relative w-full max-w-lg rounded-lg bg-surface p-6 text-ink shadow-menu', className)}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-3 text-base font-medium">
            {icon && <span className="shrink-0 text-muted [&_svg]:size-5">{icon}</span>}
            {title}
          </h2>
          <Button size="icon" variant="ghost" title="Close" className="-my-1 -mr-2" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        {/* Room for the focus rings of fields at the edges. */}
        <div className={cn('-mx-1 mt-4 max-h-[65vh] overflow-y-auto px-1 py-1 text-sm', icon && 'pl-9')}>
          {children}
        </div>
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

/** Copies `text` to the clipboard, confirming with a tick for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      size="icon"
      variant="ghost"
      title={copied ? 'Copied' : label}
      aria-label={label}
      className={className}
      onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
    </Button>
  )
}

/** A checkbox with its label. */
export function Checkbox({
  label,
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { label: ReactNode }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="size-4 cursor-pointer rounded accent-accent" {...props} />
      {label}
    </label>
  )
}

/**
 * A dropdown menu, as Optiply's: `trigger` gets the props that open it. Escape, a click outside or choosing an
 * item closes it; arrow keys move between items.
 */
export function Menu({
  trigger,
  children,
  align = 'end',
  className,
}: {
  trigger: (props: {
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    'aria-controls': string
    onClick: () => void
  }) => ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const move = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div ref={root} className="relative">
      {trigger({
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
        onClick: () => setOpen((o) => !o),
      })}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          tabIndex={-1}
          onKeyDown={move}
          onClick={(e) => {
            // Choosing an item closes the menu (a label or separator doesn't).
            if ((e.target as HTMLElement).closest('[role^="menuitem"]')) setOpen(false)
          }}
          className={cn(
            'absolute top-full z-50 mt-2 min-w-52 rounded-lg bg-surface p-2 text-ink shadow-menu',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** An item of a `Menu`; `checked` makes it one of a choice (a radio item with a tick). */
export function MenuItem({
  className,
  danger,
  icon,
  checked,
  children,
  ...props
}: ComponentProps<'button'> & { danger?: boolean; icon?: ReactNode; checked?: boolean }) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked goes with the menuitemradio role, set with it
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={cn(
        'flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm font-medium outline-none hover:bg-canvas focus-visible:bg-canvas disabled:cursor-default disabled:text-faint',
        danger && 'text-danger',
        className,
      )}
      {...props}
    >
      {icon && <span className="shrink-0 text-muted [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check className="size-4 shrink-0 text-accent" />}
    </button>
  )
}

/** A heading inside a `Menu`. */
export function MenuLabel({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-2 pt-1 pb-1 text-xs font-medium text-muted', className)} {...props} />
}

export function MenuSeparator() {
  return <hr className="-mx-2 my-2 border-border" />
}
