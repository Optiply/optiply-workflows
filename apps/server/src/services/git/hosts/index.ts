import type { IncomingHttpHeaders } from 'node:http'
import type { Db, GitSettings } from '@ow/db'
import type { Config } from '../../../config'
import { type GitSecrets, loadGitSettings } from '../settings'
import { checkGitHubWebhook, GitHubHost, githubTarget } from './github'
import type { GitCredentials, GitHost, GitHostKind, GitWebhookCheck } from './types'

export { githubTarget } from './github'
export * from './types'

type HostConfig = Pick<Config, 'keyring' | 'GITHUB_API_URL'>
type Loaded = { row: GitSettings; secrets: GitSecrets }

/** What the host calls a change request, for messages: "pull request" or "merge request". */
export function changeRequestNoun(kind: GitHostKind): string {
  return kind === 'gitlab' ? 'merge request' : 'pull request'
}

/** The host's API for the stored settings, or why there isn't one. */
export function gitHostFor(loaded: Loaded, config: HostConfig): GitHost | { error: string } {
  const target = githubTarget(loaded.row.repoUrl, config.GITHUB_API_URL)
  if (!target) return { error: "The repo isn't on GitHub: open the pull request there yourself" }
  const token = loaded.secrets.token ?? null
  return new GitHubHost(target, async () => token)
}

/** The configured repo's host, or why there isn't one. */
export async function openGitHost(
  db: Db,
  config: HostConfig,
): Promise<{ host: GitHost; branch: string } | { error: string }> {
  const loaded = await loadGitSettings(db, config.keyring)
  if (!loaded) return { error: "Git sync isn't set up" }
  const host = gitHostFor(loaded, config)
  if ('error' in host) return host
  return { host, branch: loaded.row.branch }
}

/**
 * What git signs in to the remote with, asked before each command that talks to it (so a short-lived token is
 * fresh): the host's username and the token. Null: no token set (a public or local repo).
 */
export function gitCredentials(loaded: Loaded): () => Promise<GitCredentials | null> {
  const token = loaded.secrets.token ?? null
  return async () => (token ? { username: 'x-access-token', token } : null)
}

/** Checks a push webhook delivery the way the settings' host signs it. */
export function checkGitWebhook(
  loaded: Loaded,
  secret: string,
  headers: IncomingHttpHeaders,
  raw: Buffer,
): GitWebhookCheck {
  return checkGitHubWebhook(secret, headers, raw)
}
