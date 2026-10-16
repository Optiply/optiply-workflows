import type { Db } from '@ow/db'
import type { Config } from '../../config'
import { loadGitSettings } from './settings'

/** A pull request as the instance shows it. */
export interface PullRequestView {
  number: number
  url: string
  title: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  /** The branch it merges, and where to. */
  head: string
  base: string
  updatedAt: string
}

export type GitHubErrorKind = 'auth' | 'not_found' | 'unsupported' | 'invalid' | 'failed'

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Where a repo's REST API is, and its owner and name. */
export interface GitHubTarget {
  api: string
  owner: string
  repo: string
}

/**
 * The GitHub API for a repo URL: api.github.com for github.com, `<host>/api/v3` for GitHub Enterprise Server, or
 * `apiOverride` (`GITHUB_API_URL`, for tests). The owner and name are the URL's last two path segments. Null when
 * the URL can't be a GitHub repo.
 */
export function githubTarget(repoUrl: string, apiOverride?: string): GitHubTarget | null {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts.at(-2)!
  const repo = parts.at(-1)!.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null
  const api = apiOverride
    ? apiOverride.replace(/\/$/, '')
    : url.protocol === 'https:'
      ? url.hostname === 'github.com'
        ? 'https://api.github.com'
        : `https://${url.host}/api/v3`
      : null
  return api ? { api, owner, repo } : null
}

interface RawPull {
  number: number
  html_url: string
  title: string
  state: 'open' | 'closed'
  merged_at: string | null
  merged?: boolean
  draft?: boolean
  head: { ref: string }
  base: { ref: string }
  updated_at: string
}

const view = (p: RawPull): PullRequestView => ({
  number: p.number,
  url: p.html_url,
  title: p.title,
  state: p.state,
  merged: p.merged ?? p.merged_at !== null,
  draft: p.draft ?? false,
  head: p.head.ref,
  base: p.base.ref,
  updatedAt: p.updated_at,
})

/** The pull request calls the instance makes, with the repo's token. Redirects are refused, so the token stays put. */
export class GitHub {
  constructor(
    private readonly target: GitHubTarget,
    private readonly token: string | null,
  ) {}

  /** The newest pull request from `branch` into `base`, open ones first; null when there's none. */
  async findPullRequest(branch: string, base: string): Promise<PullRequestView | null> {
    const query = new URLSearchParams({
      head: `${this.target.owner}:${branch}`,
      base,
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: '10',
    })
    const pulls = await this.request<RawPull[]>('GET', `/pulls?${query}`)
    const open = pulls.find((p) => p.state === 'open')
    const found = open ?? pulls[0]
    return found ? view(found) : null
  }

  /** Opens a pull request, or returns the one already open for the branch (`created` false). */
  async openPullRequest(opts: {
    branch: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestView & { created: boolean }> {
    const existing = await this.findPullRequest(opts.branch, opts.base)
    if (existing?.state === 'open') return { ...existing, created: false }
    const created = await this.request<RawPull>('POST', '/pulls', {
      title: opts.title,
      head: opts.branch,
      base: opts.base,
      body: opts.body,
    })
    return { ...view(created), created: true }
  }

  async getPullRequest(number: number): Promise<PullRequestView> {
    return view(await this.request<RawPull>('GET', `/pulls/${number}`))
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token)
      throw new GitHubError('auth', 'Set a GitHub token in the Git settings to work with pull requests')
    const { api, owner, repo } = this.target
    let res: Response
    try {
      res = await fetch(`${api}/repos/${owner}/${repo}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'optiply-workflows',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new GitHubError('failed', `GitHub didn't answer: ${(err as Error).message}`)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (res.ok) return json as T
    const message = (json as { message?: string; errors?: Array<{ message?: string }> } | null) ?? {}
    const detail = [message.message, ...(message.errors ?? []).map((e) => e.message)]
      .filter(Boolean)
      .join(': ')
    const said = `GitHub said ${res.status}${detail ? `: ${detail}` : ''}`
    if (res.status === 401 || res.status === 403) {
      throw new GitHubError('auth', `${said}. The token needs Pull requests (read and write) on the repo`)
    }
    if (res.status === 404)
      throw new GitHubError('not_found', `${said}. Is the repo URL right, and can the token see it?`)
    if (res.status === 422) throw new GitHubError('invalid', said)
    throw new GitHubError('failed', said)
  }
}

/** The GitHub API for the configured repo, or why there isn't one. */
export async function openGitHub(
  db: Db,
  config: Pick<Config, 'keyring' | 'GITHUB_API_URL'>,
): Promise<{ github: GitHub; branch: string } | { error: string }> {
  const loaded = await loadGitSettings(db, config.keyring)
  if (!loaded) return { error: "Git sync isn't set up" }
  const target = githubTarget(loaded.row.repoUrl, config.GITHUB_API_URL)
  if (!target) return { error: "The repo isn't on GitHub: open the pull request there yourself" }
  return { github: new GitHub(target, loaded.secrets.token ?? null), branch: loaded.row.branch }
}
