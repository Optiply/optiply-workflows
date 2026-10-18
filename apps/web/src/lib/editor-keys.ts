import { useEffect, useRef } from 'react'
import { textSelected } from './clipboard'
import { dialogOpen, isTextTarget, shortcutFor } from './shortcuts'

/** What an editor does with its keys (M13). Without `copy` or `paste`, the browser keeps those events. */
export interface EditorKeys {
  /** Whether the draft can be changed: undo, redo, duplicate and paste only then (copy always). */
  editable: boolean
  undo(): void
  redo(): void
  duplicate?(): void
  /** The selection as clipboard text, or null with nothing to copy. */
  copy?(): string | null
  /** Takes clipboard text; false when it isn't this editor's, so the browser can paste it elsewhere. */
  paste?(text: string): boolean
}

/**
 * An editor's keys on the page: ⌘Z / ⇧⌘Z / Ctrl+Y, ⌘D, and the browser's copy and paste events (so the Edit menu
 * works too). Text fields and Monaco keep them for themselves, and nothing happens behind an open dialog.
 */
export function useEditorKeys(keys: EditorKeys): void {
  const current = useRef(keys)
  current.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = current.current
      const shortcut = shortcutFor(e)
      if (!shortcut || !k.editable || isTextTarget(e.target) || dialogOpen()) return
      if (shortcut === 'duplicate' && !k.duplicate) return
      e.preventDefault()
      if (shortcut === 'undo') k.undo()
      else if (shortcut === 'redo') k.redo()
      else k.duplicate?.()
    }
    const onCopy = (e: ClipboardEvent) => {
      const k = current.current
      if (!k.copy || isTextTarget(e.target) || dialogOpen() || textSelected() || !e.clipboardData) return
      const text = k.copy()
      if (text === null) return
      e.clipboardData.setData('text/plain', text)
      e.preventDefault()
    }
    const onPaste = (e: ClipboardEvent) => {
      const k = current.current
      if (!k.paste || !k.editable || isTextTarget(e.target) || dialogOpen() || !e.clipboardData) return
      if (k.paste(e.clipboardData.getData('text/plain'))) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [])
}
