import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'

interface Link {
  page: string
  label: string
}

/**
 * Links to the app's pages: the `items` given (`{ page, label? }`), or every page by title. The page shown is
 * marked; a link opens its page like `utils.openPage`. Links to pages that don't exist are left out.
 */
export function NavigationRenderer({ component, definition }: RendererProps) {
  const host = useAppHostContext()
  const name = component.name
  const items = useAppValue<unknown>(`${name}.items`)
  const orientation = useAppValue<'horizontal' | 'vertical'>(`${name}.orientation`)
  const current = useAppValue<string | null>('url.page')
  const pages = definition.pages ?? []
  const title = (page: string) => pages.find((p) => p.name === page)?.title || page
  const links: Link[] =
    Array.isArray(items) && items.length
      ? items.flatMap((item) => {
          const page = item && typeof item === 'object' ? (item as { page?: unknown }).page : undefined
          if (typeof page !== 'string' || !pages.some((p) => p.name === page)) return []
          const label = (item as { label?: unknown }).label
          return [{ page, label: typeof label === 'string' && label ? label : title(page) }]
        })
      : pages.map((p) => ({ page: p.name, label: p.title || p.name }))
  const vertical = orientation === 'vertical'
  return (
    <nav aria-label={name} className="h-full">
      <ul className={cn('flex gap-1', vertical ? 'flex-col' : 'flex-wrap items-center')}>
        {links.map((link) => {
          const here = link.page === current
          return (
            <li key={`${link.page}:${link.label}`}>
              <button
                type="button"
                aria-current={here ? 'page' : undefined}
                onClick={() => host.openPage(link.page, {})}
                className={cn(
                  'h-8 cursor-pointer rounded-md px-4 text-sm font-medium transition-colors',
                  vertical && 'w-full text-left',
                  here ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-accent-soft hover:text-accent',
                )}
              >
                {link.label}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
