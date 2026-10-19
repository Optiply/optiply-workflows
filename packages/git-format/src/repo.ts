import { canonicalJson, workflowSlugSchema } from '@ow/definition'
import { type AppObject, decodeApp, decodeModule, encodeApp, encodeModule, type ModuleObject } from './app'
import {
  caseCollisions,
  type Decoded,
  type Files,
  isRecord,
  type Problem,
  parseJsonFile,
  type Warning,
} from './files'
import { decodeLibraryQuery, encodeLibraryQuery, type LibraryQueryObject } from './library'
import { decodeWorkflow, encodeWorkflow, type WorkflowObject } from './workflow'

/** The repo's root file, naming the format its directories are in. */
export const MANIFEST_FILE = 'ow.json'
export const FORMAT_VERSION = 1

export type ObjectKind = 'workflow' | 'app' | 'library_query' | 'module'

/** Where each kind lives: `workflows/<slug>/`, `apps/<slug>/`, `library/<slug>/`, `modules/<slug>/`. */
export const KIND_ROOTS: Record<ObjectKind, string> = {
  workflow: 'workflows',
  app: 'apps',
  library_query: 'library',
  module: 'modules',
}

/** Each kind as people read it, for messages. */
export const KIND_LABELS: Record<ObjectKind, string> = {
  workflow: 'workflow',
  app: 'app',
  library_query: 'library query',
  module: 'module',
}

/** Every kind's slugs follow the same rule (workflows' and apps' appear in URLs). */
export const objectSlugSchema = workflowSlugSchema

export function manifestFile(): string {
  return canonicalJson({ format: FORMAT_VERSION }, { pretty: true })
}

/** The directory of an object, without a trailing slash. */
export function objectDir(kind: ObjectKind, slug: string): string {
  return `${KIND_ROOTS[kind]}/${slug}`
}

/** What each kind's directory holds. */
export interface KindValues {
  workflow: WorkflowObject
  app: AppObject
  library_query: LibraryQueryObject
  module: ModuleObject
}

export type RepoObject = {
  [K in ObjectKind]: { kind: K; slug: string; value: KindValues[K] }
}[ObjectKind]

/** How each kind's directory is written and read. */
const CODECS: {
  [K in ObjectKind]: {
    encode(value: KindValues[K]): { files: Files; warnings: Warning[] }
    decode(files: Files): Decoded<KindValues[K]>
  }
} = {
  workflow: { encode: encodeWorkflow, decode: decodeWorkflow },
  app: { encode: encodeApp, decode: decodeApp },
  library_query: { encode: encodeLibraryQuery, decode: decodeLibraryQuery },
  module: { encode: encodeModule, decode: decodeModule },
}

/** An object's directory and its files, keyed by their path inside it (what a commit replaces the directory with). */
export function encodeObjectDir(object: RepoObject): { dir: string; files: Files; warnings: Warning[] } {
  const codec = CODECS[object.kind] as {
    encode(value: RepoObject['value']): { files: Files; warnings: Warning[] }
  }
  return { dir: objectDir(object.kind, object.slug), ...codec.encode(object.value) }
}

/** An object's files, keyed by their path from the repo root. */
export function encodeObject(object: RepoObject): { files: Files; warnings: Warning[] } {
  const { dir, files: inside } = encodeObjectDir(object)
  const files = Object.fromEntries(
    Object.entries(inside).map(([path, content]) => [`${dir}/${path}`, content]),
  )
  return { files, warnings: caseCollisions(files) }
}

/** The files under an object's directory, keyed by their path inside it. */
export interface ObjectFiles {
  kind: ObjectKind
  slug: string
  files: Files
}

/**
 * Groups a repo's files into objects. Files outside the kinds' roots (a README, CI) are ignored; a file right under
 * a root (`workflows/`, `apps/`, `library/`, `modules/`), or a directory that isn't a slug, is a problem.
 */
export function splitRepo(files: Files): { objects: ObjectFiles[]; problems: Problem[] } {
  const problems: Problem[] = []
  const byDir = new Map<string, ObjectFiles>()
  for (const [path, content] of Object.entries(files)) {
    const kind = (Object.keys(KIND_ROOTS) as ObjectKind[]).find((k) => path.startsWith(`${KIND_ROOTS[k]}/`))
    if (!kind) continue
    const [, slug, ...rest] = path.split('/')
    if (rest.length === 0) {
      problems.push({
        path,
        code: 'unexpected_file',
        message: `${path} isn't in a ${KIND_LABELS[kind]}'s directory (${KIND_ROOTS[kind]}/<slug>/)`,
      })
      continue
    }
    const dir = `${KIND_ROOTS[kind]}/${slug}`
    if (!objectSlugSchema.safeParse(slug).success) {
      if (!problems.some((p) => p.path === dir)) {
        problems.push({
          path: dir,
          code: 'invalid_slug',
          message: `${dir}: "${slug}" isn't a valid ${KIND_LABELS[kind]} slug (2–63 lowercase letters, digits, - or _, starting with a letter)`,
        })
      }
      continue
    }
    let object = byDir.get(dir)
    if (!object) {
      object = { kind, slug: slug!, files: {} }
      byDir.set(dir, object)
    }
    object.files[rest.join('/')] = content
  }
  const objects = [...byDir.values()].sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  )
  return { objects, problems }
}

/** Checks `ow.json`: present, and in a format this version reads. */
export function checkManifest(files: Files): Problem[] {
  const content = files[MANIFEST_FILE]
  if (content === undefined) {
    return [
      {
        path: MANIFEST_FILE,
        code: 'unsupported_format',
        message: `${MANIFEST_FILE} is missing: it marks the repo as holding workflows, apps, library queries and modules`,
      },
    ]
  }
  const parsed = parseJsonFile(MANIFEST_FILE, content)
  if (!parsed.ok) return [parsed.problem]
  const format = isRecord(parsed.value) ? parsed.value.format : undefined
  if (format !== FORMAT_VERSION) {
    return [
      {
        path: MANIFEST_FILE,
        code: 'unsupported_format',
        message: `${MANIFEST_FILE} names format ${JSON.stringify(format)}; this version reads format ${FORMAT_VERSION}`,
      },
    ]
  }
  return []
}

/** One object's files decoded; problems carry paths from the repo root. */
export function decodeObject(object: ObjectFiles): Decoded<RepoObject> {
  const dir = `${objectDir(object.kind, object.slug)}/`
  const decoded = CODECS[object.kind].decode(object.files)
  if (!decoded.ok) {
    return {
      ok: false,
      problems: decoded.problems.map((p) => ({
        ...p,
        path: dir + p.path,
        message: p.message.replaceAll(p.path, dir + p.path),
      })),
    }
  }
  return { ok: true, value: { kind: object.kind, slug: object.slug, value: decoded.value } as RepoObject }
}

export interface DecodedRepo {
  /** Problems with the repo as a whole (`ow.json`, stray files and directories). */
  problems: Problem[]
  objects: Array<{ kind: ObjectKind; slug: string; result: Decoded<RepoObject> }>
}

/** A whole repo's files: each object decoded on its own, so one broken object doesn't hide the rest. */
export function decodeRepo(files: Files): DecodedRepo {
  const manifest = checkManifest(files)
  const { objects, problems } = splitRepo(files)
  return {
    problems: [...manifest, ...problems],
    objects: objects.map((object) => ({
      kind: object.kind,
      slug: object.slug,
      result: decodeObject(object),
    })),
  }
}
