import { fieldRefs, freshName } from '@ow/definition'
import { z } from 'zod'
import { componentSpec } from './components'
import { bottomOf, usedNames, withDescendants } from './edits'
import { appFields } from './fields'
import { appNameReason, isAppGlobalName } from './names'
import { renameAppEntity } from './rename'
import {
  type AppComponent,
  type AppDefinition,
  type AppQuery,
  appNameSchema,
  appQuerySchema,
  componentSchema,
  type Position,
  positionSchema,
  runsAutomatically,
  transformerSchema,
  variableSchema,
} from './schema'

/**
 * Components on the clipboard (M13): one component (or several) with everything inside them, and their positions.
 * `componentClipSchema` parses what's pasted: anything can be on the clipboard.
 */
export const componentClipSchema = z.strictObject({
  ow: z.literal('app-components'),
  v: z.literal(1),
  components: z.array(componentSchema).min(1).max(500),
  layout: z.record(appNameSchema, positionSchema),
})
export type ComponentClip = z.output<typeof componentClipSchema>

/** Queries, transformers and variables on the clipboard (M13). */
export const codeClipSchema = z
  .strictObject({
    ow: z.literal('app-code'),
    v: z.literal(1),
    queries: z.array(appQuerySchema).max(500),
    transformers: z.array(transformerSchema).max(500),
    variables: z.array(variableSchema).max(500),
  })
  .refine((c) => c.queries.length + c.transformers.length + c.variables.length > 0, 'Nothing to paste')
export type CodeClip = z.output<typeof codeClipSchema>

/** The named components with everything inside them, and their positions; null when none of them exists. */
export function copyComponents(def: AppDefinition, names: Iterable<string>): ComponentClip | null {
  const all = new Set<string>()
  for (const name of names)
    if (def.components.some((c) => c.name === name)) for (const n of withDescendants(def, name)) all.add(n)
  if (!all.size) return null
  const components = def.components.filter((c) => all.has(c.name))
  const layout: Record<string, Position> = {}
  for (const c of components) {
    const at = def.layout?.[c.name]
    if (at) layout[c.name] = at
  }
  return {
    ow: 'app-components',
    v: 1,
    components: structuredClone(components),
    layout: structuredClone(layout),
  }
}

/** The named queries, transformers and variables; null when none of them exists. */
export function copyCode(def: AppDefinition, names: Iterable<string>): CodeClip | null {
  const wanted = new Set(names)
  const clip: CodeClip = {
    ow: 'app-code',
    v: 1,
    queries: structuredClone(def.queries.filter((q) => wanted.has(q.name))),
    transformers: structuredClone((def.transformers ?? []).filter((t) => wanted.has(t.name))),
    variables: structuredClone((def.variables ?? []).filter((v) => wanted.has(v.name))),
  }
  return clip.queries.length + clip.transformers.length + clip.variables.length ? clip : null
}

export interface AppPasteResult {
  definition: AppDefinition
  /** The pasted items' names in the app, in the clip's order. */
  added: string[]
  /** Copied names that had to change: copied name → pasted name. */
  renamed: Record<string, string>
  /**
   * Pasted items (by their pasted names) with code that doesn't parse and mentions a pasted item that was renamed:
   * that code couldn't be updated, so it may still name the old item.
   */
  unparsed: string[]
  /**
   * Names the pasted items read that are neither pasted nor globals: things that weren't copied. `inTarget` when
   * the app has something of that name, which the reference now reads.
   */
  outside: { name: string; inTarget: boolean }[]
  /** Pasted queries that run by themselves (automatic, or on load): they'll run in the editor straight away. */
  runsByItself: string[]
}

/** Where pasted components go: into `parent` (a container), or at the top on `page` (null: every page). */
export interface ComponentTarget {
  parent?: string
  page: string | null
  /** The first row to use in the target grid; below what's there when missing. */
  y?: number
}

/**
 * Pastes components into the app: fresh names for those whose names are taken (the stem and the next free number),
 * with references between the pasted ones following (props, handlers, parents, layout); references to anything
 * else are left as they are, and listed. The pasted roots go into `target` below what's there, keeping how they
 * were arranged; what's inside them keeps its place. Modals always go at the top, without a position.
 */
export function pasteComponents(
  def: AppDefinition,
  clip: ComponentClip,
  target: ComponentTarget,
): AppPasteResult {
  const copied = new Set(clip.components.map((c) => c.name))
  const parent = target.parent !== undefined && isContainer(def, target.parent) ? target.parent : undefined
  // Roots: what isn't inside something pasted with it.
  const roots = new Set(
    clip.components.filter((c) => c.parent === undefined || !copied.has(c.parent)).map((c) => c.name),
  )
  // Roots lose their parent and page before renaming, and get the target's after: the target container may have a
  // pasted component's name, and renaming that one mustn't rewrite the reference to the target's.
  const loose = clip.components.map((c): AppComponent => {
    if (!roots.has(c.name)) return c
    const { parent: _p, page: _g, ...rest } = c
    return rest
  })
  const scratch = renamedApart(def, { schemaVersion: 1, components: loose, queries: [], layout: clip.layout })
  const renamed = scratch.renamed
  const pasted: AppDefinition = {
    ...scratch.definition,
    components: scratch.definition.components.map((c): AppComponent => {
      if (!roots.has(originalOf(c.name, renamed))) return c
      const into = componentSpec(c.type)?.overlay ? undefined : parent
      const page = into === undefined ? target.page : null
      return { ...c, ...(into !== undefined && { parent: into }), ...(page !== null && { page }) }
    }),
  }

  // Positions: the roots below what the target grid holds, offsets between them kept; children as they were.
  const layout: Record<string, Position> = {}
  const rootLayout = pasted.components
    .filter((c) => roots.has(originalOf(c.name, renamed)) && pasted.layout?.[c.name])
    .map((c) => pasted.layout![c.name]!)
  const top = rootLayout.length ? Math.min(...rootLayout.map((p) => p.y)) : 0
  const start = target.y ?? bottomOf(def, parent, parent === undefined ? target.page : null)
  for (const c of pasted.components) {
    const at = pasted.layout?.[c.name]
    if (!at || componentSpec(c.type)?.overlay) continue
    layout[c.name] = roots.has(originalOf(c.name, renamed)) ? { ...at, y: start + (at.y - top) } : at
  }

  const definition: AppDefinition = {
    ...def,
    components: [...def.components, ...pasted.components],
    layout: { ...def.layout, ...layout },
  }
  return {
    definition,
    added: pasted.components.map((c) => c.name),
    renamed,
    unparsed: scratch.unparsed,
    outside: outsideNames(def, pasted),
    runsByItself: [],
  }
}

/**
 * Pastes queries, transformers and variables, with fresh names as for components. Those that belonged to a page go
 * on `page` (the one being edited; global without pages); global ones stay global.
 */
export function pasteCode(def: AppDefinition, clip: CodeClip, page: string | null): AppPasteResult {
  const onPage = <T extends { page?: string }>(item: T): T => {
    if (item.page === undefined) return item
    const { page: _old, ...rest } = item
    return (page === null ? rest : { ...rest, page }) as T
  }
  const scratch = renamedApart(def, {
    schemaVersion: 1,
    components: [],
    queries: clip.queries.map(onPage),
    transformers: clip.transformers.map(onPage),
    variables: clip.variables,
  })
  const pasted = scratch.definition
  const definition: AppDefinition = {
    ...def,
    queries: [...def.queries, ...pasted.queries],
    ...((pasted.transformers?.length || def.transformers) && {
      transformers: [...(def.transformers ?? []), ...(pasted.transformers ?? [])],
    }),
    ...((pasted.variables?.length || def.variables) && {
      variables: [...(def.variables ?? []), ...(pasted.variables ?? [])],
    }),
  }
  return {
    definition,
    added: [...pasted.queries, ...(pasted.transformers ?? []), ...(pasted.variables ?? [])].map(
      (x) => x.name,
    ),
    renamed: scratch.renamed,
    unparsed: scratch.unparsed,
    outside: outsideNames(def, pasted),
    runsByItself: pasted.queries.filter(runsByItself).map((q) => q.name),
  }
}

/** Whether a query runs without anyone asking: an automatic resource query, or one that runs when the app loads. */
export function runsByItself(query: AppQuery): boolean {
  return runsAutomatically(query) || query.runOnLoad === true
}

/**
 * `pasted` (a definition holding only what's pasted) with fresh names for those `def` already uses: renamed through
 * `renameAppEntity`, so references among the pasted items follow and nothing else's do. Fresh names are never one
 * of the pasted ones, so renames never chain; a name a local would capture is passed over.
 */
function renamedApart(
  def: AppDefinition,
  pasted: AppDefinition,
): { definition: AppDefinition; renamed: Record<string, string>; unparsed: string[] } {
  const taken = usedNames(def)
  let scratch = pasted
  const renamed: Record<string, string> = {}
  const unparsedAt = new Set<string>()
  for (const name of usedNames(pasted)) {
    if (!taken.has(name) && !appNameReason(name)) {
      taken.add(name)
      continue
    }
    const inScratch = usedNames(scratch)
    for (let n = 1; ; n++) {
      const candidate = freshName(name, n)
      if (candidate === null) throw new Error(`No free name for "${name}"`)
      if (taken.has(candidate) || inScratch.has(candidate) || appNameReason(candidate)) continue
      const result = renameAppEntity(scratch, name, candidate)
      if (!result.ok) continue
      for (const path of result.skipped) unparsedAt.add(ownerAt(result.definition, path))
      scratch = result.definition
      renamed[name] = candidate
      taken.add(candidate)
      break
    }
  }
  // Owners are named as they were then: their own names may have changed since (never to a pasted name).
  const unparsed = [...new Set([...unparsedAt].map((name) => renamed[name] ?? name))]
  return { definition: scratch, renamed, unparsed }
}

/** The name of the component, query, transformer or variable a field's path (`['queries', 2, …]`) is in. */
function ownerAt(def: AppDefinition, path: (string | number)[]): string {
  const [list, index] = path
  const items = (def as unknown as Record<string, { name: string }[] | undefined>)[list as string]
  return items?.[index as number]?.name ?? String(list)
}

function originalOf(name: string, renamed: Record<string, string>): string {
  return Object.entries(renamed).find(([, to]) => to === name)?.[0] ?? name
}

function isContainer(def: AppDefinition, name: string): boolean {
  const c = def.components.find((x) => x.name === name)
  return Boolean(c && componentSpec(c.type)?.container)
}

/** What the pasted items read that isn't among them, a global or their own locals. */
function outsideNames(def: AppDefinition, pasted: AppDefinition): AppPasteResult['outside'] {
  const own = usedNames(pasted)
  const there = usedNames(def)
  const names = new Set<string>()
  for (const field of appFields(pasted)) {
    const locals = new Set(field.locals)
    for (const ref of fieldRefs(field).refs) {
      if (locals.has(ref.name)) continue
      if (!own.has(ref.name) && !isAppGlobalName(ref.name) && appNameSchema.safeParse(ref.name).success) {
        names.add(ref.name)
      }
    }
  }
  return [...names].sort().map((name) => ({ name, inTarget: there.has(name) }))
}
