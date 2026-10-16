import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Keyring } from '@ow/crypto'
import { type Db, type GitSettings, gitSettings } from '@ow/db'
import { checkManifest, KIND_ROOTS, MANIFEST_FILE, splitRepo } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { Config } from '../../config'
import { decryptForRow, encryptForRow } from '../secrets'
import { GitError, type GitErrorKind } from './cli'
import { checkRepoUrl, GitRepo } from './repo'

export interface GitSecrets {
  token?: string
  webhookSecret?: string
}

/** What admins see: never the token or the webhook secret, only whether they're set. */
export interface GitSettingsView {
  configured: boolean
  repoUrl: string | null
  branch: string
  token: { set: boolean }
  webhookSecret: { set: boolean }
  updatedAt: Date | null
}

export function gitCacheRoot(config: Pick<Config, 'GIT_CACHE_DIR'>): string {
  return config.GIT_CACHE_DIR ?? join(tmpdir(), `ow-git-${process.pid}`)
}

export async function loadGitSettings(
  db: Db,
  keyring: Keyring,
): Promise<{ row: GitSettings; secrets: GitSecrets } | null> {
  const [row] = await db.select().from(gitSettings)
  if (!row) return null
  const secrets = row.secrets
    ? decryptForRow<GitSecrets>(keyring, 'git_settings', { id: row.id, environmentId: null }, row.secrets)
    : {}
  return { row, secrets }
}

export async function gitSettingsView(db: Db, keyring: Keyring): Promise<GitSettingsView> {
  const loaded = await loadGitSettings(db, keyring)
  return {
    configured: Boolean(loaded),
    repoUrl: loaded?.row.repoUrl ?? null,
    branch: loaded?.row.branch ?? 'main',
    token: { set: Boolean(loaded?.secrets.token) },
    webhookSecret: { set: Boolean(loaded?.secrets.webhookSecret) },
    updatedAt: loaded?.row.updatedAt ?? null,
  }
}

/**
 * Saves the repo settings. `token` and `webhookSecret`: a string sets it, null clears it, undefined keeps it.
 * Pointing the repo at another host needs the token again, so a stored token can't be sent somewhere new.
 */
export async function saveGitSettings(
  db: Db,
  config: Pick<Config, 'keyring' | 'GIT_ALLOW_INSECURE_URLS'>,
  user: { id: string },
  input: { repoUrl: string; branch: string; token?: string | null; webhookSecret?: string | null },
): Promise<{ tokenChanged: boolean; webhookSecretChanged: boolean }> {
  let repoUrl: string
  try {
    repoUrl = checkRepoUrl(input.repoUrl, { allowInsecure: config.GIT_ALLOW_INSECURE_URLS })
  } catch (err) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
  }
  const existing = await loadGitSettings(db, config.keyring)
  const secrets: GitSecrets = { ...existing?.secrets }
  if (
    existing?.secrets.token &&
    input.token === undefined &&
    new URL(existing.row.repoUrl).origin !== new URL(repoUrl).origin
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The repo is on another host now: enter the token again',
    })
  }
  if (input.token !== undefined) {
    if (input.token) secrets.token = input.token
    else delete secrets.token
  }
  if (input.webhookSecret !== undefined) {
    if (input.webhookSecret) secrets.webhookSecret = input.webhookSecret
    else delete secrets.webhookSecret
  }
  const id = existing?.row.id ?? uuidv7()
  const encrypted =
    Object.keys(secrets).length > 0
      ? encryptForRow(config.keyring, 'git_settings', { id, environmentId: null }, secrets)
      : null
  const values = { repoUrl, branch: input.branch, secrets: encrypted, updatedBy: user.id }
  await db
    .insert(gitSettings)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: gitSettings.singleton, set: { ...values, updatedAt: sql`now()` } })
  return {
    tokenChanged: input.token !== undefined && (input.token || null) !== (existing?.secrets.token ?? null),
    webhookSecretChanged:
      input.webhookSecret !== undefined &&
      (input.webhookSecret || null) !== (existing?.secrets.webhookSecret ?? null),
  }
}

export async function clearGitSettings(db: Db): Promise<boolean> {
  const deleted = await db.delete(gitSettings).returning({ id: gitSettings.id })
  return deleted.length > 0
}

/** The repo through this process's cache, or null when no repo is set up. */
export async function openGitRepo(
  db: Db,
  config: Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS'>,
): Promise<{ repo: GitRepo; branch: string; secrets: GitSecrets } | null> {
  const loaded = await loadGitSettings(db, config.keyring)
  if (!loaded) return null
  const repo = await GitRepo.open(
    gitCacheRoot(config),
    { url: loaded.row.repoUrl, token: loaded.secrets.token ?? null },
    { allowInsecure: config.GIT_ALLOW_INSECURE_URLS },
  )
  return { repo, branch: loaded.row.branch, secrets: loaded.secrets }
}

export type GitTestResult =
  | {
      ok: true
      /** The deploy branch's commit, or null when the repo doesn't have it yet (an empty repo). */
      commit: string | null
      branches: number
      /** `missing`: the first commit from the instance adds `ow.json`. */
      manifest: 'present' | 'missing' | 'unsupported'
      manifestMessage: string | null
      workflows: number
      apps: number
    }
  | { ok: false; kind: GitErrorKind | 'not_configured'; message: string }

/** Signs in to the repo, reads the deploy branch and counts what's on it. Writes nothing. */
export async function testGitConnection(
  db: Db,
  config: Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS'>,
): Promise<GitTestResult> {
  const opened = await openGitRepo(db, config)
  if (!opened) return { ok: false, kind: 'not_configured', message: 'No repo is set up' }
  const { repo, branch } = opened
  try {
    const branches = await repo.listBranches()
    const commit = branches.has(branch) ? await repo.fetchBranch(branch) : null
    if (!commit) {
      return {
        ok: true,
        commit: null,
        branches: branches.size,
        manifest: 'missing',
        manifestMessage: `The repo has no ${branch} branch yet`,
        workflows: 0,
        apps: 0,
      }
    }
    const files = await repo.readFiles(commit, [
      MANIFEST_FILE,
      `${KIND_ROOTS.workflow}/`,
      `${KIND_ROOTS.app}/`,
    ])
    const manifestProblems = checkManifest(files)
    const { objects } = splitRepo(files)
    return {
      ok: true,
      commit,
      branches: branches.size,
      manifest:
        files[MANIFEST_FILE] === undefined
          ? 'missing'
          : manifestProblems.length > 0
            ? 'unsupported'
            : 'present',
      manifestMessage: manifestProblems[0]?.message ?? null,
      workflows: objects.filter((o) => o.kind === 'workflow').length,
      apps: objects.filter((o) => o.kind === 'app').length,
    }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, kind: err.kind, message: err.message }
    throw err
  }
}
