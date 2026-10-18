import { Loader2 } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
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

/** The app's button styles are Optiply's: primary blue, secondary a blue tint, danger a red tint. */
const VARIANTS = { primary: 'primary', secondary: 'secondary', danger: 'danger' } as const

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
      className={cn(buttonVariants({ variant: VARIANTS[variant] ?? 'primary' }), 'w-full px-3')}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      <span className="truncate">{text}</span>
    </button>
  )
}
