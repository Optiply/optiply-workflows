import type { ConnectorError } from '@ow/connectors'

/** Query results are JSON: Dates become ISO strings, bigints strings. */
export function toJson(value: unknown): unknown {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  return text === undefined ? null : JSON.parse(text)
}

/** A connector error as the browser sees it (already scrubbed of secrets by `runQuery`). */
export function errorView(err: ConnectorError) {
  return { code: err.code, message: err.message, details: err.details ?? null }
}
