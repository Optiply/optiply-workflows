/** Words a block name can't be: it would not work as a variable. */
const RESERVED_WORDS = new Set(
  (
    'await break case catch class const continue debugger default delete do else enum export extends false ' +
    'finally for function if implements import in instanceof interface let new null package private protected ' +
    'public return static super switch this throw true try typeof var void while with yield arguments eval'
  ).split(' '),
)

/** ECMAScript globals that exist in a bare V8 isolate (no timers, fetch or other host APIs). */
export const JS_GLOBALS: ReadonlySet<string> = new Set(
  (
    'globalThis Infinity NaN undefined isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent ' +
    'encodeURI encodeURIComponent escape unescape AggregateError Array ArrayBuffer Atomics BigInt ' +
    'BigInt64Array BigUint64Array Boolean DataView Date Error EvalError FinalizationRegistry Float32Array ' +
    'Float64Array Function Int8Array Int16Array Int32Array Intl Iterator JSON Map Math Number Object Promise ' +
    'Proxy RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer String Symbol SyntaxError TypeError ' +
    'Uint8Array Uint8ClampedArray Uint16Array Uint32Array URIError WeakMap WeakRef WeakSet'
  ).split(' '),
)

/** Baked into the @ow/sandbox snapshot. */
export const SANDBOX_GLOBALS: ReadonlySet<string> = new Set(['_', 'dayjs', 'sql', 'console', 'fetch'])

/** Globals that return promises: usable in code (which can `await`), not in `{{ }}` or conditions. */
export const CODE_ONLY_GLOBALS: ReadonlySet<string> = new Set(['fetch'])

/** Added by the engine to every evaluation in a run. */
export const RUN_GLOBALS: ReadonlySet<string> = new Set(['configVars', 'workflowContext', 'idempotencyKey'])

/** What a function's blocks read their arguments from: `{{ params.customerId }}`. */
export const PARAMS_NAME = 'params'

/** Python's keywords that JavaScript doesn't have: a block named so couldn't be read from Python code. */
const PYTHON_ONLY_KEYWORDS = new Set(
  'False None True and as assert async def del elif except from global is lambda nonlocal not or pass raise'.split(
    ' ',
  ),
)

/** JavaScript keywords and the like, which can't be variable names. */
export function isReservedWord(name: string): boolean {
  return RESERVED_WORDS.has(name)
}

/** True when expressions can read `name` without it being a block. */
export function isGlobalName(name: string): boolean {
  return JS_GLOBALS.has(name) || SANDBOX_GLOBALS.has(name) || RUN_GLOBALS.has(name)
}

/** Why `name` can't be a block name, or null if it can. Assumes the identifier pattern already matched. */
export function reservedNameReason(name: string): string | null {
  if (RESERVED_WORDS.has(name)) return `"${name}" is a JavaScript keyword`
  if (PYTHON_ONLY_KEYWORDS.has(name)) return `"${name}" is a Python keyword`
  if (isGlobalName(name)) return `"${name}" is already a global available to expressions`
  if (name === PARAMS_NAME) return `"${name}" is reserved for function parameters`
  return null
}
