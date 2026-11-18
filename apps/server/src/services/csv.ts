/**
 * CSV for the managed database: a streaming RFC 4180 parser, delimiter detection, and guessing column names and
 * types from a sample. Our own, small, so imports stream without loading the file and the rules are ours to test.
 */

export const DELIMITERS = [',', ';', '\t'] as const
export type Delimiter = (typeof DELIMITERS)[number]

/**
 * Limits that keep a malformed file from eating memory: one field, and fields per record. A field holds up to 16
 * million characters: real exports carry big JSON documents (a workflow definition of 1.1 million characters,
 * 2026-11-03), and an import's whole file is capped at 50 MB anyway (`IMPORT_MAX_BYTES`).
 */
export const MAX_FIELD_CHARS = 16_000_000
export const MAX_FIELDS = 1000

export class CsvError extends Error {
  override name = 'CsvError'
  constructor(
    /** What's wrong, without the line (`message` starts with it). */
    readonly reason: string,
    /** The 1-based line of the file the problem is on (a quoted field can span lines: where it started). */
    readonly line?: number,
  ) {
    super(line ? `Line ${line}: ${reason}` : reason)
  }
}

export interface CsvRecord {
  fields: string[]
  /** The 1-based line it starts on. */
  line: number
}

/**
 * Parses CSV text pushed in chunks of any size (a quoted field or a CRLF may be split between chunks). Quotes
 * escape themselves (`""`); fields may hold delimiters and line breaks when quoted; LF, CRLF and CR all end records;
 * a byte-order mark at the start is dropped. Blank lines are skipped. Leniently, like spreadsheets: a quote inside
 * an unquoted field (`12" pipe`) is a character, and text after a closing quote joins the field.
 */
export class CsvParser {
  private field = ''
  private fields: string[] = []
  private quoted = false
  /** Inside quotes, a quote was just seen: the next character says whether it was `""` or the closing quote. */
  private quoteSeen = false
  /** The record so far had any content (so a blank line isn't a record with one empty field). */
  private dirty = false
  /** A CR ended the last record; an LF right after it belongs to it. */
  private afterCr = false
  /** Inside quotes, the last character was a CR. */
  private quotedCr = false
  private started = false
  private line = 1
  private recordLine = 1

  constructor(readonly delimiter: Delimiter = ',') {}

  push(text: string): CsvRecord[] {
    const out: CsvRecord[] = []
    let i = 0
    if (!this.started && text.length) {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) i = 1
    }
    // Characters go into the field as stretches of `text` (one slice each), never one by one: a string grown a
    // character at a time is kept as a chain of about 32 bytes a character, and a 26 MB file took 800 MB that way.
    let run = -1
    const take = (at: number) => {
      if (run < 0) {
        run = at
        this.dirty = true
      }
      if (this.field.length + at + 1 - run > MAX_FIELD_CHARS) {
        throw new CsvError(
          `a field is longer than ${MAX_FIELD_CHARS.toLocaleString('en')} characters`,
          this.recordLine,
        )
      }
    }
    const flush = (end: number) => {
      if (run < 0) return
      this.field += text.slice(run, end)
      run = -1
    }
    for (; i < text.length; i++) {
      const ch = text[i]!
      if (this.afterCr) {
        this.afterCr = false
        if (ch === '\n') continue
      }
      if (this.quoted) {
        if (this.quoteSeen) {
          this.quoteSeen = false
          if (ch === '"') {
            // `""`: the first quote was left out of the stretch, this one starts the next.
            take(i)
            continue
          }
          this.quoted = false
          // Falls through: the character after a closing quote is read as outside quotes.
        } else {
          if (ch === '"') {
            flush(i)
            this.quoteSeen = true
          } else {
            // A CRLF is one line break, even split between chunks.
            if (ch === '\r' || (ch === '\n' && !this.quotedCr)) this.line++
            this.quotedCr = ch === '\r'
            take(i)
          }
          continue
        }
      }
      if (ch === '"' && !this.field.length && run < 0) {
        this.quoted = true
        this.quotedCr = false
        this.dirty = true
      } else if (ch === this.delimiter) {
        flush(i)
        this.endField()
      } else if (ch === '\n' || ch === '\r') {
        flush(i)
        const record = this.endRecord()
        if (record) out.push(record)
        this.line++
        this.recordLine = this.line
        if (ch === '\r') this.afterCr = true
      } else {
        take(i)
      }
    }
    flush(text.length)
    return out
  }

  /** The last record, if the text didn't end with a line break. */
  end(): CsvRecord[] {
    if (this.quoted && !this.quoteSeen) throw new CsvError('a quoted field is never closed', this.recordLine)
    this.quoted = false
    this.quoteSeen = false
    const record = this.endRecord()
    return record ? [record] : []
  }

  private endField() {
    this.dirty = true
    this.fields.push(this.field)
    this.field = ''
    if (this.fields.length > MAX_FIELDS) throw new CsvError(`more than ${MAX_FIELDS} fields`, this.recordLine)
  }

  private endRecord(): CsvRecord | null {
    if (!this.dirty) {
      this.recordLine = this.line + 1
      return null
    }
    this.fields.push(this.field)
    const record = { fields: this.fields, line: this.recordLine }
    this.fields = []
    this.field = ''
    this.dirty = false
    return record
  }
}

export function parseCsv(text: string, delimiter: Delimiter = ','): CsvRecord[] {
  const parser = new CsvParser(delimiter)
  return [...parser.push(text), ...parser.end()]
}

/** The delimiter used most on the first line, outside quotes; a comma when there's no telling. */
export function detectDelimiter(sample: string): Delimiter {
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]))
  let quoted = false
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && counts.has(ch as Delimiter))
      counts.set(ch as Delimiter, counts.get(ch as Delimiter)! + 1)
  }
  let best: Delimiter = ','
  for (const [d, n] of counts) if (n > counts.get(best)!) best = d
  return best
}

// ── Guessing names and types ────────────────────────────────────────────────

/** Header names as column names: lowercase snake_case, unique, never empty, never starting with pg_. */
export function columnNames(header: string[]): string[] {
  const used = new Set<string>()
  return header.map((raw, i) => {
    let name = raw
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!name) name = `column_${i + 1}`
    if (/^\d/.test(name)) name = `_${name}`
    if (name.startsWith('pg_')) name = `col_${name}`
    name = name.slice(0, 59)
    let unique = name
    for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`
    used.add(unique)
    return unique
  })
}

export type DateOrder = 'DMY' | 'MDY' | 'YMD'
export type GuessedType =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
  | 'uuid'

const INT = /^[+-]?\d+$/
const DECIMAL_DOT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
// 1.234,56 or 1234,56: a decimal comma, dots grouping thousands.
const DECIMAL_COMMA = /^[+-]?\d{1,3}(\.\d{3})*(,\d+)?$|^[+-]?\d+(,\d+)?$/
const BOOLEAN = /^(true|false|yes|no|y|n|t|f)$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INT32_MAX = 2_147_483_647n
const INT64_MAX = 9_223_372_036_854_775_807n
/** 0123, -007, 007.5: a number with digits after a leading zero (0, 0.5 and 0,5 are fine; dates aren't numbers). */
const LEADING_ZERO = /^[+-]?0\d+([.,]\d+)?$/

export interface CsvGuess {
  delimiter: Delimiter
  /** Day-month-year unless the sample shows otherwise (a first part over 12 means DMY; a second, MDY). */
  dateOrder: DateOrder
  /** Numbers written 1.234,56. */
  decimalComma: boolean
  header: string[]
  names: string[]
  types: GuessedType[]
  /** The first rows after the header, for the preview. */
  rows: string[][]
}

/**
 * Reads a sample (the start of a file, possibly cut mid-record: the cut record is dropped) and guesses the
 * delimiter, column names and types. A column whose every non-empty value fits a type gets it; mixed or unknown
 * means text. Empty columns are text.
 */
export function guessCsv(
  sample: string,
  opts: {
    complete?: boolean
    previewRows?: number
    delimiter?: Delimiter
    /** false: the first record is data, and the columns are column_1, column_2, … */
    header?: boolean
  } = {},
): CsvGuess {
  const delimiter = opts.delimiter ?? detectDelimiter(sample)
  const parser = new CsvParser(delimiter)
  const records = parser.push(sample)
  if (opts.complete) records.push(...parser.end())
  if (!records.length) throw new CsvError('The file has no rows')
  const withHeader = opts.header !== false
  const header = withHeader ? records[0]!.fields : records[0]!.fields.map((_, i) => `column_${i + 1}`)
  const body = records.slice(withHeader ? 1 : 0).map((r) => r.fields)
  const columns = header.map((_, i) => body.map((r) => (r[i] ?? '').trim()).filter((v) => v !== ''))
  const all = columns.flat()

  // Dates like 03/04/2026: whichever part goes past 12 tells the order.
  let dateOrder: DateOrder = 'DMY'
  for (const v of all) {
    const m = SLASH_DATE.exec(v)
    if (!m) continue
    if (Number(m[2]) > 12) {
      dateOrder = 'MDY'
      break
    }
    if (Number(m[1]) > 12) break
  }
  // A decimal comma only when some value needs it (1,5) and none needs a dot (1.5 with no comma after).
  const commaNumbers = all.filter((v) => /^[+-]?\d+,\d+$/.test(v) || /^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(v))
  const dotNumbers = all.filter((v) => /^[+-]?\d+\.\d+$/.test(v) && !/^\d{1,3}\.\d{3}$/.test(v))
  const decimalComma = delimiter !== ',' && commaNumbers.length > 0 && dotNumbers.length === 0

  const types = columns.map((values): GuessedType => {
    if (!values.length) return 'text'
    // Codes, not numbers: a leading zero (EANs, postcodes like 0123) would be lost, and identifiers past
    // bigint's range wouldn't fit. Text keeps them as written.
    if (values.some((v) => LEADING_ZERO.test(v))) return 'text'
    if (values.every((v) => INT.test(v))) {
      if (values.some((v) => BigInt(v) > INT64_MAX || BigInt(v) < -INT64_MAX - 1n)) return 'text'
      return values.every((v) => BigInt(v) <= INT32_MAX && BigInt(v) >= -INT32_MAX - 1n)
        ? 'integer'
        : 'bigint'
    }
    if (values.every((v) => (decimalComma ? DECIMAL_COMMA : DECIMAL_DOT).test(v))) return 'decimal'
    if (values.every((v) => BOOLEAN.test(v))) return 'boolean'
    if (values.every((v) => ISO_DATE.test(v) || SLASH_DATE.test(v))) return 'date'
    if (values.every((v) => DATETIME.test(v))) return 'datetime'
    if (values.every((v) => UUID.test(v))) return 'uuid'
    if (values.every((v) => /^[[{]/.test(v) && isJson(v))) return 'json'
    return 'text'
  })

  return {
    delimiter,
    dateOrder,
    decimalComma,
    header,
    names: columnNames(header),
    types,
    rows: body.slice(0, opts.previewRows ?? 20),
  }
}

function isJson(v: string): boolean {
  try {
    JSON.parse(v)
    return true
  } catch {
    return false
  }
}

/** A number written with a decimal comma (1.234,56) in the form Postgres reads (1234.56). */
export function fromDecimalComma(value: string): string {
  return value.replace(/\s/g, '').replaceAll('.', '').replace(',', '.')
}
