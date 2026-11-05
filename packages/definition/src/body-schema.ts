import { Ajv2020 } from 'ajv/dist/2020.js'
import type { RegExpEngine } from 'ajv/dist/types/index.js'
import addFormats from 'ajv-formats'

/**
 * JSON Schemas for webhook bodies (M15), compiled with Ajv. A subpath of its own (`@ow/definition/body-schema`) so
 * the package's main entry stays free of Ajv and its generated code: the validator takes `checkBodySchema` as an
 * option, given by the server and the editor.
 */

export interface BodySchemaError {
  /** JSON Pointer into the body (`/items/0/id`); empty for the body itself. */
  path: string
  message: string
}

export type BodyValidator = (body: unknown) => BodySchemaError[] | null

export type CompiledBodySchema = { ok: true; validate: BodyValidator } | { ok: false; error: string }

/** At most this many errors are reported for one body. */
export const MAX_BODY_SCHEMA_ERRORS = 10

let regExp: RegExpEngine | undefined

/**
 * The engine `pattern` and `patternProperties` run on (session 40). The server sets RE2 at startup, so a pattern an
 * editor wrote runs in linear time on callers' input (JavaScript's backtracking engine can take minutes on a
 * pattern like `^(a+)+$`, blocking the process); the browser keeps JavaScript's, as it only compiles schemas.
 * `patternProblem` refuses what RE2 lacks in both, so the editor and the server agree.
 */
export function setBodySchemaRegExp(engine: RegExpEngine): void {
  regExp = engine
  checked.clear()
}

const LOOKAROUND =
  'lookahead and lookbehind ((?=, (?!, (?<=, (?<!) aren’t supported: patterns run on RE2, in linear time'
const BACKREFERENCE = 'backreferences (\\1, \\k<name>) aren’t supported: patterns run on RE2, in linear time'

/** Why RE2 can't run a pattern that JavaScript can: lookarounds and backreferences. Null when it can. */
export function patternProblem(pattern: string): string | null {
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[i + 1]
      if (
        !inClass &&
        next !== undefined &&
        (/[1-9]/.test(next) || (next === 'k' && pattern[i + 2] === '<'))
      ) {
        return BACKREFERENCE
      }
      i++
    } else if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') {
      inClass = true
    } else if (c === '(' && pattern[i + 1] === '?') {
      const kind = pattern.slice(i + 2, i + 4)
      if (kind[0] === '=' || kind[0] === '!' || kind === '<=' || kind === '<!') return LOOKAROUND
    }
  }
  return null
}

/** Keywords whose values are data, not schemas: a `pattern` key inside them is just a value. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples'])
/** Keywords whose values map names to schemas (a property may be called `pattern`). */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The first pattern in a schema RE2 can't run, as `<pointer>: <why>`, or null. */
function schemaPatternProblem(node: unknown, path = ''): string | null {
  if (!isObject(node)) return null
  for (const [key, value] of Object.entries(node)) {
    const here = `${path}/${key}`
    if (DATA_KEYWORDS.has(key)) continue
    if (key === 'pattern' && typeof value === 'string') {
      const why = patternProblem(value)
      if (why) return `${here}: ${why}`
    } else if (SCHEMA_MAPS.has(key) && isObject(value)) {
      for (const [name, sub] of Object.entries(value)) {
        const why = key === 'patternProperties' ? patternProblem(name) : null
        if (why) return `${here}: "${name}": ${why}`
        const inner = schemaPatternProblem(sub, `${here}/${name}`)
        if (inner) return inner
      }
    } else if (Array.isArray(value)) {
      for (const [i, sub] of value.entries()) {
        const inner = schemaPatternProblem(sub, `${here}/${i}`)
        if (inner) return inner
      }
    } else {
      const inner = schemaPatternProblem(value, here)
      if (inner) return inner
    }
  }
  return null
}

/**
 * Compiles a body schema (draft 2020-12, formats included). Strict: unknown keywords and formats are errors, so a
 * typo doesn't silently accept everything. Nothing is fetched: a `$ref` must point inside the schema.
 */
export function compileBodySchema(schema: unknown): CompiledBodySchema {
  const unsupported = schemaPatternProblem(schema)
  if (unsupported) return { ok: false, error: unsupported }
  // A new instance each time: Ajv refuses a second schema with the same `$id` in one instance.
  const ajv = new Ajv2020({
    ...(regExp && { code: { regExp } }),
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
  })
  addFormats(ajv)
  try {
    const validate = ajv.compile(schema as object)
    return {
      ok: true,
      validate: (body) => {
        if (validate(body)) return null
        return (validate.errors ?? []).slice(0, MAX_BODY_SCHEMA_ERRORS).map((e) => ({
          path: e.instancePath,
          message: e.message ?? 'is invalid',
        }))
      },
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

const checked = new Map<string, string | null>()
const CHECK_CACHE_SIZE = 20

/**
 * Why a body schema doesn't compile, or null when it does: the validator's `checkBodySchema`. The last few results
 * are kept, since the editor validates on every change.
 */
export function checkBodySchema(schema: unknown): string | null {
  const key = JSON.stringify(schema)
  if (checked.has(key)) return checked.get(key)!
  const compiled = compileBodySchema(schema)
  const error = compiled.ok ? null : compiled.error
  if (checked.size >= CHECK_CACHE_SIZE) checked.delete(checked.keys().next().value!)
  checked.set(key, error)
  return error
}
