import { type Files, isRecord, type Problem, readTextFile } from './files'

/**
 * Reads an object's files back into its JSON: each code or SQL file goes into the field it was moved out of. What
 * no field takes is left over, and reported as unexpected.
 */
export class FileSlots {
  readonly problems: Problem[] = []
  private readonly taken = new Set<string>()

  constructor(
    private readonly files: Files,
    /** The JSON files the decoder reads itself. */
    private readonly own: readonly string[],
  ) {}

  /**
   * Puts the file at `path` into `target[key]`. A value already in the JSON is kept when there's no file (so a
   * hand-written inline value still reads), and is a problem when there is one too. `what` names the field's owner
   * for messages: `code block transform`.
   */
  take(path: string, target: unknown, key: string, opts: { required: boolean; what: string }): void {
    const content = this.files[path]
    if (content !== undefined) this.taken.add(path)
    // A malformed owner is the schema's to report; the file still counts as accounted for.
    if (!isRecord(target)) return
    if (content !== undefined) {
      if (key in target) {
        this.problems.push({
          path,
          code: 'duplicate_value',
          message: `The ${opts.what} has its ${key} both in the JSON and in ${path}: keep one`,
        })
        return
      }
      target[key] = readTextFile(content)
    } else if (opts.required && !(key in target)) {
      this.problems.push({
        path,
        code: 'missing_file',
        message: `${path} is missing: the ${opts.what} keeps its ${key} there`,
      })
      // A stand-in, so the schema doesn't report the same thing again; the problem fails the decode anyway.
      target[key] = ''
    }
  }

  /** Files nothing took. */
  leftovers(): Problem[] {
    return Object.keys(this.files)
      .filter((path) => !this.taken.has(path) && !this.own.includes(path))
      .sort()
      .map((path) => ({
        path,
        code: 'unexpected_file' as const,
        message: `${path} doesn't belong to anything in the definition`,
      }))
  }
}

/** The named records of a raw JSON array (whatever else is there is the schema's to report). */
export function namedRecords(value: unknown): Array<Record<string, unknown> & { name: string }> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Record<string, unknown> & { name: string } =>
      isRecord(item) && typeof item.name === 'string',
  )
}
