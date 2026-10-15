import { canonicalJson } from '@ow/definition'
import type { AppDefinition } from './schema'

/**
 * The same app in a fixed form: components, queries, transformers and variables sorted by name, so neither the
 * order the editor wrote them in nor a Git merge changes the result. Event handlers keep their order, which
 * matters (they run in it).
 */
export function canonicalizeApp(def: AppDefinition): AppDefinition {
  const byName = <T extends { name: string }>(items: readonly T[]) =>
    [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const canonical: AppDefinition = {
    ...def,
    components: byName(def.components),
    queries: byName(def.queries),
  }
  if (def.transformers) canonical.transformers = byName(def.transformers)
  if (def.variables) canonical.variables = byName(def.variables)
  return canonical
}

/**
 * SHA-256 (hex) of the canonical app: the identity of what a release shows. Unlike a workflow's hash, the layout
 * counts, since moving a component changes what people see. Uses Web Crypto, so it works in the browser and in
 * Node.
 */
export async function appDefinitionHash(def: AppDefinition): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(canonicalizeApp(def)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
