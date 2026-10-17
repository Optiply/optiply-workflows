import { type AppDefinition, type AppQuery, appDefinitionSchema, canonicalizeApp } from '@ow/app-definition'
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
import { FileSlots, namedRecords } from './slots'

export const APP_FILE = 'app.json'
export const APP_LAYOUT_FILE = 'layout.json'

export interface AppObject extends ObjectMeta {
  definition: AppDefinition
}

/**
 * An app as the files of its directory:
 * - `app.json`: the name, the description and the canonical definition without its layout, and without the strings
 *   that have files of their own;
 * - `queries/<name>.sql`: a resource query's `sql`; `queries/<name>.js`: a JS query's code;
 *   `queries/<name>.transform.js`: a query's transform;
 * - `transformers/<name>.js`: a transformer's code;
 * - `layout.json`: the grid positions by component name, when the app has a layout.
 *
 * Props, handlers (scripts included) and REST queries stay in the JSON. Unlike a workflow's, the layout is kept
 * exactly (even when empty): it counts in the app's hash.
 */
export function encodeApp(app: AppObject): { files: Files; warnings: Warning[] } {
  const { layout, ...def } = canonicalizeApp(app.definition)
  const files: Files = {}
  const queries = def.queries.map((query) => moveQueryOut(query, files))
  const transformers = def.transformers?.map(({ code, ...transformer }) => {
    files[`transformers/${transformer.name}.js`] = textFile(code)
    return transformer
  })
  files[APP_FILE] = canonicalJson(
    { ...metaFields(app), ...def, queries, ...(transformers ? { transformers } : {}) },
    { pretty: true },
  )
  if (layout) files[APP_LAYOUT_FILE] = canonicalJson(layout, { pretty: true })
  const sorted = sortFiles(files)
  return { files: sorted, warnings: caseCollisions(sorted) }
}

/** The app back from its directory's files, canonical. Problems name the file they're about. */
export function decodeApp(files: Files): Decoded<AppObject> {
  const source = files[APP_FILE]
  if (source === undefined) {
    return {
      ok: false,
      problems: [{ path: APP_FILE, code: 'missing_file', message: `${APP_FILE} is missing` }],
    }
  }
  const parsed = parseJsonFile(APP_FILE, source)
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] }
  if (!isRecord(parsed.value)) return { ok: false, problems: [invalid(APP_FILE, 'Expected an object')] }
  const { meta, rest: raw, problems } = splitMeta(APP_FILE, parsed.value)

  const slots = new FileSlots(files, [APP_FILE, APP_LAYOUT_FILE])
  for (const query of namedRecords(raw.queries)) {
    const what = `query ${query.name}`
    if (query.kind === 'js') {
      slots.take(`queries/${query.name}.js`, query, 'code', { required: true, what })
    } else if (query.kind === 'resource') {
      slots.take(`queries/${query.name}.sql`, query.query, 'sql', { required: false, what })
    }
    slots.take(`queries/${query.name}.transform.js`, query, 'transform', { required: false, what })
  }
  for (const transformer of namedRecords(raw.transformers)) {
    slots.take(`transformers/${transformer.name}.js`, transformer, 'code', {
      required: true,
      what: `transformer ${transformer.name}`,
    })
  }
  problems.push(...slots.problems, ...slots.leftovers())

  if (files[APP_LAYOUT_FILE] !== undefined) {
    const layout = parseJsonFile(APP_LAYOUT_FILE, files[APP_LAYOUT_FILE])
    if (layout.ok) raw.layout = layout.value
    else problems.push(layout.problem)
  }

  const result = appDefinitionSchema.safeParse(raw)
  if (!result.success) {
    problems.push(
      ...result.error.issues.map((issue) =>
        invalid(
          issue.path[0] === 'layout' ? APP_LAYOUT_FILE : APP_FILE,
          `${issuePath(issue.path)}: ${issue.message}`,
        ),
      ),
    )
  }
  if (problems.length > 0 || !meta || !result.success) return { ok: false, problems }
  return { ok: true, value: { ...meta, definition: canonicalizeApp(result.data) } }
}

function moveQueryOut(query: AppQuery, files: Files): AppQuery {
  let out: AppQuery = query
  if (out.kind === 'js') {
    files[`queries/${out.name}.js`] = textFile(out.code)
    const { code: _code, ...rest } = out
    out = rest as AppQuery
  } else {
    const { sql, ...rest } = out.query
    if (typeof sql === 'string') {
      files[`queries/${out.name}.sql`] = textFile(sql)
      out = { ...out, query: rest }
    }
  }
  if (out.transform !== undefined) {
    files[`queries/${out.name}.transform.js`] = textFile(out.transform)
    const { transform: _transform, ...rest } = out
    out = rest as AppQuery
  }
  return out
}

function invalid(path: string, message: string): Problem {
  return { path, code: 'invalid_definition', message: `${path}: ${message}` }
}
