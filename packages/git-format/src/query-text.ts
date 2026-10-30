import { type Files, textFile } from './files'
import type { FileSlots } from './slots'

/**
 * A resource query's long text kept in files of its own, so a pull request's diff reads like code: SQL, and (M27) a
 * GraphQL query and an email's HTML. Which is which is told without the resource's type: service queries (Slack,
 * HubSpot, SendGrid, Google Sheets) have an `action`, GraphQL's never does (HubSpot's `query` stays in the JSON).
 */
const QUERY_TEXT: readonly { key: string; ext: string; applies(query: Record<string, unknown>): boolean }[] =
  [
    { key: 'sql', ext: 'sql', applies: () => true },
    { key: 'query', ext: 'graphql', applies: (q) => q.action === undefined },
    { key: 'html', ext: 'html', applies: (q) => typeof q.action === 'string' },
  ]

/** The query without the text that gets files, which go into `files` as `<base>.<ext>`. */
export function moveQueryText<Q extends Record<string, unknown>>(query: Q, base: string, files: Files): Q {
  let out: Record<string, unknown> = query
  for (const { key, ext, applies } of QUERY_TEXT) {
    const value = out[key]
    if (typeof value !== 'string' || !applies(query)) continue
    files[`${base}.${ext}`] = textFile(value)
    const { [key]: _moved, ...rest } = out
    out = rest
  }
  return out as Q
}

/** The reverse of `moveQueryText`, on the raw JSON: each `<base>.<ext>` that's there goes back in. */
export function takeQueryText(slots: FileSlots, base: string, query: unknown, what: string): void {
  for (const { key, ext } of QUERY_TEXT) slots.take(`${base}.${ext}`, query, key, { required: false, what })
}
