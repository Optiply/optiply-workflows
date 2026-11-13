import { type LibraryQueryDefinition, libraryQueryDefinitionSchema } from '@ow/app-definition'
import { canonicalJson } from '@ow/definition'
import {
  caseCollisions,
  type Decoded,
  type Files,
  isRecord,
  issuePath,
  type Problem,
  parseJsonFile,
  sortFiles,
  textFile,
  type Warning,
} from './files'
import { metaFields, type ObjectMeta, splitMeta } from './meta'
import { moveQueryText, takeQueryText } from './query-text'
import { FileSlots } from './slots'

export const LIBRARY_QUERY_FILE = 'query.json'
export const LIBRARY_QUERY_SQL_FILE = 'query.sql'

export interface LibraryQueryObject extends ObjectMeta {
  definition: LibraryQueryDefinition
}

/**
 * A library query (M14) as the files of its directory: `query.json` (the name, the description and the canonical
 * definition) and `query.sql` (the query's `sql`, when it has one; `query.graphql` and `query.html` likewise, M27).
 */
export function encodeLibraryQuery(object: LibraryQueryObject): { files: Files; warnings: Warning[] } {
  const { query, ...def } = object.definition
  const files: Files = {}
  files[LIBRARY_QUERY_FILE] = canonicalJson(
    { ...metaFields(object), ...def, query: moveQueryText(query, 'query', files) },
    { pretty: true },
  )
  const sorted = sortFiles(files)
  return { files: sorted, warnings: caseCollisions(sorted) }
}

/** The library query back from its directory's files. Problems name the file they're about. */
export function decodeLibraryQuery(files: Files): Decoded<LibraryQueryObject> {
  const source = files[LIBRARY_QUERY_FILE]
  if (source === undefined) {
    return {
      ok: false,
      problems: [
        { path: LIBRARY_QUERY_FILE, code: 'missing_file', message: `${LIBRARY_QUERY_FILE} is missing` },
      ],
    }
  }
  const parsed = parseJsonFile(LIBRARY_QUERY_FILE, source)
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] }
  if (!isRecord(parsed.value)) {
    return { ok: false, problems: [invalid('Expected an object')] }
  }
  const { meta, rest: raw, problems } = splitMeta(LIBRARY_QUERY_FILE, parsed.value)
  const slots = new FileSlots(files, [LIBRARY_QUERY_FILE])
  if (isRecord(raw.query)) {
    takeQueryText(slots, 'query', raw.query, 'the query')
  }
  problems.push(...slots.problems, ...slots.leftovers())
  const result = libraryQueryDefinitionSchema.safeParse(raw)
  if (!result.success) {
    problems.push(
      ...result.error.issues.map((issue) => invalid(`${issuePath(issue.path)}: ${issue.message}`)),
    )
  }
  if (problems.length > 0 || !meta || !result.success) return { ok: false, problems }
  return { ok: true, value: { ...meta, definition: result.data } }
}

function invalid(message: string): Problem {
  return {
    path: LIBRARY_QUERY_FILE,
    code: 'invalid_definition',
    message: `${LIBRARY_QUERY_FILE}: ${message}`,
  }
}
