import { findExpressionEnd, stringArgCalls } from '@ow/expressions'
import { appFields } from './fields'
import { setAt } from './rename'
import { type AppComponent, type AppDefinition, appNameSchema } from './schema'

/**
 * Slots (M24, architecture §2.27): where a component sits in its parent. A container has a body (or, with views,
 * one grid per view) plus a `header` and a `footer`; the top of the app has the frame's header (the default) and
 * its `sidebar`. Each slot is a grid of its own; a component's layout position is within its slot.
 */

/** A container's slots besides its body or views. */
export const CONTAINER_SLOTS = ['header', 'footer'] as const

/** The app frame's slots for components at the top. */
export const FRAME_SLOTS = ['header', 'sidebar'] as const

export interface ContainerView {
  name: string
  /** As written (a template is evaluated with the `views` prop). */
  label?: string
}

/**
 * A container's views, from its `views` prop as written: entries with a valid, unused name that isn't a slot's
 * (`header`, `footer`). A template or anything else gives none (the validator says so).
 */
export function containerViews(container: AppComponent | undefined): ContainerView[] {
  const raw = container?.props?.views
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return []
    const { name, label } = v as Record<string, unknown>
    if (typeof name !== 'string' || !appNameSchema.safeParse(name).success) return []
    if (seen.has(name) || (CONTAINER_SLOTS as readonly string[]).includes(name)) return []
    seen.add(name)
    return [{ name, ...(typeof label === 'string' && { label }) }]
  })
}

/**
 * The slot a component is in, as the grids place it: inside a container its `header`, `footer` or view (the first
 * view when it names none or one that's gone), undefined for a container's body without views; at the top
 * `sidebar`, or undefined for the frame's header (the default). Inside a form or modal, always undefined.
 */
export function slotOf(def: AppDefinition, component: AppComponent): string | undefined {
  // The sidebar holds components on every page, in an app that has one; otherwise they stay in view (the header).
  if (component.parent === undefined) {
    return component.slot === 'sidebar' && def.frame?.sidebar && component.page === undefined
      ? 'sidebar'
      : undefined
  }
  const parent = def.components.find((c) => c.name === component.parent)
  if (!parent || parent.type !== 'container') return undefined
  if ((CONTAINER_SLOTS as readonly string[]).includes(component.slot ?? '')) return component.slot
  const views = containerViews(parent)
  if (!views.length) return undefined
  return views.some((v) => v.name === component.slot) ? component.slot : views[0]!.name
}

/** The slots `parent` offers (undefined is its body or the frame's header); empty for one that has none. */
export function slotsOf(def: AppDefinition, parent: string | undefined): (string | undefined)[] {
  if (parent === undefined) return def.frame?.sidebar ? [undefined, 'sidebar'] : [undefined]
  const container = def.components.find((c) => c.name === parent)
  if (container?.type !== 'container') return [undefined]
  const views = containerViews(container)
  return [...CONTAINER_SLOTS, ...(views.length ? views.map((v) => v.name) : [undefined])]
}

/**
 * Rewrites `object.method('from', …)` to `object.method('to', …)` in every template and piece of code, keeping the
 * quotes: a view or page renamed where code names it as a string (`container1.setView('details')`,
 * `utils.openPage('orders')`). Returns the definition (the same one when nothing changed) and the paths changed.
 */
export function rewriteCallArgs(
  def: AppDefinition,
  object: string,
  method: string,
  from: string,
  to: string,
): { definition: AppDefinition; changed: (string | number)[][] } {
  let next: AppDefinition | null = null
  const changed: (string | number)[][] = []
  for (const field of appFields(def)) {
    if (!field.source.includes(method)) continue
    const pieces: {
      code: string
      offset: number
      kind: 'expression' | 'function-body' | 'sync-function-body'
    }[] = []
    if (field.kind === 'template') {
      let at = field.source.indexOf('{{')
      while (at !== -1) {
        // JS-aware, as templates are read: a `}}` inside a string or an object literal doesn't end the expression.
        const end = findExpressionEnd(field.source, at + 2)
        if (end === -1) break
        pieces.push({ code: field.source.slice(at + 2, end), offset: at + 2, kind: 'expression' })
        at = field.source.indexOf('{{', end + 2)
      }
    } else if (field.kind === 'function-body' || field.kind === 'sync-function-body') {
      pieces.push({ code: field.source, offset: 0, kind: field.kind })
    }
    const edits = pieces.flatMap((p) =>
      stringArgCalls(p.code, p.kind, object, method)
        .filter((c) => c.value === from)
        .map((c) => ({ start: c.start + p.offset, end: c.end + p.offset })),
    )
    if (!edits.length) continue
    let source = field.source
    for (const e of edits.reverse()) {
      const quote = source[e.start] === '"' ? '"' : source[e.start] === '`' ? '`' : "'"
      source = source.slice(0, e.start) + quote + to + quote + source.slice(e.end)
    }
    next ??= structuredClone(def)
    setAt(next, field.path, source)
    changed.push(field.path)
  }
  return { definition: next ?? def, changed }
}
