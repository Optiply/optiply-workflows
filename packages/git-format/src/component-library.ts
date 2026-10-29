import { type ComponentLibraryDefinition, componentLibraryDefinitionSchema } from '@ow/app-definition'
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
  type Warning,
} from './files'
import { metaFields, type ObjectMeta, splitMeta } from './meta'

export const COMPONENT_LIBRARY_FILE = 'library.json'
export const COMPONENT_PACKAGE_FILE = 'package.json'
export const COMPONENT_LOCK_FILE = 'package-lock.json'

export interface ComponentLibraryObject extends ObjectMeta {
  definition: ComponentLibraryDefinition
  /** The `package-lock.json` of the release (M25), so a deploy builds the same packages; absent when unknown. */
  lock?: string
}

/**
 * A component library (M25) as the files of its directory: `library.json` (the name, description, components and
 * allowed origins), `package.json` (the npm dependencies, so npm and editors understand the directory),
 * `package-lock.json` (the release's lock, when there is one) and each source file at its own path, as written.
 */
export function encodeComponentLibrary(object: ComponentLibraryObject): {
  files: Files
  warnings: Warning[]
} {
  const { files: sources, dependencies, ...def } = object.definition
  const files: Files = {}
  for (const f of sources) files[f.path] = f.content
  files[COMPONENT_LIBRARY_FILE] = canonicalJson({ ...metaFields(object), ...def }, { pretty: true })
  files[COMPONENT_PACKAGE_FILE] = canonicalJson({ private: true, dependencies }, { pretty: true })
  if (object.lock !== undefined) files[COMPONENT_LOCK_FILE] = object.lock
  const sorted = sortFiles(files)
  return { files: sorted, warnings: caseCollisions(sorted) }
}

/** The component library back from its directory's files. Problems name the file they're about. */
export function decodeComponentLibrary(files: Files): Decoded<ComponentLibraryObject> {
  const problems: Problem[] = []
  const source = files[COMPONENT_LIBRARY_FILE]
  if (source === undefined) {
    return {
      ok: false,
      problems: [
        {
          path: COMPONENT_LIBRARY_FILE,
          code: 'missing_file',
          message: `${COMPONENT_LIBRARY_FILE} is missing`,
        },
      ],
    }
  }
  const parsed = parseJsonFile(COMPONENT_LIBRARY_FILE, source)
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] }
  if (!isRecord(parsed.value)) {
    return { ok: false, problems: [invalid(COMPONENT_LIBRARY_FILE, 'Expected an object')] }
  }
  const { meta, rest: raw, problems: metaProblems } = splitMeta(COMPONENT_LIBRARY_FILE, parsed.value)
  problems.push(...metaProblems)
  if ('files' in raw || 'dependencies' in raw) {
    problems.push(
      invalid(
        COMPONENT_LIBRARY_FILE,
        'files and dependencies live in their own files (the sources, package.json)',
      ),
    )
  }

  let dependencies: unknown = {}
  const pkg = files[COMPONENT_PACKAGE_FILE]
  if (pkg !== undefined) {
    const p = parseJsonFile(COMPONENT_PACKAGE_FILE, pkg)
    if (!p.ok) problems.push(p.problem)
    else if (!isRecord(p.value)) problems.push(invalid(COMPONENT_PACKAGE_FILE, 'Expected an object'))
    else {
      const { private: _, dependencies: deps = {}, ...other } = p.value
      const extra = Object.keys(other)
      if (extra.length > 0) {
        problems.push(
          invalid(
            COMPONENT_PACKAGE_FILE,
            `only "dependencies" is read; remove ${extra.map((k) => `"${k}"`).join(', ')}`,
          ),
        )
      }
      dependencies = deps
    }
  }

  const sources = Object.entries(files)
    .filter(([path]) => ![COMPONENT_LIBRARY_FILE, COMPONENT_PACKAGE_FILE, COMPONENT_LOCK_FILE].includes(path))
    .map(([path, content]) => ({ path, content }))
  const result = componentLibraryDefinitionSchema.safeParse({ ...raw, files: sources, dependencies })
  if (!result.success) {
    problems.push(
      ...result.error.issues.map((issue) =>
        invalid(COMPONENT_LIBRARY_FILE, `${issuePath(issue.path)}: ${issue.message}`),
      ),
    )
  }
  if (problems.length > 0 || !meta || !result.success) return { ok: false, problems }
  const lock = files[COMPONENT_LOCK_FILE]
  return { ok: true, value: { ...meta, definition: result.data, ...(lock !== undefined && { lock }) } }
}

function invalid(path: string, message: string): Problem {
  return { path, code: 'invalid_definition', message: `${path}: ${message}` }
}
