import { type Node, type Options, parseExpressionAt } from 'acorn'
import { analyze } from 'eslint-scope'
import type * as ESTree from 'estree'
import { TemplateError } from './template'

/** A reference to a variable the code doesn't declare itself (a block, global, or stdlib name). */
export interface IdentifierRef {
  name: string
  /** Offsets into the code passed in. */
  start: number
  end: number
  /** The reference is a shorthand property (`{ name }`), so renaming it must keep the key: `{ name: other }`. */
  shorthand?: true
  /**
   * With `{ properties: true }`: the property read straight off the reference, `b` in `a.b`, `a?.b` and `a['b']`.
   * Missing when the reference is used whole (`f(a)`) or with a computed key (`a[k]`).
   */
  property?: string
}

export type CodeKind =
  /** The inside of a `{{ }}`: exactly one expression. */
  | 'expression'
  /** A code block body, run as an async function: may `await` and must `return`. */
  | 'function-body'
  /** A function body run synchronously (app transformers): `await` is a syntax error. */
  | 'sync-function-body'

// Mirrors how @ow/sandbox runs code, so analysis and execution see the same program.
const WRAP: Record<CodeKind, [string, string]> = {
  expression: ['(\n', '\n)'],
  'function-body': ['(async () => {\n', '\n})'],
  'sync-function-body': ['(() => {\n', '\n})'],
}

// eslint-scope reads `node.range` when resolving references inside function scopes.
const ACORN: Options = { ecmaVersion: 'latest', sourceType: 'script', ranges: true }

/**
 * Every reference in `code` to a name it doesn't declare, in source order, scope-aware: arrow/function params,
 * destructuring, let/const/var, catch bindings and class names are excluded; property names (`a.b`, `{b: 1}`)
 * aren't references. Throws `TemplateError` on syntax errors or when the code isn't exactly one expression /
 * function body (e.g. `a)(b`, which would only "work" because of the wrapping).
 */
export function freeIdentifierRefs(
  code: string,
  kind: CodeKind = 'expression',
  options: { properties?: boolean } = {},
): IdentifierRef[] {
  const [prefix, suffix] = WRAP[kind]
  const src = prefix + code + suffix
  const offset = prefix.length

  let outer: Node
  try {
    outer = parseExpressionAt(src, 0, { ...ACORN, preserveParens: true })
  } catch (err) {
    const pos = (err as { pos?: number }).pos ?? offset
    throw syntaxError((err as Error).message, pos - offset, code.length)
  }
  if (!isWrapper(outer as ParenNode, kind, src.length)) {
    throw syntaxError(
      kind === 'expression' ? 'Expected a single expression' : 'Unexpected code after the function body',
      0,
      code.length,
    )
  }
  // Re-parse without ParenthesizedExpression nodes, which eslint-scope doesn't know; this returns the node
  // inside the wrapper's parens.
  const expr = parseExpressionAt(src, 0, ACORN)

  const program = {
    type: 'Program',
    sourceType: 'script',
    body: [{ type: 'ExpressionStatement', expression: expr }],
    start: 0,
    end: src.length,
  } as unknown as ESTree.Program
  const scopes = analyze(program, { ecmaVersion: 2025, sourceType: 'script' })

  const shorthands = shorthandValueStarts(expr)
  const properties = options.properties ? memberProperties(expr) : undefined
  return scopes
    .globalScope!.through.map((ref): IdentifierRef => {
      const id = ref.identifier as ESTree.Identifier & { start: number; end: number }
      const found: IdentifierRef = { name: id.name, start: id.start - offset, end: id.end - offset }
      if (shorthands.has(id.start)) found.shorthand = true
      const property = properties?.get(id.start)
      if (property !== undefined) found.property = property
      return found
    })
    .sort((a, b) => a.start - b.start)
}

/** Start offsets of the identifiers in shorthand object properties (`{ a }`), patterns included. */
function shorthandValueStarts(root: Node): Set<number> {
  const starts = new Set<number>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return
    const node = value as Node & { shorthand?: boolean; value?: Node }
    if (node.type === 'Property' && node.shorthand && node.value?.type === 'Identifier')
      starts.add(node.value.start)
    for (const [key, child] of Object.entries(node)) if (key !== 'loc') visit(child)
  }
  visit(root)
  return starts
}

/** The property each identifier that is a member expression's object reads, by the identifier's start offset. */
function memberProperties(root: Node): Map<number, string> {
  const props = new Map<number, string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return
    const node = value as Node & { object?: Node & { name?: string }; property?: Node; computed?: boolean }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') {
      const prop = node.property as (Node & { name?: string; value?: unknown }) | undefined
      if (!node.computed && prop?.type === 'Identifier') props.set(node.object.start, prop.name!)
      else if (node.computed && prop?.type === 'Literal' && typeof prop.value === 'string') {
        props.set(node.object.start, prop.value)
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'loc') visit(child)
  }
  visit(root)
  return props
}

/** Unique free identifier names, in order of first use. */
export function freeIdentifiers(code: string, kind: CodeKind = 'expression'): string[] {
  return [...new Set(freeIdentifierRefs(code, kind).map((r) => r.name))]
}

type ParenNode = Node & { expression?: Node }

/**
 * With `preserveParens`, valid code parses as the wrapper's own parenthesised expression spanning the whole
 * source. Anything else means the code closed the wrapper early: `a)(b` parses as the call `(a)(b)`, and
 * `}) || x(() => {` turns a function body into `(async () => {}) || x(…)`. Stopping short of the end (`a); b(`)
 * fails the length check.
 */
function isWrapper(outer: ParenNode, kind: CodeKind, length: number): boolean {
  if (outer.type !== 'ParenthesizedExpression' || outer.start !== 0 || outer.end !== length) return false
  return kind === 'expression' || outer.expression?.type === 'ArrowFunctionExpression'
}

function syntaxError(message: string, pos: number, length: number): TemplateError {
  // acorn appends "(line:col)" relative to the wrapped source, which would be off by the wrapper; drop it.
  const clean = message.replace(/\s*\(\d+:\d+\)$/, '')
  const start = Math.max(0, Math.min(pos, length))
  return new TemplateError(`Syntax error: ${clean}`, start, Math.min(start + 1, length))
}
