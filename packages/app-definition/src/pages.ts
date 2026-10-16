import type { AppDefinition } from './schema'

/**
 * Pages: an app's components, queries and transformers are on one page (`page`) or global (on every page). A
 * component inside a container is on its container's page, whatever it says itself (the validator reports that).
 * Variables are always global.
 */

/** The page each component, query and transformer is on, by name; null for global (variables too). */
export function entityPages(def: AppDefinition): Map<string, string | null> {
  const pages = new Map<string, string | null>()
  const components = new Map(def.components.map((c) => [c.name, c]))
  for (const c of def.components) {
    // The top of its chain of containers decides (a loop, which the validator reports, stops the walk).
    let top = c
    const seen = new Set<string>([c.name])
    while (top.parent !== undefined) {
      const up = components.get(top.parent)
      if (!up || seen.has(up.name)) break
      seen.add(up.name)
      top = up
    }
    if (!pages.has(c.name)) pages.set(c.name, top.page ?? null)
  }
  for (const item of [...def.queries, ...(def.transformers ?? [])]) {
    if (!pages.has(item.name)) pages.set(item.name, item.page ?? null)
  }
  for (const v of def.variables ?? []) if (!pages.has(v.name)) pages.set(v.name, null)
  return pages
}

/** The page an app opens on: its first, or null for an app without pages. */
export function defaultPage(def: AppDefinition): string | null {
  return def.pages?.[0]?.name ?? null
}

/** `name` if the app has such a page, else its default page. */
export function resolvePage(def: AppDefinition, name: string | null | undefined): string | null {
  return name && def.pages?.some((p) => p.name === name) ? name : defaultPage(def)
}

/** Whether something on `page` (null: global) can be read from code on `reader` (null: global code). */
export function pageVisible(page: string | null, reader: string | null): boolean {
  return page === null || page === reader
}
