import { z } from 'zod'
import { issuePath, type Problem } from './files'

/** What the repo keeps beside a definition: the same rules as the workflows and apps APIs. */
export const objectMetaSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
})

export interface ObjectMeta {
  name: string
  /** Null (or empty) leaves `description` out of the file. */
  description: string | null
}

/** The name and description as top-level keys of the object's JSON, beside the definition's. */
export function metaFields(meta: ObjectMeta): { name: string; description?: string } {
  return meta.description ? { name: meta.name, description: meta.description } : { name: meta.name }
}

/** Splits the name and description off the object's JSON; the rest is the definition. */
export function splitMeta(
  path: string,
  raw: Record<string, unknown>,
): { meta: ObjectMeta | null; rest: Record<string, unknown>; problems: Problem[] } {
  const { name, description, ...rest } = raw
  const parsed = objectMetaSchema.safeParse(description === undefined ? { name } : { name, description })
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
    meta: { name: parsed.data.name, description: parsed.data.description || null },
    rest,
    problems: [],
  }
}
