/**
 * A workflow's Python packages (M23, docs/architecture.md §2.26): `settings.python.requirements`, one PEP 508
 * requirement each, kept to a name, extras and version specifiers. Anything that would make pip fetch from elsewhere
 * or decide by platform (URLs, paths, options, environment markers) is refused: the builder installs wheels from
 * one index, for one platform.
 */

export const MAX_REQUIREMENTS = 30
export const MAX_REQUIREMENT_LENGTH = 200

export interface Requirement {
  /** As written. */
  name: string
  /** PEP 503's normalized name (`Scikit_Learn` → `scikit-learn`): two entries naming one package clash. */
  normalized: string
  extras: string[]
  /** `>=1.2`, `<2`, … (spaces removed); empty for any version. */
  specifiers: string[]
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const SPECIFIER = /^(~=|===|==|!=|<=|>=|<|>)([A-Za-z0-9.*+!_-]+)$/

export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** One requirement, or why it can't be one. */
export function parseRequirement(text: string): { requirement: Requirement } | { error: string } {
  const line = text.trim()
  if (!line) return { error: 'An empty requirement' }
  if (line.length > MAX_REQUIREMENT_LENGTH)
    return { error: `A requirement is at most ${MAX_REQUIREMENT_LENGTH} characters` }
  if (line.startsWith('#')) return { error: "Comments aren't kept: leave them out" }
  if (line.startsWith('-')) return { error: 'pip options (like -e or --index-url) are not allowed' }
  if (line.includes('://') || line.includes('@')) return { error: 'Only packages from the index: no URLs' }
  if (line.includes(';'))
    return { error: 'Environment markers are not allowed: the packages are for one platform' }
  if (/[/\\]/.test(line)) return { error: 'Only packages from the index: no paths' }
  const match = /^([^[\s<>=!~,]+)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(line)
  const name = match?.[1] ?? ''
  if (!NAME.test(name)) return { error: `"${name || line}" isn't a package name` }
  const extras = (match?.[2] ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  const badExtra = extras.find((e) => !NAME.test(e))
  if (badExtra !== undefined) return { error: `"${badExtra}" isn't an extra's name` }
  const rest = (match?.[3] ?? '').trim()
  const specifiers: string[] = []
  if (rest) {
    for (const part of rest.split(',')) {
      const spec = part.replace(/\s+/g, '')
      if (!SPECIFIER.test(spec))
        return { error: `"${part.trim()}" isn't a version specifier (like >=1.2 or ==2.0.1)` }
      specifiers.push(spec)
    }
  }
  return { requirement: { name, normalized: normalizePackageName(name), extras, specifiers } }
}

/** Every requirement's problem, by its index; duplicates (by normalized name) after the first. */
export function requirementProblems(requirements: readonly string[]): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = []
  const seen = new Map<string, number>()
  requirements.forEach((text, index) => {
    const parsed = parseRequirement(text)
    if ('error' in parsed) {
      problems.push({ index, message: parsed.error })
      return
    }
    const first = seen.get(parsed.requirement.normalized)
    if (first !== undefined) {
      problems.push({ index, message: `"${parsed.requirement.name}" is already on line ${first + 1}` })
    } else seen.set(parsed.requirement.normalized, index)
  })
  return problems
}

/**
 * What the package builder resolved a workflow's requirements to (M23): every package, its version and its wheel's
 * sha256, for one platform. A release keeps it, so live runs install exactly that.
 */
export interface PythonLock {
  platform: string
  packages: { name: string; version: string; sha256: string }[]
}
