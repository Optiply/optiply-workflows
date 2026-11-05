import type { AppDefinition } from '@ow/app-definition'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { scopedCss, themeStyle } from './theme-model'

let roots = 0

/**
 * The app's root (session 41): its theme set on it, and its custom CSS nested under it, so neither reaches the
 * platform around the app (the editor, the page header).
 */
export function ThemedApp({
  definition,
  className,
  children,
}: {
  definition: AppDefinition
  className?: string
  children: ReactNode
}) {
  const [root] = useState(() => `app${++roots}`)
  const css = scopedCss(definition.css, `[data-app-root="${root}"]`)
  return (
    <div
      data-app-root={root}
      style={themeStyle(definition.theme)}
      className={cn(definition.theme?.background && 'rounded-lg p-2', className)}
    >
      {css && <style>{css}</style>}
      {children}
    </div>
  )
}
