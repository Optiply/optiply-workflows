/**
 * Drafts a JSON Schema from a sample body (a webhook's test input or a pasted example), for the person to tighten:
 * every key seen is a property, keys present in every sample are required, integers stay integers, and array items
 * are merged. No formats or patterns are guessed.
 */
export function draftSchema(sample: unknown): Record<string, unknown> {
  return draft(sample, 0)
}

type Schema = Record<string, unknown>

const MAX_DEPTH = 10

function draft(value: unknown, depth: number): Schema {
  if (depth > MAX_DEPTH) return {}
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) {
    return value.length
      ? { type: 'array', items: merge(value.map((v) => draft(v, depth + 1))) }
      : { type: 'array' }
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' }
    case 'boolean':
      return { type: 'boolean' }
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' }
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
      return {
        type: 'object',
        properties: Object.fromEntries(entries.map(([k, v]) => [k, draft(v, depth + 1)])),
        ...(entries.length && { required: entries.map(([k]) => k) }),
      }
    }
    default:
      return {}
  }
}

/** One schema for several drafts (array items): objects merge, integer and number make number, the rest anyOf. */
function merge(schemas: Schema[]): Schema {
  const unique = dedupe(schemas)
  if (unique.length === 1) return unique[0]!
  if (unique.every((s) => s.type === 'object')) {
    const keys = [...new Set(unique.flatMap((s) => Object.keys((s.properties as Schema) ?? {})))]
    const required = keys.filter((k) => unique.every((s) => ((s.required as string[]) ?? []).includes(k)))
    return {
      type: 'object',
      properties: Object.fromEntries(
        keys.map((k) => [
          k,
          merge(
            unique.flatMap((s) =>
              (s.properties as Schema)?.[k] ? [(s.properties as Schema)[k] as Schema] : [],
            ),
          ),
        ]),
      ),
      ...(required.length && { required }),
    }
  }
  if (unique.every((s) => s.type === 'integer' || s.type === 'number')) return { type: 'number' }
  return { anyOf: unique }
}

function dedupe(schemas: Schema[]): Schema[] {
  const seen = new Map<string, Schema>()
  for (const s of schemas) seen.set(JSON.stringify(s), s)
  return [...seen.values()]
}
