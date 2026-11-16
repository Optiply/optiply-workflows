import { LayoutGrid, Workflow } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/utils'

export type AccessType = 'full' | 'apps_only'

const OPTIONS: { value: AccessType; label: string; hint: string; icon: typeof Workflow }[] = [
  {
    value: 'full',
    label: 'Whole platform',
    hint: 'Workflows, apps, resources… as far as their groups and what is shared with them go.',
    icon: Workflow,
  },
  {
    value: 'apps_only',
    label: 'Apps only',
    hint: 'Only the apps shared with them (or a group of theirs), used from a page of their own: nothing else of the platform, and not what is shared with All Users.',
    icon: LayoutGrid,
  },
]

/** The two kinds of access a person can have: the platform, or only the apps shared with them. */
export function AccessTypePicker({
  value,
  onChange,
  disabled = false,
  legend = 'Access',
}: {
  value: AccessType
  onChange: (value: AccessType) => void
  disabled?: boolean
  legend?: string
}) {
  const name = useId()
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((o) => {
          const checked = value === o.value
          return (
            <label
              key={o.value}
              className={cn(
                'flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors has-[:focus-visible]:shadow-focus',
                checked ? 'border-accent bg-accent-soft/50' : 'border-border hover:bg-hover/50',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              <o.icon className={cn('mt-0.5 size-4 shrink-0', checked ? 'text-accent' : 'text-muted')} />
              <span className="min-w-0">
                <span className={cn('block text-sm font-medium', checked && 'text-accent')}>{o.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
