import { cn } from '@/lib/utils'

/** "optiply." in Optiply's blue, with what this is (Optiply's logo is a wordmark too). */
export function Wordmark({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  return (
    <span className={cn('flex items-baseline gap-1.5 whitespace-nowrap', className)}>
      <span
        className={cn(
          'leading-none font-bold tracking-[-0.5px] text-logo',
          size === 'lg' ? 'text-[34px]' : 'text-[26px]',
        )}
      >
        optiply.
      </span>
      <span className={cn('font-medium text-muted', size === 'lg' ? 'text-base' : 'text-sm')}>workflows</span>
    </span>
  )
}
