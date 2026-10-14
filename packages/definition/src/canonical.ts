import type { WorkflowDefinition } from './schema'

/**
 * The same definition in a fixed form: blocks sorted by name and edges by (from, port, to), functions by name with
 * their blocks and edges sorted the same way, so neither the order the editor wrote them in nor a Git merge changes
 * the result. Branch conditions and function parameters keep their order, which matters.
 */
export function canonicalize(def: WorkflowDefinition): WorkflowDefinition {
  const canonical: WorkflowDefinition = { ...def, ...sortGraph(def) }
  if (def.functions) {
    canonical.functions = [...def.functions]
      .sort((a, b) => compare(a.name, b.name))
      .map((fn) => ({ ...fn, ...sortGraph(fn) }))
  }
  return canonical
}

function sortGraph<T extends Pick<WorkflowDefinition, 'blocks' | 'edges'>>(graph: T) {
  return {
    blocks: [...graph.blocks].sort((a, b) => compare(a.name, b.name)),
    edges: [...graph.edges].sort(
      (a, b) => compare(a.from, b.from) || compare(a.port, b.port) || compare(a.to, b.to),
    ),
  }
}

/**
 * JSON with object keys sorted by UTF-16 code unit at every level and `undefined` properties dropped. Unlike
 * `JSON.stringify`, integer-like keys sort as strings too, so any language can reproduce the output. `pretty`
 * gives the 2-space, newline-terminated form for files in Git.
 */
export function canonicalJson(value: unknown, options: { pretty?: boolean } = {}): string {
  const out = serialize(value, options.pretty ? '  ' : '', '')
  if (out === undefined) throw new TypeError('Cannot serialize undefined')
  return options.pretty ? `${out}\n` : out
}

/**
 * SHA-256 (hex) of the canonical definition without its layout: the identity of what a release runs. Uses Web
 * Crypto, so it works in the browser and in Node.
 */
export async function definitionHash(def: WorkflowDefinition): Promise<string> {
  const { layout: _layout, ...logic } = canonicalize(def)
  if (logic.functions) logic.functions = logic.functions.map(({ layout: _fnLayout, ...fn }) => fn)
  const bytes = new TextEncoder().encode(canonicalJson(logic))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function serialize(value: unknown, indent: string, current: string): string | undefined {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'undefined':
      return undefined
    case 'boolean':
      return String(value)
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Cannot serialize ${value} as JSON`)
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new TypeError(`Cannot serialize a ${typeof value} as JSON`)
  }

  const next = current + indent
  const newline = indent ? '\n' : ''
  const wrap = (open: string, items: string[], close: string) =>
    items.length === 0
      ? open + close
      : `${open}${newline}${items.map((item) => next + item).join(`,${newline}`)}${newline}${current}${close}`

  if (Array.isArray(value)) {
    return wrap(
      '[',
      value.map((item) => serialize(item, indent, next) ?? 'null'),
      ']',
    )
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`Cannot serialize a ${proto?.constructor?.name ?? 'non-plain'} object as JSON`)
  }
  const entries: string[] = []
  for (const key of Object.keys(value).sort(compare)) {
    const item = serialize((value as Record<string, unknown>)[key], indent, next)
    if (item !== undefined) entries.push(`${JSON.stringify(key)}:${indent ? ' ' : ''}${item}`)
  }
  return wrap('{', entries, '}')
}

/** Code-unit order, independent of locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
