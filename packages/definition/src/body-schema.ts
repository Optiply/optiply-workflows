import { Ajv2020 } from 'ajv/dist/2020.js'
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

/**
 * Compiles a body schema (draft 2020-12, formats included). Strict: unknown keywords and formats are errors, so a
 * typo doesn't silently accept everything. Nothing is fetched: a `$ref` must point inside the schema.
 */
export function compileBodySchema(schema: unknown): CompiledBodySchema {
  // A new instance each time: Ajv refuses a second schema with the same `$id` in one instance.
  const ajv = new Ajv2020({
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
