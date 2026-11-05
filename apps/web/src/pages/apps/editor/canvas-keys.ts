import { componentSpec, entityPages, removeComponents } from '@ow/app-definition'
import { useEffect, useRef } from 'react'
import { dialogOpen, isTextTarget } from '@/lib/shortcuts'
import { nudgeOnCanvas } from './layout'
import { useAppEditor } from './store'

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

/**
 * The canvas's keys (M24): ⌘U hides and shows the inspector (session 41), Escape clears the selection, ⌘A / Ctrl+A selects the components of the page shown (and
 * those on every page), Delete or Backspace removes the selection, the arrow keys move it a cell at a time (one undo
 * step each). Text fields, widgets with arrow keys of their own (a table, tabs, a menu) and dialogs keep their keys.
 */
export function useCanvasKeys(enabled: boolean): void {
  const on = useRef(enabled)
  on.current = enabled
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!on.current || e.defaultPrevented || isTextTarget(e.target) || dialogOpen()) return
      // A table's grid, a container's tabs, a menu: their arrows are their own.
      if (e.target instanceof Element && e.target.closest('[role="grid"], [role="tablist"], [role="menu"]'))
        return
      const s = useAppEditor.getState()
      const mod = e.metaKey || e.ctrlKey
      // ⌘U / Ctrl+U hides and shows the inspector (Retool's key).
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        s.setInspectorOpen(!s.inspectorOpen)
        return
      }
      if (e.key === 'Escape' && s.selection.length) {
        s.select(null)
        return
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const pages = entityPages(s.definition)
        s.selectMany(
          s.definition.components
            .filter(
              (c) =>
                c.parent === undefined &&
                !componentSpec(c.type)?.overlay &&
                [null, s.url.page].includes(pages.get(c.name) ?? null),
            )
            .map((c) => c.name),
        )
        return
      }
      if (s.readOnly || !s.selection.length || mod || e.altKey) return
      const names = s.selection
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        s.update((def) => removeComponents(def, names))
        s.select(null)
        return
      }
      const move = ARROWS[e.key]
      if (move) {
        e.preventDefault()
        s.update((def) => nudgeOnCanvas(def, names, move[0], move[1]))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
