export const REDACTED = '[REDACTED]'

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|private[-_]?key/i

/** Values shorter than this aren't scrubbed by value: they'd match too much unrelated text. */
const MIN_SCRUB_LENGTH = 4

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

/** Recursively replaces values under secret-looking keys. Audit metadata must never contain credentials. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSecretKey(k) ? REDACTED : redact(v)]),
    )
  }
  return value
}

/** Every string leaf of a secrets object, e.g. to scrub decrypted credentials from driver error messages. */
export function secretStrings(secrets: unknown): string[] {
  if (typeof secrets === 'string') return [secrets]
  if (Array.isArray(secrets)) return secrets.flatMap(secretStrings)
  if (secrets && typeof secrets === 'object') return Object.values(secrets).flatMap(secretStrings)
  return []
}

/** Replaces every occurrence of the given secret values in `text` (longest first, so overlaps redact fully). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const needles = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const needle of needles) out = out.replaceAll(needle, REDACTED)
  return out
}

/** `scrubSecrets` applied to every string inside a JSON-like value (keys included). */
export function scrubSecretsDeep<T>(value: T, secrets: readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubSecrets(v, secrets)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubSecrets(k, secrets), walk(x)]))
    }
    return v
  }
  return walk(value) as T
}
