import { cva, type VariantProps } from 'class-variance-authority'
import { Check, Copy, Loader2, X } from 'lucide-react'
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent/90 shadow-sm',
        secondary: 'bg-surface text-ink border border-border hover:bg-canvas shadow-xs',
        ghost: 'text-muted hover:bg-subtle hover:text-ink',
        danger: 'bg-surface text-danger border border-border hover:bg-danger/5',
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-4', icon: 'h-8 w-8' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
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

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm shadow-xs outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper; callers pass htmlFor or nest the control
  return <label className={cn('text-sm font-medium text-ink', className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border border-border bg-surface shadow-xs', className)} {...props} />
}

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: ComponentProps<'span'> & { tone?: 'neutral' | 'accent' | 'success' | 'danger' }) {
  const tones = {
    neutral: 'bg-subtle text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success/10 text-success',
    danger: 'bg-danger/10 text-danger',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
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

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <Card className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 rounded-xl bg-accent-soft p-3 text-accent">{icon}</div>
      <h2 className="font-semibold">{title}</h2>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    </Card>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
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

export function Table({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-sm">{children}</table>
    </Card>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b border-border bg-canvas px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('border-b border-border px-4 py-3 align-middle', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 rounded-md border border-border bg-surface px-2 text-sm shadow-xs outline-none focus:border-accent disabled:opacity-60',
        className,
      )}
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

/** A row of tabs driven by local state. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T
  onChange: (value: T) => void
  tabs: { value: T; label: ReactNode }[]
}) {
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cn(
            '-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink',
            value === tab.value && 'border-accent font-medium text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** A modal dialog: a centred card over a dimmed page. Escape or a click outside closes it. */
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
        className={cn(
          'relative w-full max-w-lg rounded-xl border border-border bg-surface shadow-lg',
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <Button size="icon" variant="ghost" title="Close" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
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
      <input type="checkbox" className="size-4 accent-accent" {...props} />
      {label}
    </label>
  )
}
