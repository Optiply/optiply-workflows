import { splitJsPackage } from '@ow/definition'
import { isRecord, type Problem, parseJsonFile, textFile, type Warning } from './files'

/**
 * A workflow's or app's JavaScript packages, as npm writes them: `{"private": true, "dependencies": {name: range}}`
 * (an empty range for a bare name, so `zod` and `zod@*` both come back as written). In the list's order, not
 * sorted: the order is the author's. Read back, only `dependencies` counts (people edit it on GitHub, and npm adds
 * fields of its own).
 */
export const PACKAGE_FILE = 'package.json'

export function packageJsonFile(packages: readonly string[]): { content: string; warnings: Warning[] } {
  const dependencies: Record<string, string> = {}
  const warnings: Warning[] = []
  for (const text of packages) {
    const { name, range } = splitJsPackage(text)
    if (name in dependencies) {
      warnings.push({
        path: PACKAGE_FILE,
        message: `"${name}" is listed twice: ${PACKAGE_FILE} keeps the first`,
      })
      continue
    }
    dependencies[name] = range
  }
  return { content: textFile(JSON.stringify({ private: true, dependencies }, null, 2)), warnings }
}

/** The package list from `package.json`, or the problems with it. */
export function readPackageJson(content: string): { packages: string[] } | { problems: Problem[] } {
  const parsed = parseJsonFile(PACKAGE_FILE, content)
  if (!parsed.ok) return { problems: [parsed.problem] }
  if (!isRecord(parsed.value)) return { problems: [invalid(PACKAGE_FILE, 'Expected an object')] }
  const deps = parsed.value.dependencies ?? {}
  if (!isRecord(deps)) return { problems: [invalid(PACKAGE_FILE, 'dependencies: expected an object')] }
  const problems: Problem[] = []
  const packages: string[] = []
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range !== 'string') {
      problems.push(invalid(PACKAGE_FILE, `dependencies.${name}: expected a version range (a string)`))
      continue
    }
    const trimmed = range.trim()
    packages.push(trimmed ? `${name}@${trimmed}` : name)
  }
  return problems.length ? { problems } : { packages }
}

function invalid(path: string, message: string): Problem {
  return { path, code: 'invalid_definition', message: `${path}: ${message}` }
}
