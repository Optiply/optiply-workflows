import type { JsonValue } from '@ow/app-definition'

/** A test value is typed as JSON (`42`, `"a"`, `[1, 2]`), or taken as plain text when it isn't JSON. */
export function parseTestValue(text: string): JsonValue | undefined {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * A test value as it's typed back: everything as JSON, except a string that wouldn't read back as JSON (`hello`),
 * shown as it is. So the string `"42"` keeps its quotes and stays a string on the next keystroke.
 */
export function showTestValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') return JSON.stringify(value)
  return parseTestValue(value) === value ? value : JSON.stringify(value)
}
