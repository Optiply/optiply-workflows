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
import { PACKAGE_FILE, packageJsonFile, readPackageJson } from './js-packages'
import { metaFields, type ObjectMeta, splitMeta } from './meta'
import { moveQueryText, takeQueryText } from './query-text'
import { FileSlots, namedRecords } from './slots'

export const APP_FILE = 'app.json'
export const APP_LAYOUT_FILE = 'layout.json'
/** A module's (M14) main file; the rest of its directory is laid out like an app's. */
export const MODULE_FILE = 'module.json'

export interface AppObject extends ObjectMeta {
  definition: AppDefinition
}

/** A module (M14): an app definition with its `module` part. */
export type ModuleObject = AppObject

/**
 * An app as the files of its directory:
 * - `app.json`: the name, the description and the canonical definition without its layout, and without the strings
 *   that have files of their own;
 * - `queries/<name>.sql`: a resource query's `sql`; `queries/<name>.js`: a JS query's code;
 *   `queries/<name>.transform.js`: a query's transform;
 * - `transformers/<name>.js`: a transformer's code;
 * - `layout.json`: the grid positions by component name, when the app has a layout;
 * - `package.json`: the JavaScript packages (`javascript.packages`) as npm's `dependencies`, when it has them.
 *
 * Props, handlers (scripts included) and REST queries stay in the JSON. Unlike a workflow's, the layout is kept
 * exactly (even when empty): it counts in the app's hash.
 */
export function encodeApp(app: AppObject): { files: Files; warnings: Warning[] } {
  return encodeAppFiles(APP_FILE, app)
}

/** A module as the files of its directory: like an app's, with `module.json` instead of `app.json`. */
export function encodeModule(module: ModuleObject): { files: Files; warnings: Warning[] } {
  return encodeAppFiles(MODULE_FILE, module)
}

/** The module back from its directory's files; its definition must have its inputs, outputs and events. */
export function decodeModule(files: Files): Decoded<ModuleObject> {
  const decoded = decodeAppFiles(MODULE_FILE, files)
  if (decoded.ok && !decoded.value.definition.module) {
    return {
      ok: false,
      problems: [invalid(MODULE_FILE, 'module: a module needs its inputs, outputs and events')],
    }
  }
  return decoded
}

function encodeAppFiles(main: string, app: AppObject): { files: Files; warnings: Warning[] } {
  const { layout, javascript, ...def } = canonicalizeApp(app.definition)
  const files: Files = {}
  const warnings: Warning[] = []
  if (javascript) {
    const pkg = packageJsonFile(javascript.packages)
    files[PACKAGE_FILE] = pkg.content
    warnings.push(...pkg.warnings)
  }
  const queries = def.queries.map((query) => moveQueryOut(query, files))
  const transformers = def.transformers?.map(({ code, ...transformer }) => {
    files[`transformers/${transformer.name}.js`] = textFile(code)
    return transformer
  })
  files[main] = canonicalJson(
    { ...metaFields(app), ...def, queries, ...(transformers ? { transformers } : {}) },
    { pretty: true },
  )
  if (layout) files[APP_LAYOUT_FILE] = canonicalJson(layout, { pretty: true })
  const sorted = sortFiles(files)
  return { files: sorted, warnings: [...warnings, ...caseCollisions(sorted)] }
}

/** The app back from its directory's files, canonical. Problems name the file they're about. */
export function decodeApp(files: Files): Decoded<AppObject> {
  return decodeAppFiles(APP_FILE, files)
}

function decodeAppFiles(main: string, files: Files): Decoded<AppObject> {
  const source = files[main]
  if (source === undefined) {
    return {
      ok: false,
      problems: [{ path: main, code: 'missing_file', message: `${main} is missing` }],
    }
  }
  const parsed = parseJsonFile(main, source)
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] }
  if (!isRecord(parsed.value)) return { ok: false, problems: [invalid(main, 'Expected an object')] }
  const { meta, rest: raw, problems } = splitMeta(main, parsed.value)

  const slots = new FileSlots(files, [main, APP_LAYOUT_FILE, PACKAGE_FILE])
  for (const query of namedRecords(raw.queries)) {
    const what = `query ${query.name}`
    if (query.kind === 'js') {
      slots.take(`queries/${query.name}.js`, query, 'code', { required: true, what })
    } else if (query.kind === 'resource') {
      takeQueryText(slots, `queries/${query.name}`, query.query, what)
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

  if (files[PACKAGE_FILE] !== undefined) {
    if (isRecord(raw.javascript))
      problems.push(invalid(main, `javascript: the packages belong in ${PACKAGE_FILE}`))
    const read = readPackageJson(files[PACKAGE_FILE])
    if ('problems' in read) problems.push(...read.problems)
    else raw.javascript = { packages: read.packages }
  }

  const result = appDefinitionSchema.safeParse(raw)
  if (!result.success) {
    problems.push(
      ...result.error.issues.map((issue) =>
        invalid(
          issue.path[0] === 'layout' ? APP_LAYOUT_FILE : main,
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
  } else if (out.kind === 'resource') {
    out = { ...out, query: moveQueryText(out.query, `queries/${out.name}`, files) }
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
