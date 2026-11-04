import { CONFIG_VAR_NAME, canonicalJson, workflowSlugSchema } from '@ow/definition'
import { z } from 'zod'
import {
  caseCollisions,
  type Decoded,
  type Files,
  isRecord,
  issuePath,
  type Problem,
  parseJsonFile,
  type Warning,
} from './files'
import { metaFields, type ObjectMeta, splitMeta } from './meta'

/**
 * Resources and config vars (M22): what workflows and apps depend on, kept beside them so a repo carries everything
 * an instance needs except secrets. They have no drafts or releases, so they're kinds of their own, apart from
 * `ObjectKind`.
 */
export type SettingsKind = 'resource' | 'config_var'

/** Where each lives: `resources/<slug>/`, `config-vars/<NAME>/`. */
export const SETTINGS_ROOTS: Record<SettingsKind, string> = {
  resource: 'resources',
  config_var: 'config-vars',
}

export const SETTINGS_LABELS: Record<SettingsKind, string> = {
  resource: 'resource',
  config_var: 'config var',
}

/** A resource's slug, as the resources API takes it (no hyphens: definitions name resources in templates). */
export const resourceSlugSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,62}$/,
    'Use 2–63 lowercase letters, digits or underscores, starting with a letter',
  )

export const configVarNameSchema = z
  .string()
  .regex(CONFIG_VAR_NAME, 'Use letters, digits and underscores, not starting with a digit')

/** What names an object of each kind: its directory's name. */
export const SETTINGS_NAMES: Record<SettingsKind, z.ZodType<string>> = {
  resource: resourceSlugSchema,
  config_var: configVarNameSchema,
}

export const RESOURCE_FILE = 'resource.json'
export const CONFIG_VAR_FILE = 'config-var.json'

/** Environments are named by slug, so one repo fits instances whose environments' ids differ. */
const environmentSlugSchema = workflowSlugSchema

export interface ResourceObject extends ObjectMeta {
  /** The connector, e.g. `postgres`; the server checks it and each config against the connector. */
  type: string
  /** Non-secret settings per environment slug. Secrets stay on each instance. */
  environments: Record<string, { config: Record<string, unknown> }>
}

const resourceFileSchema = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Expected a connector type such as "postgres"'),
  environments: z.record(
    environmentSlugSchema,
    z.strictObject({ config: z.record(z.string(), z.unknown()) }),
  ),
})

export interface ConfigVarObject {
  description: string | null
  secret: boolean
  /** Values per environment slug; a secret one has none here (each instance sets its own). */
  values: Record<string, string>
}

const configVarFileSchema = z.strictObject({
  description: z.string().trim().max(500).optional(),
  secret: z.boolean(),
  values: z.record(environmentSlugSchema, z.string()).optional(),
})

/** A resource as its directory's one file: name, description, type and each environment's config. */
export function encodeResource(object: ResourceObject): { files: Files; warnings: Warning[] } {
  return single(
    RESOURCE_FILE,
    canonicalJson(
      { ...metaFields(object), type: object.type, environments: object.environments },
      { pretty: true },
    ),
  )
}

export function decodeResource(files: Files): Decoded<ResourceObject> {
  const read = readSingle(files, RESOURCE_FILE)
  if (!read.ok) return read
  const { meta, rest, problems } = splitMeta(RESOURCE_FILE, read.value)
  const result = resourceFileSchema.safeParse(rest)
  if (!result.success) problems.push(...issues(RESOURCE_FILE, result.error))
  problems.push(...read.problems)
  if (problems.length > 0 || !meta || !result.success) return { ok: false, problems }
  return { ok: true, value: { ...meta, ...result.data } }
}

/** A config var as its directory's one file (the directory is its name). A secret one's values aren't written. */
export function encodeConfigVar(object: ConfigVarObject): { files: Files; warnings: Warning[] } {
  return single(
    CONFIG_VAR_FILE,
    canonicalJson(
      {
        ...(object.description ? { description: object.description } : {}),
        secret: object.secret,
        ...(object.secret ? {} : { values: object.values }),
      },
      { pretty: true },
    ),
  )
}

export function decodeConfigVar(files: Files): Decoded<ConfigVarObject> {
  const read = readSingle(files, CONFIG_VAR_FILE)
  if (!read.ok) return read
  const problems = [...read.problems]
  const result = configVarFileSchema.safeParse(read.value)
  if (!result.success) {
    problems.push(...issues(CONFIG_VAR_FILE, result.error))
    return { ok: false, problems }
  }
  const { description, secret, values } = result.data
  if (secret && values !== undefined) {
    problems.push({
      path: CONFIG_VAR_FILE,
      code: 'invalid_definition',
      message: `${CONFIG_VAR_FILE}: values: a secret config var's values stay on each instance, not in Git`,
    })
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, value: { description: description || null, secret, values: values ?? {} } }
}

export interface SettingsKindValues {
  resource: ResourceObject
  config_var: ConfigVarObject
}

export type SettingsObject = {
  [K in SettingsKind]: { kind: K; slug: string; value: SettingsKindValues[K] }
}[SettingsKind]

export const SETTINGS_CODECS: {
  [K in SettingsKind]: {
    encode(value: SettingsKindValues[K]): { files: Files; warnings: Warning[] }
    decode(files: Files): Decoded<SettingsKindValues[K]>
  }
} = {
  resource: { encode: encodeResource, decode: decodeResource },
  config_var: { encode: encodeConfigVar, decode: decodeConfigVar },
}

function single(path: string, content: string): { files: Files; warnings: Warning[] } {
  const files = { [path]: content }
  return { files, warnings: caseCollisions(files) }
}

/** The directory's one JSON file as an object; any other file is a problem (reported beside the file's own). */
function readSingle(
  files: Files,
  path: string,
): { ok: true; value: Record<string, unknown>; problems: Problem[] } | { ok: false; problems: Problem[] } {
  const stray: Problem[] = Object.keys(files)
    .filter((p) => p !== path)
    .sort()
    .map((p) => ({ path: p, code: 'unexpected_file', message: `${p} doesn't belong in this directory` }))
  const source = files[path]
  if (source === undefined) {
    return { ok: false, problems: [{ path, code: 'missing_file', message: `${path} is missing` }, ...stray] }
  }
  const parsed = parseJsonFile(path, source)
  if (!parsed.ok) return { ok: false, problems: [parsed.problem, ...stray] }
  if (!isRecord(parsed.value)) {
    return {
      ok: false,
      problems: [{ path, code: 'invalid_definition', message: `${path}: Expected an object` }, ...stray],
    }
  }
  return { ok: true, value: parsed.value, problems: stray }
}

function issues(path: string, error: z.ZodError): Problem[] {
  return error.issues.map((issue) => ({
    path,
    code: 'invalid_definition' as const,
    message: `${path}: ${issuePath(issue.path)}: ${issue.message}`,
  }))
}
