import type { IdentifierRef } from './identifiers'

/**
 * What a Python code block reads from outside itself, found without a Python parser: a tokenizer (strings with
 * every prefix, triple quotes and f-strings, whose `{…}` fields are code; comments; line continuations) and a pass
 * over the tokens that knows which names are attributes, keyword arguments, import paths, and which the code binds
 * itself. Python's own rule is that a name assigned anywhere in a function is local to it; the code is one function
 * body, so a name it binds anywhere (assignments, `for` targets, `as`, `def`/`class`, parameters, imports, `:=`, `del`) is
 * its own, not a block's. Nested functions and comprehensions are treated as part of the body (their bindings count
 * everywhere), which only matters when a block shares a name with one of their variables.
 *
 * Never throws: Python's syntax is checked by the executor. Offsets are into the code passed in.
 */
export interface PythonAnalysis {
  /** Names read and not bound by the code, not keywords and not builtins, in source order. */
  refs: IdentifierRef[]
  /** Builtins the code reads (`len`, `print`), which a block of the same name can't replace. */
  builtins: IdentifierRef[]
  /** Names the code binds (its own variables). */
  bound: Set<string>
  /** Where each bound name is first bound (for a warning when it hides a block or a run global). */
  bindings: IdentifierRef[]
}

/** Python 3.12's keywords (`keyword.kwlist`): never names. */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'False None True and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield'
  ).split(' '),
)

/** Python 3.12's builtins (`dir(builtins)` without the dunders). */
export const PYTHON_BUILTINS: ReadonlySet<string> = new Set(
  (
    'ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError ' +
    'BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError ' +
    'ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError Ellipsis EncodingWarning ' +
    'EnvironmentError Exception ExceptionGroup FileExistsError FileNotFoundError FloatingPointError FutureWarning ' +
    'GeneratorExit IOError ImportError ImportWarning IndentationError IndexError InterruptedError ' +
    'IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError ' +
    'NotADirectoryError NotImplemented NotImplementedError OSError OverflowError PendingDeprecationWarning ' +
    'PermissionError ProcessLookupError RecursionError ReferenceError ResourceWarning RuntimeError ' +
    'RuntimeWarning StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError SystemExit TabError ' +
    'TimeoutError TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError ' +
    'UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning ZeroDivisionError abs aiter all anext ' +
    'any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits ' +
    'delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash ' +
    'help hex id input int isinstance issubclass iter len license list locals map max memoryview min next object ' +
    'oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum ' +
    'super tuple type vars zip'
  ).split(' '),
)

type TokenType = 'name' | 'number' | 'string' | 'op' | 'newline'

interface Token {
  type: TokenType
  value: string
  start: number
  end: number
}

// Longest first.
const OPERATORS = [
  '**=',
  '//=',
  '>>=',
  '<<=',
  '...',
  '->',
  ':=',
  '==',
  '!=',
  '<=',
  '>=',
  '**',
  '//',
  '<<',
  '>>',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '@=',
]
const AUGMENTED = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@='])
const ID_START = /[\p{L}\p{Nl}_]/u
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]/u
const STRING_START = /^([rRbBuUfFtT]{0,2})('''|"""|'|")/

/** A token stream; an f-string's fields are lexed in place, between `{f` and `}f` markers. */
class Lexer {
  readonly tokens: Token[] = []

  constructor(private readonly src: string) {}

  private push(type: TokenType, value: string, start: number, end = start + value.length) {
    this.tokens.push({ type, value, start, end })
  }

  /**
   * Lexes from `i` to the end, or, inside an f-string field, up to the `}`, `:` or `!` that ends its expression at
   * bracket depth 0 (not consumed). Returns where it stopped.
   */
  run(i: number, inField = false): number {
    const s = this.src
    let nest = 0
    while (i < s.length) {
      const c = s[i]!
      if (inField && nest === 0 && (c === '}' || c === ':' || (c === '!' && s[i + 1] !== '='))) return i
      if (c === '#') {
        while (i < s.length && s[i] !== '\n') i++
        continue
      }
      if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
        i += s[i + 1] === '\n' ? 2 : 3
        continue
      }
      if (c === '\n') {
        // Inside brackets a line break doesn't end anything (implicit line joining).
        if (!inField && nest === 0) this.push('newline', '\n', i)
        i++
        continue
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
        i++
        continue
      }
      const string = STRING_START.exec(s.slice(i, i + 5))
      if (string && validPrefix(string[1]!)) {
        i = this.string(i, string[1]!, string[2]!)
        continue
      }
      if (ID_START.test(c) || c.charCodeAt(0) > 0x7f) {
        let j = i + 1
        while (j < s.length && ID_PART.test(s[j]!)) j++
        if (j === i + 1 && !ID_START.test(c)) {
          i++ // a stray non-ASCII character
          continue
        }
        this.push('name', s.slice(i, j), i, j)
        i = j
        continue
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
        let j = i + 1
        while (j < s.length) {
          const d = s[j]!
          if (/[0-9a-zA-Z_.]/.test(d)) j++
          else if ((d === '+' || d === '-') && /[eE]/.test(s[j - 1]!) && !/^0[xX]/.test(s.slice(i, j))) j++
          else break
        }
        this.push('number', s.slice(i, j), i, j)
        i = j
        continue
      }
      const op = OPERATORS.find((o) => s.startsWith(o, i)) ?? c
      this.push('op', op, i)
      if (op === '(' || op === '[' || op === '{') nest++
      else if ((op === ')' || op === ']' || op === '}') && nest > 0) nest--
      i += op.length
    }
    return i
  }

  /** A string literal from `start`; an f-string's fields become tokens. Returns the index after it. */
  private string(start: number, prefix: string, quote: string): number {
    const s = this.src
    const formatted = /[fFtT]/.test(prefix)
    let j = start + prefix.length + quote.length
    const at = this.tokens.length
    this.push('string', '', start, start) // the end and text are filled in below
    let end = s.length
    while (j < s.length) {
      if (s.startsWith(quote, j)) {
        end = j + quote.length
        break
      }
      const c = s[j]!
      if (c === '\\') {
        j += 2
        continue
      }
      if (quote.length === 1 && c === '\n') {
        end = j // unterminated: the line ends it
        break
      }
      if (formatted && c === '{') {
        if (s[j + 1] === '{') {
          j += 2
          continue
        }
        j = this.field(j)
        continue
      }
      j++
    }
    const token = this.tokens[at]!
    token.end = Math.min(end, s.length)
    token.value = s.slice(start, token.end)
    return token.end
  }

  /** An f-string replacement field from its `{`: the expression, `!r`, a format spec (which may hold fields). */
  private field(open: number): number {
    const s = this.src
    this.push('op', '{f', open, open + 1)
    let j = this.run(open + 1, true)
    if (s[j] === '!') j += 2
    if (s[j] === ':') {
      j++
      while (j < s.length && s[j] !== '}' && s[j] !== '\n') {
        if (s[j] === '{') j = this.field(j)
        else j++
      }
    }
    if (s[j] === '}') {
      this.push('op', '}f', j, j + 1)
      return j + 1
    }
    return j
  }
}

function validPrefix(prefix: string): boolean {
  const p = prefix.toLowerCase()
  return ['', 'r', 'b', 'u', 'f', 't', 'rb', 'br', 'fr', 'rf', 'tr', 'rt'].includes(p)
}

type BracketKind = 'call' | 'subscript' | 'display' | 'params' | 'field'

interface Bracket {
  kind: BracketKind
  /** The token index of the opening bracket. */
  at: number
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '}f': '{f' }

/** What a Python code block reads from outside itself: see {@link PythonAnalysis}. */
export function analyzePython(code: string, options: { properties?: boolean } = {}): PythonAnalysis {
  const lexer = new Lexer(code)
  lexer.run(0)
  const tokens = lexer.tokens
  const n = tokens.length
  const is = (t: Token | undefined, value: string) =>
    t !== undefined && t.type !== 'string' && t.value === value
  const isKeyword = (t: Token | undefined, kw: string) => t?.type === 'name' && t.value === kw

  // Each token's bracket context (the innermost open bracket), and statement boundaries at depth 0.
  const context: (Bracket | undefined)[] = new Array(n)
  const statement: number[] = new Array(n) // the index of the statement's first token
  const stack: Bracket[] = []
  let stmtStart = 0
  for (let t = 0; t < n; t++) {
    const tok = tokens[t]!
    if (stack.length === 0 && (tok.type === 'newline' || is(tok, ';'))) {
      context[t] = undefined
      statement[t] = stmtStart
      stmtStart = t + 1
      continue
    }
    context[t] = stack.at(-1)
    statement[t] = stmtStart
    if (tok.type !== 'op') continue
    if (tok.value === '(' || tok.value === '[' || tok.value === '{' || tok.value === '{f') {
      const prev = tokens[t - 1]
      // After a name, a call or a subscript, a string: a call or subscript; otherwise a tuple, list or dict.
      const after =
        prev !== undefined &&
        (prev.type === 'name'
          ? !PYTHON_KEYWORDS.has(prev.value)
          : prev.type === 'string' || is(prev, ')') || is(prev, ']'))
      let kind: BracketKind = 'display'
      if (tok.value === '{f') kind = 'field'
      else if (tok.value === '(' && prev?.type === 'name' && isKeyword(tokens[t - 2], 'def')) kind = 'params'
      else if (tok.value === '(' && after) kind = 'call'
      else if (tok.value === '[' && after) kind = 'subscript'
      stack.push({ kind, at: t })
    } else if (tok.value in CLOSERS) {
      // Unbalanced code (being typed): close what matches, ignore the rest.
      const want = CLOSERS[tok.value]!
      const k = stack.map((b) => tokens[b.at]!.value).lastIndexOf(want)
      if (k >= 0) stack.length = k
    } else if (tok.value === ':' && stack.length === 0) {
      // A compound statement's header ends here (`if x: y = 1`): what follows is a statement of its own.
      const first = tokens[stmtStart]
      if (first?.type === 'name' && COMPOUND.has(first.value) && !inLambda(tokens, stmtStart, t))
        stmtStart = t + 1
    }
  }

  const bound = new Set<string>()
  const bindings: IdentifierRef[] = []
  const declared = new Set<string>() // global / nonlocal: not the code's own
  const notRef = new Set<number>() // name tokens that aren't references (attributes, kwargs, import paths, keywords)

  // Import statements: their names are module paths or bindings, never references.
  for (let t = 0; t < n; t++) {
    const tok = tokens[t]!
    if (tok.type !== 'name' || statement[t] !== t || context[t]) continue
    if (tok.value === 'import' || tok.value === 'from') {
      let u = t
      for (; u < n && statement[u] === t && tokens[u]!.type !== 'newline' && !is(tokens[u], ';'); u++) {
        if (tokens[u]!.type === 'name') notRef.add(u)
      }
      for (const name of importBindings(tokens, t, u)) bound.add(name)
    }
  }

  for (let t = 0; t < n; t++) {
    const tok = tokens[t]!
    if (tok.type !== 'name') continue
    if (PYTHON_KEYWORDS.has(tok.value)) {
      notRef.add(t)
      continue
    }
    if (notRef.has(t)) continue
    const prev = tokens[t - 1]
    const next = tokens[t + 1]
    const ctx = context[t]
    if (is(prev, '.')) {
      notRef.add(t)
      continue
    }
    // A keyword argument's name, f(x=1): the callee's parameter, not a variable.
    if (ctx?.kind === 'call' && is(next, '=') && (is(prev, '(') || is(prev, ','))) {
      notRef.add(t)
      continue
    }
    if (
      isKeyword(prev, 'global') ||
      isKeyword(prev, 'nonlocal') ||
      (is(prev, ',') && declaresNames(tokens, t))
    ) {
      declared.add(tok.value)
      continue
    }
    if (bindsName(tokens, t, context, statement)) {
      if (!bound.has(tok.value)) bindings.push({ name: tok.value, start: tok.start, end: tok.end })
      bound.add(tok.value)
    }
  }
  for (const name of declared) bound.delete(name)

  const refs: IdentifierRef[] = []
  const builtins: IdentifierRef[] = []
  for (let t = 0; t < n; t++) {
    const tok = tokens[t]!
    if (tok.type !== 'name' || notRef.has(t) || bound.has(tok.value)) continue
    const ref: IdentifierRef = { name: tok.value, start: tok.start, end: tok.end }
    if (options.properties) {
      const property = propertyAfter(tokens, t)
      if (property !== undefined) ref.property = property
    }
    if (PYTHON_BUILTINS.has(tok.value)) builtins.push(ref)
    else refs.push(ref)
  }
  return { refs, builtins, bound, bindings: bindings.filter((b) => bound.has(b.name)) }
}

/** Statements whose header ends with a `:` that may be followed by a statement on the same line. */
const COMPOUND = new Set([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'with',
  'try',
  'except',
  'finally',
  'def',
  'class',
  'async',
])

/** Whether a `:` at `colon` belongs to a lambda opened since `from` (`x = lambda a: a`), not to a header. */
function inLambda(tokens: Token[], from: number, colon: number): boolean {
  let lambdas = 0
  for (let t = from; t < colon; t++) {
    if (tokens[t]!.type === 'name' && tokens[t]!.value === 'lambda') lambdas++
    if (tokens[t]!.type === 'op' && tokens[t]!.value === ':') lambdas = Math.max(0, lambdas - 1)
  }
  return lambdas > 0
}

/** `x` in `global a, x`: the statement started with `global` or `nonlocal`. */
function declaresNames(tokens: Token[], t: number): boolean {
  for (let u = t - 1; u >= 0; u--) {
    const tok = tokens[u]!
    if (tok.type === 'name' && (tok.value === 'global' || tok.value === 'nonlocal')) return true
    if (!(tok.type === 'name' || (tok.type === 'op' && tok.value === ','))) return false
  }
  return false
}

/** The names an import statement (tokens `from` to `to`) binds. */
function importBindings(tokens: Token[], from: number, to: number): string[] {
  const names: string[] = []
  let t = from
  if (tokens[t]!.value === 'from') {
    while (t < to && !(tokens[t]!.type === 'name' && tokens[t]!.value === 'import')) t++
    t++
    // `from m import a, b as c` (maybe in parentheses): each name, or its alias.
    for (; t < to; t++) {
      const tok = tokens[t]!
      if (tok.type !== 'name' || tok.value === 'as') continue
      const asName = tokens[t + 1]?.value === 'as' ? tokens[t + 2] : undefined
      names.push(asName?.type === 'name' ? asName.value : tok.value)
      if (asName) t += 2
    }
    return names
  }
  // `import a.b.c, d as e`: the first part of each path, or its alias.
  let itemStart = true
  for (t = from + 1; t < to; t++) {
    const tok = tokens[t]!
    if (tok.type === 'op' && tok.value === ',') {
      itemStart = true
      continue
    }
    if (tok.type !== 'name') continue
    if (tok.value === 'as') {
      const alias = tokens[t + 1]
      if (alias?.type === 'name') {
        names.pop()
        names.push(alias.value)
      }
      t++
      continue
    }
    if (itemStart) names.push(tok.value)
    itemStart = false
  }
  return names
}

const TARGET_BEFORE = new Set([',', '*', '(', '['])
const TARGET_AFTER = new Set([',', ')', ']', '=', ':=', ...AUGMENTED])

/** Whether the name at `t` is bound there (assigned, a loop target, `as`, a definition, a parameter). */
function bindsName(
  tokens: Token[],
  t: number,
  context: (Bracket | undefined)[],
  statement: number[],
): boolean {
  const prev = tokens[t - 1]
  const next = tokens[t + 1]
  const op = (tok: Token | undefined) => (tok?.type === 'op' ? tok.value : undefined)
  const kw = (tok: Token | undefined) => (tok?.type === 'name' ? tok.value : undefined)
  const ctx = context[t]

  if (kw(prev) === 'as' || kw(prev) === 'def' || kw(prev) === 'class') return true
  // del a, b: deleting a name makes it local too; del a[0] or del a.b doesn't (it reads a).
  const plainDelTarget = !['.', '[', '('].includes(op(next) ?? '')
  if (kw(prev) === 'del' && plainDelTarget) return true
  if (!ctx && op(prev) === ',' && kw(tokens[statement[t]!]) === 'del' && plainDelTarget) return true
  if (op(next) === ':=') return true
  // The middle of a chained assignment: a = b = 1.
  if (!ctx && op(prev) === '=' && op(next) === '=') return true

  // A parameter: def f(a, b=1, *c, d: int, **e).
  if (
    ctx?.kind === 'params' &&
    (TARGET_BEFORE.has(op(prev) ?? '') || op(prev) === '**' || op(prev) === '/')
  ) {
    return [',', ')', '=', ':'].includes(op(next) ?? '')
  }
  // A lambda's parameter: lambda a, b=1: ...
  const lambdaAt = lambdaParamsStart(tokens, t)
  if (lambdaAt >= 0) return true

  // A for target (statement or comprehension): for a, (b, c) in ...
  if (forTarget(tokens, t)) return true

  // An assignment target at statement level (or inside a tuple or list target): a = …, a, b = …, a += …, a: int.
  const prevOk =
    prev === undefined || statement[t] === t || TARGET_BEFORE.has(op(prev) ?? '') || prev.type === 'newline'
  if (!prevOk) return false
  if (ctx && ctx.kind !== 'display') return false
  if (!TARGET_AFTER.has(op(next) ?? '') && op(next) !== ':') return false
  const first = statement[t]!
  if (op(next) === ':' && !ctx && first === t) return !COMPOUND.has(kw(tokens[t]) ?? '') // a: int (= 1)
  // The statement must assign after this name, at depth 0.
  for (let u = t + 1; u < tokens.length && statement[u] === first; u++) {
    const tok = tokens[u]!
    if (tok.type === 'newline' || (tok.type === 'op' && tok.value === ';' && !context[u])) break
    if (!context[u] && tok.type === 'op' && (tok.value === '=' || AUGMENTED.has(tok.value))) return true
  }
  return false
}

/** Index of the `lambda` whose parameter list holds the name at `t`, or -1. */
function lambdaParamsStart(tokens: Token[], t: number): number {
  const prev = tokens[t - 1]
  if (!prev) return -1
  if (prev.type === 'name' && prev.value === 'lambda') return t - 1
  if (!(prev.type === 'op' && (prev.value === ',' || prev.value === '*' || prev.value === '**'))) return -1
  // Walk back over `a, b=default, *c` to a `lambda` at the same depth, without crossing a `:`.
  let depth = 0
  for (let u = t - 1; u >= 0; u--) {
    const tok = tokens[u]!
    if (tok.type === 'op') {
      if (tok.value === ')' || tok.value === ']' || tok.value === '}') depth++
      else if (tok.value === '(' || tok.value === '[' || tok.value === '{' || tok.value === '{f') {
        if (depth === 0) return -1
        depth--
      } else if (depth === 0 && (tok.value === ':' || tok.value === '=' || tok.value === ';')) {
        if (tok.value === '=') continue // a default: keep looking for the lambda
        return -1
      }
    } else if (tok.type === 'newline') return -1
    else if (depth === 0 && tok.type === 'name' && tok.value === 'lambda') return u
  }
  return -1
}

/**
 * Whether the name at `t` is a target of a `for` (a statement or a comprehension): walking back over what a target
 * list can hold (names, commas, `*`, brackets) reaches the `for`.
 */
function forTarget(tokens: Token[], t: number): boolean {
  const next = tokens[t + 1]
  const after = next?.type === 'op' || next?.type === 'name' ? next.value : ''
  if (![',', ')', ']', 'in'].includes(after)) return false
  for (let u = t - 1; u >= 0; u--) {
    const tok = tokens[u]!
    if (tok.type === 'name') {
      if (tok.value === 'for') return true
      if (PYTHON_KEYWORDS.has(tok.value)) return false
      continue
    }
    if (tok.type === 'op' && [',', '*', '(', '[', ')', ']'].includes(tok.value)) continue
    return false
  }
  return false
}

/** The property read straight off the name at `t`: `b` in `a.b` and `a["b"]`. */
function propertyAfter(tokens: Token[], t: number): string | undefined {
  const next = tokens[t + 1]
  if (next?.type === 'op' && next.value === '.' && tokens[t + 2]?.type === 'name') return tokens[t + 2]!.value
  if (
    next?.type === 'op' &&
    next.value === '[' &&
    tokens[t + 3]?.type === 'op' &&
    tokens[t + 3]!.value === ']'
  ) {
    const key = tokens[t + 2]
    const literal = key?.type === 'string' ? /^(['"])([^'"\\]*)\1$/.exec(key.value) : null
    if (literal) return literal[2]
  }
  return undefined
}
