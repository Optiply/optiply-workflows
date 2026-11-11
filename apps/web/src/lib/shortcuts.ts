/** The editors' keyboard shortcuts (M13). Copy and paste go through the browser's own events instead. */
export type Shortcut = 'undo' | 'redo' | 'duplicate'

export interface ShortcutKeys {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
}

/** Whether shortcuts use ⌘ (macOS and iOS) rather than Ctrl. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** The label of `key` with the platform's modifier: "⌘Z" or "Ctrl+Z", "⇧⌘Z" or "Ctrl+Shift+Z". */
export function shortcutLabel(key: string, { shift = false, mac = IS_MAC } = {}): string {
  return mac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/**
 * The shortcut a key press means: ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Shift+Z and Ctrl+Y redo, ⌘D / Ctrl+D duplicate.
 * Nothing while an input method is composing, or with Alt (other layouts type characters with it).
 */
export function shortcutFor(e: ShortcutKeys, mac = IS_MAC): Shortcut | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || e.isComposing) return null
  const key = e.key.toLowerCase()
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !e.shiftKey && !mac) return 'redo'
  if (key === 'd' && !e.shiftKey) return 'duplicate'
  return null
}

/** Text fields keep these keys for themselves (their own undo): inputs, text areas, editable content and Monaco. */
const TEXT_TARGETS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor'

/** Whether a key press from `target` belongs to a text field rather than to the editor. */
export function isTextTarget(target: EventTarget | null): boolean {
  const closest = (target as Partial<Element> | null)?.closest
  return typeof closest === 'function' && closest.call(target, TEXT_TARGETS) !== null
}

/**
 * Whether a dialog is open: shortcuts would act on the editor behind it. A modal component the app editor shows
 * because it's selected (`data-canvas-modal`) is part of the canvas being edited, not a dialog over it.
 */
export function dialogOpen(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.querySelector('[role="dialog"]:not([data-canvas-modal])') !== null
  )
}

/** ⌘K on a Mac, Ctrl+K elsewhere (a Mac's Ctrl+K stays the text field's kill-line); never mid-composition. */
export function isPaletteKey(e: ShortcutKeys, mac = IS_MAC): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && !e.isComposing && e.key.toLowerCase() === 'k'
}

/** An open modal dialog other than the global palette (whose ⌘K toggles it closed). */
export function otherModalOpen(): boolean {
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(
    (d) => !d.hasAttribute('data-global-palette'),
  )
}
