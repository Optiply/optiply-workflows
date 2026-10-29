import { canonicalJson, workflowSlugSchema } from '@ow/definition'
import { type AppObject, decodeApp, decodeModule, encodeApp, encodeModule, type ModuleObject } from './app'
import {
  type ComponentLibraryObject,
  decodeComponentLibrary,
  encodeComponentLibrary,
} from './component-library'
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
import {
  SETTINGS_CODECS,
  SETTINGS_LABELS,
  SETTINGS_NAMES,
  SETTINGS_ROOTS,
  type SettingsKind,
  type SettingsObject,
} from './settings'
import { decodeWorkflow, encodeWorkflow, type WorkflowObject } from './workflow'

/** The repo's root file, naming the format its directories are in. */
export const MANIFEST_FILE = 'ow.json'
export const FORMAT_VERSION = 1

export type ObjectKind = 'workflow' | 'app' | 'library_query' | 'module' | 'component_library'

/**
 * Where each kind lives: `workflows/<slug>/`, `apps/<slug>/`, `library/<slug>/`, `modules/<slug>/`,
 * `component-libraries/<slug>/` (M25).
 */
export const KIND_ROOTS: Record<ObjectKind, string> = {
  workflow: 'workflows',
  app: 'apps',
  library_query: 'library',
  module: 'modules',
  component_library: 'component-libraries',
}

/** Each kind as people read it, for messages. */
export const KIND_LABELS: Record<ObjectKind, string> = {
  workflow: 'workflow',
  app: 'app',
  library_query: 'library query',
  module: 'module',
  component_library: 'component library',
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
  component_library: ComponentLibraryObject
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
  component_library: { encode: encodeComponentLibrary, decode: decodeComponentLibrary },
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

/** The same for a resource or config var (`slug` is a config var's name). */
export interface SettingsFiles {
  kind: SettingsKind
  slug: string
  files: Files
}

/** The directory of a resource or config var, without a trailing slash. */
export function settingsDir(kind: SettingsKind, slug: string): string {
  return `${SETTINGS_ROOTS[kind]}/${slug}`
}

/** A resource's or config var's directory and its files, keyed by their path inside it. */
export function encodeSettingsDir(object: SettingsObject): {
  dir: string
  files: Files
  warnings: Warning[]
} {
  const codec = SETTINGS_CODECS[object.kind] as {
    encode(value: SettingsObject['value']): { files: Files; warnings: Warning[] }
  }
  return { dir: settingsDir(object.kind, object.slug), ...codec.encode(object.value) }
}

type AnyKind = ObjectKind | SettingsKind
const ROOTS: Record<AnyKind, string> = { ...KIND_ROOTS, ...SETTINGS_ROOTS }
const LABELS: Record<AnyKind, string> = { ...KIND_LABELS, ...SETTINGS_LABELS }
const NAMES: Record<AnyKind, { safeParse(v: unknown): { success: boolean } }> = {
  workflow: objectSlugSchema,
  app: objectSlugSchema,
  library_query: objectSlugSchema,
  module: objectSlugSchema,
  component_library: objectSlugSchema,
  ...SETTINGS_NAMES,
}
const isSettingsKind = (kind: AnyKind): kind is SettingsKind => kind in SETTINGS_ROOTS

/**
 * Groups a repo's files into objects, and resources and config vars apart (`settings`). Files outside the kinds'
 * roots (a README, CI) are ignored; a file right under a root (`workflows/`, `apps/`, `library/`, `modules/`,
 * `resources/`, `config-vars/`), or a directory that isn't a slug (a config var's name), is a problem.
 */
export function splitRepo(files: Files): {
  objects: ObjectFiles[]
  settings: SettingsFiles[]
  problems: Problem[]
} {
  const problems: Problem[] = []
  const byDir = new Map<string, { kind: AnyKind; slug: string; files: Files }>()
  for (const [path, content] of Object.entries(files)) {
    const kind = (Object.keys(ROOTS) as AnyKind[]).find((k) => path.startsWith(`${ROOTS[k]}/`))
    if (!kind) continue
    const [, slug, ...rest] = path.split('/')
    if (rest.length === 0) {
      problems.push({
        path,
        code: 'unexpected_file',
        message: `${path} isn't in a ${LABELS[kind]}'s directory (${ROOTS[kind]}/<${kind === 'config_var' ? 'NAME' : 'slug'}>/)`,
      })
      continue
    }
    const dir = `${ROOTS[kind]}/${slug}`
    if (!NAMES[kind].safeParse(slug).success) {
      if (!problems.some((p) => p.path === dir)) {
        problems.push({ path: dir, code: 'invalid_slug', message: `${dir}: "${slug}" ${NAME_RULES[kind]}` })
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
  const all = [...byDir.values()].sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  )
  return {
    objects: all.filter((o): o is ObjectFiles => !isSettingsKind(o.kind)),
    settings: all.filter((o): o is SettingsFiles => isSettingsKind(o.kind)),
    problems,
  }
}

const SLUG_RULE = 'lowercase letters, digits, - or _, starting with a letter'
const NAME_RULES: Record<AnyKind, string> = {
  workflow: `isn't a valid workflow slug (2–63 ${SLUG_RULE})`,
  app: `isn't a valid app slug (2–63 ${SLUG_RULE})`,
  library_query: `isn't a valid library query slug (2–63 ${SLUG_RULE})`,
  module: `isn't a valid module slug (2–63 ${SLUG_RULE})`,
  component_library: `isn't a valid component library slug (2–63 ${SLUG_RULE})`,
  resource: "isn't a valid resource slug (2–63 lowercase letters, digits or _, starting with a letter)",
  config_var: "isn't a valid config var name (letters, digits and _, not starting with a digit, up to 64)",
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

/** A resource's or config var's files decoded; problems carry paths from the repo root. */
export function decodeSettings(object: SettingsFiles): Decoded<SettingsObject> {
  const dir = `${settingsDir(object.kind, object.slug)}/`
  const decoded = SETTINGS_CODECS[object.kind].decode(object.files)
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
  return { ok: true, value: { kind: object.kind, slug: object.slug, value: decoded.value } as SettingsObject }
}

export interface DecodedRepo {
  /** Problems with the repo as a whole (`ow.json`, stray files and directories). */
  problems: Problem[]
  objects: Array<{ kind: ObjectKind; slug: string; result: Decoded<RepoObject> }>
  /** Resources and config vars (M22). */
  settings: Array<{ kind: SettingsKind; slug: string; result: Decoded<SettingsObject> }>
}

/** A whole repo's files: each object decoded on its own, so one broken object doesn't hide the rest. */
export function decodeRepo(files: Files): DecodedRepo {
  const manifest = checkManifest(files)
  const { objects, settings, problems } = splitRepo(files)
  return {
    problems: [...manifest, ...problems],
    objects: objects.map((object) => ({
      kind: object.kind,
      slug: object.slug,
      result: decodeObject(object),
    })),
    settings: settings.map((object) => ({
      kind: object.kind,
      slug: object.slug,
      result: decodeSettings(object),
    })),
  }
}
