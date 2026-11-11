import { cva, type VariantProps } from 'class-variance-authority'
import { Check, Copy, Loader2, MoreHorizontal, X } from 'lucide-react'
import {
  type ComponentProps,
  type CSSProperties,
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
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate] duration-150 outline-none select-none focus-visible:shadow-focus active:translate-y-px disabled:pointer-events-none disabled:shadow-none',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-on-accent shadow-raised inset-shadow-[0_1px_0_rgb(255_255_255/0.12)] hover:bg-accent-strong disabled:bg-subtle disabled:text-faint disabled:inset-shadow-none',
        secondary:
          'bg-accent-soft text-accent hover:bg-accent-soft-hover hover:text-accent-strong disabled:bg-subtle disabled:text-faint',
        tertiary:
          'border border-border bg-surface text-ink shadow-raised hover:border-divider hover:bg-canvas disabled:bg-subtle disabled:text-faint',
        ghost: 'text-muted hover:bg-hover/70 hover:text-ink disabled:opacity-50',
        danger:
          'bg-danger-soft text-danger hover:bg-danger-soft-hover hover:text-danger-strong disabled:bg-subtle disabled:text-faint',
      },
      size: {
        sm: 'h-7 px-2.5 text-[13px]',
        md: 'h-8 px-3.5 text-sm',
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
  'border border-border bg-surface text-sm text-ink shadow-raised outline-none transition-[border-color,box-shadow] duration-150 enabled:hover:not-focus:border-divider focus:border-transparent focus:shadow-focus aria-invalid:border-transparent aria-invalid:shadow-invalid disabled:bg-subtle disabled:text-faint disabled:shadow-none'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('h-8 w-full rounded-md px-2.5', FIELD, className)} {...props} />
}

/** Whether the browser can mask a text input with CSS (Chromium, Safari and current Firefox can). */
const CSS_MASKING = typeof CSS !== 'undefined' && CSS.supports?.('-webkit-text-security', 'disc')

/**
 * An input for a secret the platform stores (a token, a password for a resource), not the user's own password.
 * Browsers offer to save any `type="password"` field as a login (Chrome does even with `autocomplete="new-password"`,
 * which reads as "sign-up"), so where CSS can mask the text it's a text field shown as dots, which password managers
 * leave alone; elsewhere it stays a password field, so a secret is never shown in plain text.
 */
export function SecretInput({ className, style, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  if (!CSS_MASKING)
    return (
      <Input type="password" autoComplete="new-password" className={className} style={style} {...props} />
    )
  return (
    <Input
      type="text"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className={className}
      style={{ WebkitTextSecurity: 'disc', ...style } as CSSProperties}
      {...props}
    />
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper; callers pass htmlFor or nest the control
  return <label className={cn('text-sm font-medium text-ink', className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-xl border border-border/70 bg-surface shadow-card', className)} {...props} />
  )
}

/** A white container for a page's main content (a table with its tabs and filters), as Optiply's. */
export function PageContainer({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-panel border border-border/70 bg-surface p-2 shadow-card', className)}
      {...props}
    />
  )
}

const BADGE_TONES = {
  neutral: 'bg-subtle text-muted',
  accent: 'bg-op-blue-1 text-op-blue-4',
  success: 'bg-op-green-1 text-op-green-4',
  warning: 'bg-op-orange-1 text-op-orange-4',
  danger: 'bg-op-red-1 text-op-red-4',
} as const
export type BadgeTone = keyof typeof BADGE_TONES

/** Optiply's tags: a tint with darker text. */
export function Badge({
  className,
  tone = 'neutral',
  ...props
}: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap ring-1 ring-current/12 ring-inset',
        BADGE_TONES[tone],
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
        'inline-flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent ring-1 ring-accent/15 ring-inset',
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
    <div className="mb-6 flex min-h-14 items-center justify-between gap-4 pt-2">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-8 font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Optiply's small uppercase heading ("PURCHASING"), for headings of any level. */
export const sectionLabelClass = 'text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted uppercase'

/** A small uppercase heading over a group of cards or a panel's section. */
export function SectionLabel({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('mb-2', sectionLabelClass, className)} {...props} />
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
    <Card
      className={cn('flex flex-col items-center border-dashed px-6 py-16 text-center shadow-none', className)}
    >
      <div className="mb-4 rounded-xl bg-accent-soft p-3 text-accent ring-6 ring-accent-soft/40">{icon}</div>
      <h2 className="font-semibold">{title}</h2>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    </Card>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
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

/** A grey placeholder bar that pulses while its content loads. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      className={cn('rounded-md bg-border/55 motion-safe:animate-pulse', className)}
      style={style}
    />
  )
}

/**
 * A list page's shape while it loads: the title, the toolbar and a card of rows, so the page doesn't jump when the
 * data arrives. `header={false}` inside a page that already has its header (Settings' tabs).
 */
export function ListSkeleton({ rows = 5, header = true }: { rows?: number; header?: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      {header && (
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="space-y-2.5 pt-1">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-8 w-32" />
        </div>
      )}
      {header && <Skeleton className="h-8 w-full" />}
      <Card className="divide-y divide-border/60">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders without identity
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="size-7 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5" style={{ width: `${40 - ((i * 7) % 18)}%` }} />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </Card>
    </div>
  )
}

/** Optiply's data grid: 48px rows between lines, a quiet header, and an optional footer (`TableFooter`). */
export function Table({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-surface shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-canvas/70 [&_tbody_tr:last-child_td]:border-b-0">
          {children}
        </table>
      </div>
      {footer}
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'h-10 border-b border-border/70 bg-canvas/60 px-3 text-xs font-medium text-muted',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('h-12 border-b border-border/60 px-3 py-2 align-middle', className)} {...props} />
}

/** Optiply's link in a table: blue and underlined. */
export const linkClass =
  'font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:text-accent-strong hover:decoration-current'

/** The bar of filters over a table (Optiply's action bar). */
export function ActionBar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex min-h-[50px] flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-surface p-2 shadow-card',
        className,
      )}
      {...props}
    />
  )
}

/** A table's footer for a list loaded page by page: how many show ("so far" while there are more), and Load more. */
export function LoadMoreFooter({
  count,
  noun,
  more,
  loading,
  onMore,
}: {
  count: number
  /** Singular and plural: `['run', 'runs']`. */
  noun: [string, string]
  more: boolean
  loading: boolean
  onMore: () => void
}) {
  return (
    <TableFooter>
      <span>
        <strong className="font-semibold text-ink">{count}</strong> {count === 1 ? noun[0] : noun[1]}
        {more && ' so far'}
      </span>
      {more && (
        <Button size="sm" loading={loading} onClick={onMore}>
          Load more
        </Button>
      )}
    </TableFooter>
  )
}

/** Under a table: counts on the left, paging or "load more" on the right. */
export function TableFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex min-h-12 items-center justify-between gap-2 border-t border-border/70 bg-canvas/60 px-3 py-2 text-xs text-muted',
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
    'inline-flex h-8 cursor-pointer items-center rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted transition-colors outline-none hover:bg-hover/60 hover:text-ink focus-visible:shadow-focus',
    active && 'bg-surface text-accent shadow-raised ring-1 ring-border/70 hover:bg-surface hover:text-accent',
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
    <div className={cn('mb-4 flex flex-wrap gap-1', className)}>
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
  onClose,
  children,
  footer,
  className,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  useEffect(() => {
    // Escape in a code editor is the editor's (closing its suggestions), not the dialog's.
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('.monaco-editor')) && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex motion-safe:animate-fade-in items-start justify-center bg-overlay p-4 pt-[12vh] backdrop-blur-[2px]">
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
        className={cn(
          'relative w-full max-w-lg motion-safe:animate-pop-in rounded-2xl bg-surface p-6 text-ink shadow-menu ring-1 ring-border/60',
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 text-base font-semibold">{title}</h2>
          <Button size="icon" variant="ghost" title="Close" className="-my-1 -mr-2" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        {/* Room for the focus rings of fields at the edges. */}
        <div className="-mx-1 mt-4 max-h-[65vh] overflow-y-auto px-1 py-1 text-sm">{children}</div>
        {footer && (
          <div className="-mx-6 mt-6 -mb-6 flex justify-end gap-2 rounded-b-2xl border-t border-border/70 bg-canvas/60 px-6 py-4">
            {footer}
          </div>
        )}
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
 * A dropdown menu, as Optiply's: `trigger` gets the props that open it. Escape, a click outside, focus moving out
 * (Tab) or choosing an item closes it; arrow keys move between items. Children are items, groups and separators;
 * anything else inside should be `aria-hidden` (say it in `label` instead).
 */
export function Menu({
  trigger,
  label,
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  trigger: (props: {
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    'aria-controls': string | undefined
    onClick: () => void
  }) => ReactNode
  /** What screen readers call the menu. */
  label: string
  children: ReactNode
  align?: 'start' | 'end'
  /** Where it opens: under the trigger, or over it (a trigger at the bottom of the screen). */
  side?: 'top' | 'bottom'
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
    // Tabbing out of the menu closes it, like a click outside.
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false)
    }
    const at = root.current
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    at?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      at?.removeEventListener('focusout', onFocusOut)
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
        'aria-controls': open ? id : undefined,
        onClick: () => setOpen((o) => !o),
      })}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={move}
          onClick={(e) => {
            // Choosing an item closes the menu (a label or separator doesn't).
            if ((e.target as HTMLElement).closest('[role^="menuitem"]')) setOpen(false)
          }}
          className={cn(
            'absolute z-50 min-w-52 rounded-xl bg-surface p-1.5 text-ink shadow-menu ring-1 ring-border/60 motion-safe:animate-pop-in',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
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
        'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-none transition-colors hover:bg-subtle focus-visible:bg-subtle disabled:cursor-default disabled:text-faint',
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

/** Items of a `Menu` under a heading (the theme's choices). */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset aria-label={label} className="m-0 min-w-0 border-0 p-0">
      <div aria-hidden="true" className="px-2 pt-1 pb-1 text-xs font-medium text-muted">
        {label}
      </div>
      {children}
    </fieldset>
  )
}

export function MenuSeparator() {
  return <hr className="-mx-1.5 my-1.5 border-border/70" />
}

/**
 * A list row's quick actions: quiet until the row (a `group`) is hovered or has focus, so a long list reads as names
 * first. Touch screens (no hover) always show them.
 */
export function RowActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [&:has([aria-expanded=true])]:opacity-100',
        className,
      )}
      {...props}
    />
  )
}

/** A row's ··· menu: the actions that don't earn a button of their own (move, protect, delete). */
export function RowMenu({
  label,
  children,
  testId,
}: {
  /** What the row is: `Sync orders` gives the button "Actions for Sync orders". */
  label: string
  children: ReactNode
  testId?: string
}) {
  return (
    <Menu
      label={`Actions for ${label}`}
      trigger={(props) => (
        <Button size="icon" variant="ghost" title={`Actions for ${label}`} data-testid={testId} {...props}>
          <MoreHorizontal className="size-4" />
        </Button>
      )}
    >
      {children}
    </Menu>
  )
}
