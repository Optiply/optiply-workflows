import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { type GitHubAppTokens, missingAppPermissions } from './github-app'
import {
  type GitHost,
  type GitHostCheck,
  GitHostError,
  type GitWebhookCheck,
  type PullRequestView,
} from './types'

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
  kind: 'pull',
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

/**
 * GitHub's pull requests, with the repo's token (a personal token, or a GitHub App's installation token: M31). Redirects
 * are refused, so the token stays put.
 */
export class GitHubHost implements GitHost {
  readonly kind = 'github' as const

  constructor(
    private readonly target: GitHubTarget,
    /** The token for the next call; null when none is set. */
    private readonly token: (opts?: { refresh?: boolean }) => Promise<string | null>,
    /** Signed in as a GitHub App (M31): its tokens are minted again when GitHub refuses one. */
    private readonly app?: GitHubAppTokens,
  ) {}

  async check(): Promise<GitHostCheck> {
    const problems: string[] = []
    let message = ''
    if (this.app) {
      const installation = await this.app.installation()
      message = `GitHub App${installation.appSlug ? ` ${installation.appSlug}` : ''}, installed on ${installation.account}`
      const missing = missingAppPermissions(installation.permissions)
      if (missing.length) problems.push(`The App's installation needs ${missing.join(', ')}`)
    }
    const repo = await this.request<{ full_name: string; permissions?: { push?: boolean } }>('GET', '')
    if (!this.app) {
      message = `GitHub: ${repo.full_name}`
      if (repo.permissions && !repo.permissions.push) problems.push("The token can't push to the repo")
    } else message += ` (${repo.full_name})`
    return { message, problems }
  }

  /** The newest pull request from `branch` into `base`, open ones first; null when there's none. */
  async findChangeRequest(branch: string, base: string): Promise<PullRequestView | null> {
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
  async openChangeRequest(opts: {
    branch: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestView & { created: boolean }> {
    const existing = await this.findChangeRequest(opts.branch, opts.base)
    if (existing?.state === 'open') return { ...existing, created: false }
    const created = await this.request<RawPull>('POST', '/pulls', {
      title: opts.title,
      head: opts.branch,
      base: opts.base,
      body: opts.body,
    })
    return { ...view(created), created: true }
  }

  async getChangeRequest(number: number): Promise<PullRequestView> {
    return view(await this.request<RawPull>('GET', `/pulls/${number}`))
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.token(retried ? { refresh: true } : {})
    if (!token)
      throw new GitHostError('auth', 'Set a GitHub token in the Git settings to work with pull requests')
    const { api, owner, repo } = this.target
    let res: Response
    try {
      res = await fetch(`${api}/repos/${owner}/${repo}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'optiply-workflows',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new GitHostError('failed', `GitHub didn't answer: ${(err as Error).message}`)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (res.ok) return json as T
    // An App's token can be revoked before it expires: once with a new one.
    if (res.status === 401 && this.app && !retried) return this.request(method, path, body, true)
    const message = (json as { message?: string; errors?: Array<{ message?: string }> } | null) ?? {}
    const detail = [message.message, ...(message.errors ?? []).map((e) => e.message)]
      .filter(Boolean)
      .join(': ')
    const said = `GitHub said ${res.status}${detail ? `: ${detail}` : ''}`
    if (res.status === 401 || res.status === 403) {
      throw new GitHostError(
        'auth',
        this.app
          ? `${said}. The GitHub App's installation needs Pull requests (read and write) on the repo`
          : `${said}. The token needs Pull requests (read and write) on the repo`,
      )
    }
    if (res.status === 404)
      throw new GitHostError('not_found', `${said}. Is the repo URL right, and can the token see it?`)
    if (res.status === 422) throw new GitHostError('invalid', said)
    throw new GitHostError('failed', said)
  }
}

/**
 * GitHub's push webhook (the repo's, or a GitHub App's: M31): the body signed with the webhook secret
 * (`X-Hub-Signature-256`, HMAC-SHA256 of the exact bytes). JSON and form-encoded deliveries both work.
 */
export function checkGitHubWebhook(
  secret: string,
  headers: IncomingHttpHeaders,
  raw: Buffer,
): GitWebhookCheck {
  const signature = headers['x-hub-signature-256']
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
  const given = Buffer.from(typeof signature === 'string' ? signature : '')
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, status: 401, code: 'bad_signature', message: 'The signature does not match' }
  const event = headers['x-github-event']
  if (event === 'ping') return { ok: true, event: 'ping' }
  if (event !== 'push') return { ok: true, event: 'other', name: String(event ?? 'unknown') }
  let payload: { ref?: unknown; repository?: { full_name?: unknown } }
  try {
    const text = String(headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')
      ? (new URLSearchParams(raw.toString('utf8')).get('payload') ?? '')
      : raw.toString('utf8')
    payload = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, code: 'invalid_request', message: 'The payload is not valid JSON' }
  }
  const repo = payload.repository?.full_name
  return {
    ok: true,
    event: 'push',
    ref: typeof payload.ref === 'string' ? payload.ref : '',
    ...(typeof repo === 'string' && { repo }),
  }
}
