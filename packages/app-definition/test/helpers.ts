import type { AppDefinition } from '../src'

/** An app from its parts; everything else empty. */
export function app(parts: Partial<Omit<AppDefinition, 'schemaVersion'>> = {}): AppDefinition {
  return { schemaVersion: 1, components: [], queries: [], ...parts }
}

export const comp = (
  name: string,
  type: string,
  props: Record<string, unknown> = {},
  extra: object = {},
) => ({
  name,
  type,
  props: props as Record<string, never>,
  ...extra,
})

export const sqlQuery = (name: string, sql: string, run: 'auto' | 'manual' = 'auto', extra: object = {}) => ({
  name,
  kind: 'resource' as const,
  resource: 'warehouse',
  query: { sql },
  run,
  ...extra,
})
