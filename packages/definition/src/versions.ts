/** Release versions: SemVer `major.minor.patch`, without pre-release or build parts. */

export type VersionBump = 'major' | 'minor' | 'patch'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** The three numbers of a version, or null when it isn't one. */
export function parseSemver(version: string): [number, number, number] | null {
  const m = SEMVER.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a)!
  const pb = parseSemver(b)!
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

/** The version after `latest` (1.0.0 for the first release). */
export function bumpVersion(latest: string | null, bump: VersionBump): string {
  if (!latest) return '1.0.0'
  const [major, minor, patch] = parseSemver(latest)!
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}
