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

/**
 * What a renderer can change in the definition from the canvas (M24): only the editor gives these, never inside a
 * module instance (its definition is the module's).
 */
export interface EditorActions {
  /** A table's column dragged to `width` px: saved in its `columns`. */
  setColumnWidth(table: string, key: string, width: number, shown: readonly { key: string }[]): void
}
export const EditorActionsContext = createContext<EditorActions | null>(null)

/** In the editor: the modal shown over the canvas (the selected one, or the one holding the selection). */
export const ShownModalContext = createContext<{ name: string | null; close: () => void }>({
  name: null,
  close: () => {},
})
