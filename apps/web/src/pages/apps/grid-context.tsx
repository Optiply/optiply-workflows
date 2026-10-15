import type { AppDefinition } from '@ow/app-definition'
import { type ComponentType, createContext, useContext } from 'react'

/**
 * How containers render their children: the viewer's static grid, or the editor's draggable one. Containers call
 * `ChildGrid`; the page decides which grid it is.
 */
export const ChildGridContext = createContext<ComponentType<{
  definition: AppDefinition
  parent?: string
}> | null>(null)

export function ChildGrid({ definition, parent }: { definition: AppDefinition; parent: string }) {
  const Grid = useContext(ChildGridContext)
  return Grid ? <Grid definition={definition} parent={parent} /> : null
}

/** True in the editor: hidden components still show (faded), and modals open while selected. */
export const EditingContext = createContext(false)

/** In the editor: the modal shown over the canvas (the selected one, or the one holding the selection). */
export const ShownModalContext = createContext<{ name: string | null; close: () => void }>({
  name: null,
  close: () => {},
})
