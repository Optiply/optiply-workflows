/**
 * Files as Git holds them: text by path, `/`-separated, relative to the object's directory (or the repo's root for
 * a whole repo). Kept sorted by path, so two encodings of the same thing compare equal.
 */
export type Files = Record<string, string>

export type ProblemCode =
  /** A `.json` file isn't JSON. */
  | 'invalid_json'
  /** The definition (or the name and description beside it) doesn't match the schema. */
  | 'invalid_definition'
  /** The JSON names something whose code or SQL file isn't there. */
  | 'missing_file'
  /** A file nothing in the JSON accounts for. */
  | 'unexpected_file'
  /** A value is both in the JSON and in its own file. */
  | 'duplicate_value'
  /** A directory under `workflows/` or `apps/` that isn't a valid slug. */
  | 'invalid_slug'
  /** `ow.json` is missing, or names a format this version doesn't read. */
  | 'unsupported_format'

/** Something wrong with the files, at a path (relative to the repo root once `decodeRepo` has seen it). */
export interface Problem {
  path: string
  code: ProblemCode
  message: string
}

/** Something fine for the instance but awkward for people, such as two files differing only in case. */
export interface Warning {
  path: string
  message: string
}

export type Decoded<T> = { ok: true; value: T } | { ok: false; problems: Problem[] }

export function sortFiles(files: Files): Files {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Code and SQL files end with a newline, as text files in Git do. Writing adds one and reading takes exactly one
 * away, so a value keeps its own trailing newlines (and a file edited without one reads as it is).
 */
export function textFile(value: string): string {
  return `${value}\n`
}

export function readTextFile(content: string): string {
  return content.endsWith('\n') ? content.slice(0, -1) : content
}

/** Paths that would land on one file on a case-insensitive file system (macOS, Windows checkouts). */
export function caseCollisions(files: Files): Warning[] {
  const seen = new Map<string, string>()
  const warnings: Warning[] = []
  for (const path of Object.keys(files)) {
    const lower = path.toLowerCase()
    const other = seen.get(lower)
    if (other !== undefined) {
      warnings.push({
        path,
        message: `${path} and ${other} differ only in case: a checkout on macOS or Windows keeps one of them`,
      })
    } else {
      seen.set(lower, path)
    }
  }
  return warnings
}

export function parseJsonFile(
  path: string,
  content: string,
): { ok: true; value: unknown } | { ok: false; problem: Problem } {
  try {
    return { ok: true, value: JSON.parse(content) }
  } catch (err) {
    return {
      ok: false,
      problem: { path, code: 'invalid_json', message: `${path} isn't valid JSON: ${(err as Error).message}` },
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A zod issue path as people read it: `blocks[2].config.code`. */
export function issuePath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`
    else out += out ? `.${String(key)}` : String(key)
  }
  return out
}
