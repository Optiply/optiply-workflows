import { z } from 'zod'
import { issuePath, type Problem } from './files'

/**
 * A folder as a path of folder names, `Finance/Reports` (M22). Each name follows the folders API (1–80 characters,
 * no spaces at either end) and can't hold a `/`.
 */
export const folderPathSchema = z
  .string()
  .max(1000)
  .refine(
    (path) => path.split('/').every((part) => part.length > 0 && part.length <= 80 && part.trim() === part),
    'Expected folder names separated by /, such as "Finance/Reports" (none empty, no spaces at either end)',
  )

/** The folder path's names, outermost first. */
export function folderNames(path: string): string[] {
  return path.split('/')
}

/** What the repo keeps beside a definition: the same rules as the workflows and apps APIs. */
export const objectMetaSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  folder: folderPathSchema.optional(),
})

export interface ObjectMeta {
  name: string
  /** Null (or empty) leaves `description` out of the file. */
  description: string | null
  /** The folder it's in on the instance (M22); left out at the top level. Not part of a definition's hash. */
  folder?: string
}

/** The name, description and folder as top-level keys of the object's JSON, beside the definition's. */
export function metaFields(meta: ObjectMeta): { name: string; description?: string; folder?: string } {
  return {
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.folder ? { folder: meta.folder } : {}),
  }
}

/** Splits the name, description and folder off the object's JSON; the rest is the definition. */
export function splitMeta(
  path: string,
  raw: Record<string, unknown>,
): { meta: ObjectMeta | null; rest: Record<string, unknown>; problems: Problem[] } {
  const { name, description, folder, ...rest } = raw
  const parsed = objectMetaSchema.safeParse({
    name,
    ...(description === undefined ? {} : { description }),
    ...(folder === undefined ? {} : { folder }),
  })
  if (!parsed.success) {
    return {
      meta: null,
      rest,
      problems: parsed.error.issues.map((issue) => ({
        path,
        code: 'invalid_definition' as const,
        message: `${path}: ${issuePath(issue.path)}: ${issue.message}`,
      })),
    }
  }
  return {
    meta: {
      name: parsed.data.name,
      description: parsed.data.description || null,
      ...(parsed.data.folder ? { folder: parsed.data.folder } : {}),
    },
    rest,
    problems: [],
  }
}
