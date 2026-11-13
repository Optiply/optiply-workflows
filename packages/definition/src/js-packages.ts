/**
 * A workflow's or app's JavaScript packages (docs/architecture.md, JS packages): `settings.javascript.packages` (an
 * app's `javascript.packages`), one npm package each, written `name` or `name@range`: `zod@^3`, `date-fns`,
 * `@acme/utils@1.2.0`. They come from the npm registries (the default or the one for their `@scope`), so anything
 * that would make npm fetch from elsewhere (URLs, git, paths, aliases) is refused. The server installs and bundles
 * them for the sandbox; the release keeps the exact versions.
 */

export const MAX_JS_PACKAGES = 30
export const MAX_JS_PACKAGE_LENGTH = 200

export interface JsPackage {
  /** `zod`, `@acme/utils`. */
  name: string
  /** `^3`, `1.2.0`, `latest`, …; empty for any version (npm's `latest`). */
  range: string
}

/** npm's rules for new package names: lowercase, URL-safe, not starting with `.` or `_`, at most 214 characters. */
const PART = /^[a-z0-9-~][a-z0-9-._~]*$/
/** A semver range (`^1.2`, `>=1 <2`, `1.x || 2`) or a dist-tag (`latest`, `next`): nothing that names a place. */
const RANGE = /^[A-Za-z0-9.*^~<>=|+\s-]+$/

export function isJsPackageName(name: string): boolean {
  if (name.length > 214) return false
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name)
  if (scoped) return PART.test(scoped[1]!) && PART.test(scoped[2]!)
  return PART.test(name)
}

/** A line's name and range, as written, without checking either: the name ends at the `@` after its scope's. */
export function splitJsPackage(text: string): JsPackage {
  const line = text.trim()
  const at = line.indexOf('@', line.startsWith('@') ? 1 : 0)
  return at < 0
    ? { name: line, range: '' }
    : { name: line.slice(0, at).trim(), range: line.slice(at + 1).trim() }
}

/** One package, or why it can't be one. */
export function parseJsPackage(text: string): { package: JsPackage } | { error: string } {
  const line = text.trim()
  if (!line) return { error: 'An empty package' }
  if (line.length > MAX_JS_PACKAGE_LENGTH)
    return { error: `A package is at most ${MAX_JS_PACKAGE_LENGTH} characters` }
  if (line.startsWith('#') || line.startsWith('//')) return { error: "Comments aren't kept: leave them out" }
  if (line.startsWith('-')) return { error: 'npm options are not allowed' }
  const at = line.indexOf('@', line.startsWith('@') ? 1 : 0)
  const { name, range } = splitJsPackage(line)
  if (
    /:\/\/|^(git|github|gitlab|bitbucket|file|link|workspace|npm|http|https):/.test(range) ||
    line.includes('://')
  )
    return { error: 'Only packages from the npm registries: no URLs, git, paths or aliases' }
  if (
    name.startsWith('.') ||
    name.startsWith('/') ||
    name.includes('\\') ||
    (name.match(/\//g)?.length ?? 0) > 1
  )
    return { error: 'Only packages from the npm registries: no paths' }
  if (!name.startsWith('@') && name.includes('/'))
    return { error: `"${name}" looks like a GitHub repository: only packages from the npm registries` }
  if (!isJsPackageName(name))
    return { error: `"${name || line}" isn't an npm package name (lowercase, like date-fns or @acme/utils)` }
  if (at >= 0 && !range)
    return { error: `Nothing after "${name}@": a version (like ^1.2) or leave the @ out` }
  // npm reads a spec starting with `.` (`..`, `.`, `./x`) as a directory: never a range.
  if (range.startsWith('.'))
    return { error: 'Only packages from the npm registries: no URLs, git, paths or aliases' }
  if (range && (!RANGE.test(range) || range.includes('/') || range.includes(':')))
    return { error: `"${range}" isn't a version range (like ^1.2, ~2.0.1 or latest)` }
  return { package: { name, range: range.replace(/\s+/g, ' ') } }
}

/** Every package's problem, by its index; duplicates after the first. */
export function jsPackageProblems(packages: readonly string[]): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = []
  const seen = new Map<string, number>()
  packages.forEach((text, index) => {
    const parsed = parseJsPackage(text)
    if ('error' in parsed) {
      problems.push({ index, message: parsed.error })
      return
    }
    const first = seen.get(parsed.package.name)
    if (first !== undefined)
      problems.push({ index, message: `"${parsed.package.name}" is already on line ${first + 1}` })
    else seen.set(parsed.package.name, index)
  })
  return problems
}

/** The packages that parse, as npm's `dependencies` (`name` → range, `*` for any version): what the server installs. */
export function jsDependencies(packages: readonly string[]): Record<string, string> {
  const deps: Record<string, string> = {}
  for (const text of packages) {
    const parsed = parseJsPackage(text)
    if ('package' in parsed && !(parsed.package.name in deps))
      deps[parsed.package.name] = parsed.package.range || '*'
  }
  return deps
}
