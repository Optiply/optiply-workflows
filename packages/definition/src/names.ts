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
export const SANDBOX_GLOBALS: ReadonlySet<string> = new Set(['_', 'dayjs', 'console'])

/** Added by the engine to every evaluation in a run. */
export const RUN_GLOBALS: ReadonlySet<string> = new Set(['configVars', 'workflowContext', 'idempotencyKey'])

/** True when expressions can read `name` without it being a block. */
export function isGlobalName(name: string): boolean {
  return JS_GLOBALS.has(name) || SANDBOX_GLOBALS.has(name) || RUN_GLOBALS.has(name)
}

/** Why `name` can't be a block name, or null if it can. Assumes the identifier pattern already matched. */
export function reservedNameReason(name: string): string | null {
  if (RESERVED_WORDS.has(name)) return `"${name}" is a JavaScript keyword`
  if (isGlobalName(name)) return `"${name}" is already a global available to expressions`
  return null
}
