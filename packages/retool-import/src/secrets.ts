import { parseTemplate } from '@ow/expressions'

/**
 * Finds secrets written into an export (a token typed into a header, say) so they never reach the imported app or
 * workflow: the converter puts `{{ configVars.RETOOL_SECRET_n }}` in their place and the report says which config
 * var to set. Only text written out is checked; `{{ }}` parts are code, not secrets.
 */

/** Header or parameter names whose written-out values are secrets, whatever they look like. */
const SECRET_NAMES =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|x-auth-token|auth[-_]?token|access[-_]?token|token|secret|client[-_]?secret|password|passwd|x-access-token|private[-_]?key|key)$/i

/** `Bearer abc…`, `Basic abc…`, `Token abc…` with a written-out credential. */
const SCHEME = /^(bearer|basic|token|apikey)\s+(\S{8,})$/i

/** Credentials recognisable on their own: a JWT, or a known provider's key prefix. */
const KNOWN_TOKEN =
  /^(eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}|(sk|pk|rk)_(live|test)_\w{8,}|(xox[abposr]-|ghp_|gho_|github_pat_|glpat-|AKIA|SG\.)[\w.-]{8,})$/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Long, without spaces, mixing letters and digits: hex or base64 keys (not uuids). */
function looksRandom(text: string): boolean {
  return (
    text.length >= 24 &&
    /^[A-Za-z0-9+/=_.-]+$/.test(text) &&
    /\d/.test(text) &&
    /[A-Za-z]/.test(text) &&
    !UUID.test(text)
  )
}

/** The written-out parts of a template; the whole value if it doesn't parse. */
function literalParts(value: string): string[] {
  try {
    return parseTemplate(value).flatMap((p) => (p.type === 'text' ? [p.value] : []))
  } catch {
    return [value]
  }
}

/**
 * The secret written out in `value`, found under `name` (a header or parameter name, if any): the exact text to
 * replace, or null when there's none.
 */
export function findSecret(value: string, name?: string): string | null {
  const parts = literalParts(value)
  if (!parts.length) return null
  const whole = value.trim()
  const allLiteral = parts.length === 1 && parts[0]!.trim() === whole
  const scheme = SCHEME.exec(whole)
  if (allLiteral && scheme) return scheme[2]!
  if (allLiteral && name && SECRET_NAMES.test(name.trim()) && whole.length >= 8) return whole
  if (allLiteral && name && looksRandom(whole)) return whole
  for (const part of parts) {
    for (const word of part.split(/[\s&?=/,;:"'{}()[\]]+/)) if (KNOWN_TOKEN.test(word)) return word
    // A URL's query string: `?api_key=abc…`.
    for (const m of part.matchAll(/[?&]([\w.-]+)=([^&#\s"']+)/g)) {
      if (SECRET_NAMES.test(m[1]!) && m[2]!.length >= 8) return m[2]!
    }
  }
  return null
}

/** `value` with the secret `found` replaced by the config var. */
export function replaceSecret(value: string, found: string, configVar: string): string {
  return value.split(found).join(`{{ configVars.${configVar} }}`)
}
