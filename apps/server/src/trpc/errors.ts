import { TRPCError } from '@trpc/server'

/** Turns a unique-constraint violation (SQLSTATE 23505, possibly wrapped by drizzle) into a CONFLICT error. */
export async function uniqueOr<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const code =
      (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code
    if (code === '23505') throw new TRPCError({ code: 'CONFLICT', message })
    throw err
  }
}

/** A 400 listing which fields failed validation. Secret issues pass `pathsOnly` so values can't leak. */
export function invalidInput(
  what: string,
  issues: { path: PropertyKey[]; message: string }[],
  opts: { pathsOnly?: boolean } = {},
): TRPCError {
  const lines = issues.map((i) => {
    const path = i.path.map(String).join('.') || '(root)'
    return opts.pathsOnly ? path : `${path}: ${i.message}`
  })
  return new TRPCError({ code: 'BAD_REQUEST', message: `Invalid ${what}: ${lines.join('; ')}` })
}
