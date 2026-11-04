import type { AppDefinition } from '@ow/app-definition'
import { type ComponentType, createContext, useContext } from 'react'

/**
 * How containers render their children: the viewer's static grid, or the editor's draggable one. Containers call
 * `ChildGrid`; the page decides which grid it is.
 */
export const ChildGridContext = createContext<ComponentType<{
  definition: AppDefinition
  parent?: string
  slot?: string
}> | null>(null)

/** A parent's children in one of its slots (M24: a container's view, header or footer; its body by default). */
export function ChildGrid({
  definition,
  parent,
  slot,
}: {
  definition: AppDefinition
  parent: string
  slot?: string
}) {
  const Grid = useContext(ChildGridContext)
  return Grid ? <Grid definition={definition} parent={parent} slot={slot} /> : null
}

/**
 * In the editor: the view each container shows (M24), so a component added to a selected container goes into the
 * view on screen. Containers record it as they render; module instances (not edited here) don't.
 */
export const shownViews = new Map<string, string>()

/** What the app frame shows besides components (M24): the app's name and the signed-in person. */
export const AppChromeContext = createContext<{
  appName: string
  user: { name: string; email: string } | null
  /** A page's address with its params (M24: Navigation's links), where the app is used. */
  pageHref?: (page: string, params: Record<string, string>) => string
}>({
  appName: '',
  user: null,
})

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
