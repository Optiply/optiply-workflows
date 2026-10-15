import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const

/** Text, as written (line breaks kept). */
export function TextRenderer({ component }: RendererProps) {
  const value = useAppValue<string>(`${component.name}.value`)
  const align = useAppValue<keyof typeof ALIGN>(`${component.name}.align`)
  return (
    <div
      className={cn(
        'h-full overflow-auto py-1 text-sm whitespace-pre-wrap break-words',
        ALIGN[align] ?? ALIGN.left,
      )}
    >
      {value}
    </div>
  )
}

const VARIANTS = {
  primary: 'bg-accent text-white hover:bg-accent/90 shadow-sm',
  secondary: 'bg-surface text-ink border border-border hover:bg-canvas shadow-xs',
  danger: 'bg-danger text-white hover:bg-danger/90 shadow-sm',
} as const

/** A button firing `click`. Inside a form it doesn't submit it (the form has its own button). */
export function ButtonRenderer({ component }: RendererProps) {
  const host = useAppHostContext()
  const name = component.name
  const text = useAppValue<string>(`${name}.text`)
  const variant = useAppValue<keyof typeof VARIANTS>(`${name}.variant`)
  const disabled = useAppValue<boolean>(`${name}.disabled`)
  const loading = useAppValue<boolean>(`${name}.loading`)
  return (
    <button
      type="button"
      disabled={disabled || loading}
      onClick={() => host.fire(name, 'click')}
      className={cn(
        'inline-flex h-8 w-full items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:opacity-50',
        VARIANTS[variant] ?? VARIANTS.primary,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      <span className="truncate">{text}</span>
    </button>
  )
}
