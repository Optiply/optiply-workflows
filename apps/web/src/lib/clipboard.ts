/**
 * What the editors put on the clipboard (M13): JSON in `text/plain`, through the browser's copy and paste events
 * (no permission prompt). Anything can be on the clipboard (any page can write to it), so what's pasted is parsed
 * as untrusted, and pasting something this browser didn't copy asks first.
 */
import type { z } from 'zod'

/** Clipboard text longer than this isn't read as editor content. */
export const MAX_CLIP_LENGTH = 2_000_000

const LAST_COPY_KEY = 'ow.lastCopy'

/** Remembers that this browser copied `text` (by its hash, across tabs), so pasting it doesn't ask. */
export function rememberCopy(text: string): void {
  try {
    localStorage.setItem(LAST_COPY_KEY, hash(text))
  } catch {
    // Storage blocked (private mode, settings): pasting it will ask, which is only safer.
  }
}

/** Whether `text` is what this browser last copied from an editor. */
export function copiedHere(text: string): boolean {
  try {
    return localStorage.getItem(LAST_COPY_KEY) === hash(text)
  } catch {
    return false
  }
}

/**
 * Clipboard text as `schema`'s kind of content: null when it isn't JSON of that `ow` kind (plain text, or another
 * editor's), an error message when it claims to be but doesn't fit the schema.
 */
export function readClip<S extends z.ZodType>(
  text: string,
  kind: string,
  schema: S,
): { ok: true; clip: z.output<S> } | { ok: false; error: string } | null {
  if (!text.startsWith('{') || text.length > MAX_CLIP_LENGTH) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if ((json as { ow?: unknown } | null)?.ow !== kind) return null
  const parsed = schema.safeParse(json)
  if (!parsed.success) return { ok: false, error: "The clipboard has blocks this editor can't read" }
  return { ok: true, clip: parsed.data }
}

/** Whether the page has text selected: copying it is the browser's, not the editor's. */
export function textSelected(): boolean {
  return (window.getSelection()?.toString() ?? '') !== ''
}

/** FNV-1a, 32 bits: enough to tell "what I copied" from anything else, not a security boundary on its own. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${text.length}:${(h >>> 0).toString(16)}`
}
