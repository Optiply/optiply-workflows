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

/** A test value as it's typed back: strings as they are, everything else as JSON. */
export const showTestValue = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
