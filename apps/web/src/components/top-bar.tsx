import { createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'

/**
 * The shell's top bar has a slot beside the breadcrumb: an editor puts its header there (save state, presence,
 * publish, run), so its name shows once and the canvas gets the height. `undefined`: no shell around (the header
 * renders in place); `null`: the shell's slot isn't mounted yet.
 */
export const TopBarSlot = createContext<HTMLElement | null | undefined>(undefined)

export function TopBarPortal({ children }: { children: ReactNode }) {
  const slot = useContext(TopBarSlot)
  if (slot === undefined) return <div className="flex h-12 shrink-0 items-center gap-3 px-2">{children}</div>
  return slot ? createPortal(children, slot) : null
}
