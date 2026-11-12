import { type Node, parse, tokenizer, tokTypes } from 'acorn'
import type * as ESTree from 'estree'
import { TemplateError } from './template'

/**
 * `import` lines at the top of a JavaScript code body (a workflow's code block, an app's JS query): the packages it
 * uses from the workflow's or app's JavaScript packages. Code runs as a function body, where `import` isn't
 * JavaScript, so the lines are read here and become `const`s reading `__owImport(name)` (the sandbox's: the
 * package from the bundle, with CommonJS interop) on the same lines, so error lines and columns after them stay
 * right. Only at the top, before any other statement; `import(…)` and `import.meta` aren't import lines.
 */

export interface ImportBinding {
  /** `default`, `*` (the namespace) or the name exported. */
  imported: string
  local: string
}

export interface JsImport {
  /** The package (or its subpath, `lodash/chunk`) as written. */
  source: string
  bindings: ImportBinding[]
  /** Offsets of the whole line(s), and of the package name inside its quotes. */
  start: number
  end: number
  sourceStart: number
  sourceEnd: number
}

/** `import` not followed by `(` or `.`: an import declaration (or something that will fail to parse as one). */
const IMPORT_AT = /^import(?![\w$])\s*(?=[\w${*'"])/

/** The import lines at the top of `code`. Throws `TemplateError` when one doesn't parse. */
export function parseImports(code: string): JsImport[] {
  if (!code.includes('import')) return []
  const imports: JsImport[] = []
  let pos = skipBlank(code, 0)
  while (IMPORT_AT.test(code.slice(pos, pos + 80))) {
    const end = importEnd(code, pos)
    let declaration: ESTree.ImportDeclaration
    try {
      const program = parse(code.slice(pos, end), {
        ecmaVersion: 'latest',
        sourceType: 'module',
      }) as unknown as ESTree.Program
      const [first, ...rest] = program.body
      if (first?.type !== 'ImportDeclaration' || rest.length)
        throw new SyntaxError('Expected one import line')
      declaration = first
    } catch (err) {
      const at = (err as { pos?: number }).pos
      throw new TemplateError(
        `${(err as Error).message.replace(/\s*\(\d+:\d+\)$/, '')}`,
        at === undefined ? pos : pos + at,
        end,
      )
    }
    const node = declaration as ESTree.ImportDeclaration & Node
    const source = declaration.source as ESTree.Literal & Node
    imports.push({
      source: String(source.value),
      bindings: declaration.specifiers.map((s) => ({
        imported:
          s.type === 'ImportDefaultSpecifier'
            ? 'default'
            : s.type === 'ImportNamespaceSpecifier'
              ? '*'
              : s.imported.type === 'Identifier'
                ? s.imported.name
                : String(s.imported.value),
        local: s.local.name,
      })),
      start: pos + node.start,
      end: pos + node.end,
      sourceStart: pos + source.start + 1,
      sourceEnd: pos + source.end - 1,
    })
    pos = skipBlank(code, end)
  }
  return imports
}

/** `code` with its import lines as blanks (spaces, line breaks kept): every other offset stays where it was. */
export function blankImports(code: string, imports: readonly JsImport[]): string {
  let out = code
  for (const imp of imports) {
    out = out.slice(0, imp.start) + out.slice(imp.start, imp.end).replace(/[^\n]/g, ' ') + out.slice(imp.end)
  }
  return out
}

/**
 * `code` ready to run: each import line a `const` reading `__owImport`, on its first line, the line breaks it had
 * after it (lines below stay where they were). Unchanged without imports.
 */
export function rewriteImports(code: string, imports: readonly JsImport[] = parseImports(code)): string {
  let out = ''
  let at = 0
  imports.forEach((imp, i) => {
    const lines = code.slice(imp.start, imp.end).split('\n').length - 1
    out += code.slice(at, imp.start) + importStatement(imp, i) + '\n'.repeat(lines)
    at = imp.end
  })
  return out + code.slice(at)
}

/** The packages `code` imports (their names: `lodash` for `lodash/chunk`), with where each is named. */
export function importedPackages(
  imports: readonly JsImport[],
): { name: string; start: number; end: number }[] {
  return imports.map((imp) => ({ name: packageName(imp.source), start: imp.sourceStart, end: imp.sourceEnd }))
}

/** The package a specifier names: `@acme/utils` for `@acme/utils/x`, `lodash` for `lodash/chunk`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function importStatement(imp: JsImport, i: number): string {
  const load = `__owImport(${JSON.stringify(imp.source)})`
  if (!imp.bindings.length) return `${load};`
  const ns = `__owImport${i}`
  const parts = [`${ns} = ${load}`]
  const named: string[] = []
  for (const b of imp.bindings) {
    if (b.imported === '*') parts.push(`${b.local} = ${ns}`)
    else if (b.imported === 'default') parts.push(`${b.local} = ${ns}.default`)
    else named.push(`${JSON.stringify(b.imported)}: ${b.local}`)
  }
  if (named.length) parts.push(`{ ${named.join(', ')} } = ${ns}`)
  return `const ${parts.join(', ')};`
}

/** Where the import line starting at `pos` ends: after its package's string (and `with {…}`, and a `;`). */
function importEnd(code: string, pos: number): number {
  let end = code.length
  let afterSource = false
  let depth = 0
  try {
    for (const token of tokenizer(code.slice(pos), { ecmaVersion: 'latest', sourceType: 'module' })) {
      if (!afterSource) {
        if (token.type === tokTypes.braceL) depth++
        else if (token.type === tokTypes.braceR) depth--
        else if (token.type === tokTypes.string && depth === 0) {
          end = pos + token.end
          afterSource = true
        }
        continue
      }
      // Import attributes: `with { type: 'json' }`.
      if (token.type === tokTypes._with) {
        depth = -1
        continue
      }
      if (depth === -1) {
        if (token.type === tokTypes.braceR) {
          end = pos + token.end
          depth = 0
        }
        continue
      }
      if (token.type === tokTypes.semi) end = pos + token.end
      break
    }
  } catch {
    // Past the source a bad token is the next statement's problem; before it, the parse says what's wrong.
  }
  return end
}

/** The offset of the first character at or after `pos` that isn't white space or a comment. */
function skipBlank(code: string, pos: number): number {
  let i = pos
  for (;;) {
    while (i < code.length && /\s/.test(code[i]!)) i++
    if (code.startsWith('//', i)) {
      const nl = code.indexOf('\n', i)
      i = nl < 0 ? code.length : nl + 1
    } else if (code.startsWith('/*', i)) {
      const close = code.indexOf('*/', i + 2)
      i = close < 0 ? code.length : close + 2
    } else return i
  }
}
