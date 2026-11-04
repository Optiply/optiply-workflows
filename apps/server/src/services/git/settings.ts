import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Keyring } from '@ow/crypto'
import { type Db, type GitHostKind, type GitSettings, gitObjects, gitSettings, workflows } from '@ow/db'
import { checkManifest, KIND_ROOTS, MANIFEST_FILE, splitRepo } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { Config } from '../../config'
import { decryptForRow, encryptForRow } from '../secrets'
import { GitError, type GitErrorKind } from './cli'
import {
  appPrivateKey,
  detectGitHost,
  forgetGitHubAppTokens,
  GitHostError,
  gitCredentials,
  gitHostFor,
} from './hosts'
import { checkRepoUrl, GitRepo } from './repo'

export interface GitSecrets {
  token?: string
  webhookSecret?: string
  /** A GitHub App's private key (PEM; M31). */
  appPrivateKey?: string
}

/** What admins see: never the token or the webhook secret, only whether they're set. */
export interface GitSettingsView {
  configured: boolean
  repoUrl: string | null
  branch: string
  /** Where the repo is hosted (M31), and GitLab's API URL for an instance under a path. */
  host: GitHostKind
  apiUrl: string | null
  /** GitHub's sign-in (M31): a token, or a GitHub App (its id; its private key never shown). */
  githubAuth: 'token' | 'app'
  githubAppId: string | null
  appPrivateKey: { set: boolean }
  token: { set: boolean }
  webhookSecret: { set: boolean }
  /** Run when a deploy's problems change (M22). */
  notifyWorkflow: { id: string; name: string } | null
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
    host: loaded?.row.host ?? 'github',
    apiUrl: loaded?.row.apiUrl ?? null,
    githubAuth: loaded?.row.githubAuth ?? 'token',
    githubAppId: loaded?.row.githubAppId ?? null,
    appPrivateKey: { set: Boolean(loaded?.secrets.appPrivateKey) },
    token: { set: Boolean(loaded?.secrets.token) },
    webhookSecret: { set: Boolean(loaded?.secrets.webhookSecret) },
    notifyWorkflow: await notifyWorkflowOf(db, loaded?.row.notifyWorkflowId ?? null),
    updatedAt: loaded?.row.updatedAt ?? null,
  }
}

async function notifyWorkflowOf(db: Db, id: string | null): Promise<GitSettingsView['notifyWorkflow']> {
  if (!id) return null
  const [workflow] = await db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(eq(workflows.id, id))
  return workflow ?? null
}

/**
 * Picks the workflow run when a deploy's problems change (M22), or none. Its live release runs, so it needs one by
 * then; until it has, notifications are only logged.
 */
export async function setNotifyWorkflow(db: Db, workflowId: string | null): Promise<void> {
  if (workflowId && !(await notifyWorkflowOf(db, workflowId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found' })
  }
  const updated = await db
    .update(gitSettings)
    .set({ notifyWorkflowId: workflowId })
    .returning({ id: gitSettings.id })
  if (updated.length === 0) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Set up Git sync first' })
  }
}

/**
 * Saves the repo settings. `token` and `webhookSecret`: a string sets it, null clears it, undefined keeps it.
 * Pointing the repo at another host needs the token again, so a stored token can't be sent somewhere new; so does
 * another kind of host (M31). `host`: undefined detects it from the URL (github.com, gitlab.com), else keeps the
 * stored one for the same origin, else GitHub. `apiUrl` (GitLab only): undefined keeps it, null clears it.
 */
export async function saveGitSettings(
  db: Db,
  config: Pick<Config, 'keyring' | 'GIT_ALLOW_INSECURE_URLS'>,
  user: { id: string },
  input: {
    repoUrl: string
    branch: string
    host?: GitHostKind
    apiUrl?: string | null
    /** GitHub only (M31): undefined keeps the stored one for the same host, else a token. */
    githubAuth?: 'token' | 'app'
    githubAppId?: string | null
    appPrivateKey?: string | null
    token?: string | null
    webhookSecret?: string | null
  },
): Promise<{ tokenChanged: boolean; webhookSecretChanged: boolean; appKeyChanged: boolean }> {
  let repoUrl: string
  try {
    repoUrl = checkRepoUrl(input.repoUrl, { allowInsecure: config.GIT_ALLOW_INSECURE_URLS })
  } catch (err) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
  }
  const existing = await loadGitSettings(db, config.keyring)
  const sameOrigin = existing && new URL(existing.row.repoUrl).origin === new URL(repoUrl).origin
  const host: GitHostKind =
    input.host ?? detectGitHost(repoUrl) ?? (sameOrigin ? existing.row.host : 'github')
  const apiUrl =
    host !== 'gitlab'
      ? null
      : input.apiUrl === undefined
        ? sameOrigin
          ? existing.row.apiUrl
          : null
        : checkApiUrl(input.apiUrl, repoUrl, config.GIT_ALLOW_INSECURE_URLS)
  const secrets: GitSecrets = { ...existing?.secrets }
  const otherHost = !sameOrigin || existing.row.host !== host
  if (existing?.secrets.token && input.token === undefined && otherHost) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The repo is on another host now: enter the token again',
    })
  }
  const githubAuth =
    host !== 'github' ? 'token' : (input.githubAuth ?? (otherHost ? 'token' : existing.row.githubAuth))
  const githubAppId =
    githubAuth !== 'app'
      ? null
      : input.githubAppId === undefined
        ? (existing?.row.githubAppId ?? null)
        : input.githubAppId?.trim() || null
  if (githubAuth === 'app') {
    if (!githubAppId || !/^\d+$/.test(githubAppId))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: "Enter the GitHub App's id (a number, on its settings page)",
      })
    if (existing?.secrets.appPrivateKey && input.appPrivateKey === undefined && otherHost)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: "The repo is on another host now: enter the GitHub App's private key again",
      })
    if (input.appPrivateKey !== undefined) {
      if (input.appPrivateKey) secrets.appPrivateKey = input.appPrivateKey.trim()
      else delete secrets.appPrivateKey
    }
    if (!secrets.appPrivateKey)
      throw new TRPCError({ code: 'BAD_REQUEST', message: "Add the GitHub App's private key (a .pem file)" })
    try {
      appPrivateKey(secrets.appPrivateKey)
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
    }
  } else delete secrets.appPrivateKey
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
  // Another repo or branch: what was deployed from the old one says nothing about the new one.
  const moved = existing && (existing.row.repoUrl !== repoUrl || existing.row.branch !== input.branch)
  const values = {
    repoUrl,
    branch: input.branch,
    host,
    apiUrl,
    githubAuth,
    githubAppId,
    secrets: encrypted,
    updatedBy: user.id,
    ...(moved ? { deployedCommit: null, lastError: null } : {}),
  }
  await db
    .insert(gitSettings)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: gitSettings.singleton, set: { ...values, updatedAt: sql`now()` } })
  // Tokens minted for the old settings mustn't outlive them.
  forgetGitHubAppTokens()
  return {
    appKeyChanged: (secrets.appPrivateKey ?? null) !== (existing?.secrets.appPrivateKey ?? null),
    tokenChanged: input.token !== undefined && (input.token || null) !== (existing?.secrets.token ?? null),
    webhookSecretChanged:
      input.webhookSecret !== undefined &&
      (input.webhookSecret || null) !== (existing?.secrets.webhookSecret ?? null),
  }
}

/** GitLab's API URL for an instance under a path: on the repo's own origin, over https; null when empty. */
function checkApiUrl(apiUrl: string | null, repoUrl: string, allowInsecure: boolean): string | null {
  const text = apiUrl?.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: "The API URL isn't a URL" })
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:'))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'The API URL must use https' })
  if (url.origin !== new URL(repoUrl).origin)
    throw new TRPCError({ code: 'BAD_REQUEST', message: "The API URL must be on the repo's own host" })
  if (url.username || url.password || url.search || url.hash)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Leave credentials and queries out of the API URL' })
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export async function clearGitSettings(db: Db): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(gitSettings).returning({ id: gitSettings.id })
    // What was deployed from that repo: another repo (or this one again) starts afresh (M22 review).
    await tx.delete(gitObjects)
    return deleted.length > 0
  })
}

/** The repo through this process's cache, or null when no repo is set up. */
export async function openGitRepo(
  db: Db,
  config: Pick<
    Config,
    'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL' | 'GITLAB_API_URL'
  >,
): Promise<{ repo: GitRepo; branch: string; secrets: GitSecrets } | null> {
  const loaded = await loadGitSettings(db, config.keyring)
  if (!loaded) return null
  const repo = await GitRepo.open(
    gitCacheRoot(config),
    { url: loaded.row.repoUrl, token: null, credentials: gitCredentials(loaded, config) },
    { allowInsecure: config.GIT_ALLOW_INSECURE_URLS },
  )
  return { repo, branch: loaded.row.branch, secrets: loaded.secrets }
}

/** The host's API, signed in to for the repo (M31): what it found and what's missing, or why it couldn't. */
export type GitHostReport = { ok: true; message: string; problems: string[] } | { ok: false; message: string }

export type GitTestResult = (
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
) & { host?: GitHostReport }

/** The host's own check (pull requests need its API, not only git), for Test connection. */
async function hostReport(
  db: Db,
  config: Pick<Config, 'keyring' | 'GITHUB_API_URL' | 'GITLAB_API_URL'>,
): Promise<GitHostReport | undefined> {
  const loaded = await loadGitSettings(db, config.keyring)
  if (!loaded) return undefined
  // Without a token there's no API to sign in to (a public or local repo): nothing to report.
  if (!loaded.secrets.token && loaded.row.githubAuth !== 'app') return undefined
  const host = gitHostFor(loaded, config)
  if ('error' in host) return { ok: false, message: host.error }
  try {
    return { ok: true, ...(await host.check()) }
  } catch (err) {
    if (err instanceof GitHostError) return { ok: false, message: err.message }
    throw err
  }
}

/** Signs in to the repo, reads the deploy branch and counts what's on it, and asks the host's API. Writes nothing. */
export async function testGitConnection(
  db: Db,
  config: Pick<
    Config,
    'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL' | 'GITLAB_API_URL'
  >,
): Promise<GitTestResult> {
  const [repo, host] = await Promise.all([testGitRepo(db, config), hostReport(db, config)])
  return host ? { ...repo, host } : repo
}

async function testGitRepo(
  db: Db,
  config: Pick<
    Config,
    'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GITHUB_API_URL' | 'GITLAB_API_URL'
  >,
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

/**
 * The repo's web address, for links to commits and branches: an https URL without `.git`. Null for other URLs
 * (local repos in development).
 */
export function repoWebUrl(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl)
    if (url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`
  } catch {
    return null
  }
}
