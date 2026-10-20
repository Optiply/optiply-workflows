import { bumpVersion, compareVersions, parseSemver, type VersionBump } from '@ow/definition'
import { TRPCError } from '@trpc/server'

/**
 * The version of a new release of workflows, apps and library queries: the one given, or the highest existing
 * one bumped (`patch` by default; the first is 1.0.0). It must be semver and higher than every existing release.
 */
export function nextReleaseVersion(
  existing: string[],
  opts: { version?: string; bump?: VersionBump },
): string {
  const highest = [...existing].sort(compareVersions).at(-1) ?? null
  const version = opts.version ?? bumpVersion(highest, opts.bump ?? 'patch')
  if (!parseSemver(version)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Use a version like 1.2.3' })
  if (highest && compareVersions(version, highest) <= 0) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `The version must be higher than v${highest}, the latest release`,
    })
  }
  return version
}
