import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import {
  type GitHost,
  type GitHostCheck,
  GitHostError,
  type GitWebhookCheck,
  type PullRequestView,
} from './types'

/** GitLab's role levels: Developer can push and open merge requests; Maintainer may push to protected branches. */
const ROLES: Record<number, string> = {
  10: 'Guest',
  15: 'Planner',
  20: 'Reporter',
  30: 'Developer',
  40: 'Maintainer',
  50: 'Owner',
}

/** Where a project's API is, and its full path (`group/subgroup/project`). */
export interface GitLabTarget {
  api: string
  project: string
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * GitLab's API for a repo URL (M31): `<origin>/api/v4` for gitlab.com and self-managed instances, `apiUrl` for one under
 * a path (`https://example.com/gitlab/api/v4`: the path before `/api/v4` is left out of the project's), or
 * `apiOverride` (`GITLAB_API_URL`, for tests). The project is the URL's path (nested groups allowed). Null when the URL
 * can't be a GitLab project.
 */
export function gitlabTarget(
  repoUrl: string,
  apiUrl?: string | null,
  apiOverride?: string,
): GitLabTarget | null {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    return null
  }
  let path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
  let api: string | null = null
  if (apiOverride) api = apiOverride.replace(/\/+$/, '')
  else if (apiUrl) {
    let base: URL
    try {
      base = new URL(apiUrl)
    } catch {
      return null
    }
    // Its own server only (the token goes there), over https, or the repo's own http (insecure URLs allowed).
    if (base.origin !== url.origin || (base.protocol !== 'https:' && base.protocol !== url.protocol))
      return null
    api = `${base.origin}${base.pathname.replace(/\/+$/, '')}`
    const prefix = base.pathname.replace(/\/+$/, '').replace(/\/api\/v4$/, '')
    if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length)
  } else if (url.protocol === 'https:') api = `${url.origin}/api/v4`
  const parts = path.split('/').filter(Boolean)
  if (!api || parts.length < 2 || !parts.every((p) => SEGMENT.test(p))) return null
  return { api, project: parts.join('/') }
}

interface RawMergeRequest {
  iid: number
  web_url: string
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft?: boolean
  work_in_progress?: boolean
  source_branch: string
  target_branch: string
  updated_at: string
}

const view = (m: RawMergeRequest): PullRequestView => ({
  kind: 'merge',
  number: m.iid,
  url: m.web_url,
  title: m.title,
  state: m.state === 'opened' ? 'open' : 'closed',
  merged: m.state === 'merged',
  draft: m.draft ?? m.work_in_progress ?? false,
  head: m.source_branch,
  base: m.target_branch,
  updatedAt: m.updated_at,
})

/**
 * GitLab's merge requests (M31), with a project, group or personal access token (`PRIVATE-TOKEN`). Redirects are
 * refused, so the token stays put.
 */
export class GitLabHost implements GitHost {
  readonly kind = 'gitlab' as const

  constructor(
    private readonly target: GitLabTarget,
    private readonly token: () => Promise<string | null>,
  ) {}

  /** The newest merge request from `branch` into `base`, an open one first; null when there's none. */
  async findChangeRequest(branch: string, base: string): Promise<PullRequestView | null> {
    const query = new URLSearchParams({
      source_branch: branch,
      target_branch: base,
      state: 'all',
      order_by: 'created_at',
      sort: 'desc',
      per_page: '10',
    })
    const found = await this.request<RawMergeRequest[]>('GET', `/merge_requests?${query}`)
    const pick = found.find((m) => m.state === 'opened') ?? found[0]
    return pick ? view(pick) : null
  }

  /** Opens a merge request, or returns the one already open for the branch (`created` false). */
  async openChangeRequest(opts: {
    branch: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestView & { created: boolean }> {
    const existing = await this.findChangeRequest(opts.branch, opts.base)
    if (existing?.state === 'open') return { ...existing, created: false }
    const created = await this.request<RawMergeRequest>('POST', '/merge_requests', {
      source_branch: opts.branch,
      target_branch: opts.base,
      title: opts.title,
      description: opts.body,
    })
    return { ...view(created), created: true }
  }

  async getChangeRequest(number: number): Promise<PullRequestView> {
    return view(await this.request<RawMergeRequest>('GET', `/merge_requests/${number}`))
  }

  async check(): Promise<GitHostCheck> {
    const project = await this.request<{
      path_with_namespace: string
      permissions?: {
        project_access?: { access_level?: number } | null
        group_access?: { access_level?: number } | null
      }
    }>('GET', '')
    const level = Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    )
    const problems: string[] = []
    if (level && level < 30)
      problems.push(
        `The token's role is ${ROLES[level] ?? level}: it needs Developer (Maintainer for protected branches)`,
      )
    // The token's scopes, where GitLab tells (personal, project and group tokens; not every version).
    const scopes = await this.request<{ scopes?: string[] }>(
      'GET',
      '/personal_access_tokens/self',
      undefined,
      '',
    )
      .then((t) => t.scopes)
      .catch(() => undefined)
    if (scopes && !scopes.includes('api')) problems.push('The token needs the api scope (for merge requests)')
    if (scopes && !scopes.includes('write_repository') && !scopes.includes('api'))
      problems.push('The token needs the write_repository scope (to push)')
    return {
      message: `GitLab: ${project.path_with_namespace}${level ? ` (${ROLES[level] ?? level})` : ''}`,
      problems,
    }
  }

  /** `base`: the project's API (the default), or '' for the instance's own (`/personal_access_tokens/self`). */
  private async request<T>(method: string, path: string, body?: unknown, base?: string): Promise<T> {
    const token = await this.token()
    if (!token)
      throw new GitHostError(
        'auth',
        'Set a GitLab access token in the Git settings to work with merge requests',
      )
    const { api, project } = this.target
    let res: Response
    try {
      res = await fetch(`${api}${base ?? `/projects/${encodeURIComponent(project)}`}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/json',
          'private-token': token,
          'user-agent': 'optiply-workflows',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new GitHostError('failed', `GitLab didn't answer: ${(err as Error).message}`)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (res.ok) return json as T
    const said = `GitLab said ${res.status}${detail(json) ? `: ${detail(json)}` : ''}`
    if (res.status === 401 || res.status === 403)
      throw new GitHostError(
        'auth',
        `${said}. The token needs the api scope and at least the Developer role on the project`,
      )
    if (res.status === 404)
      throw new GitHostError(
        'not_found',
        `${said}. Is the repo URL right, and can the token see the project?`,
      )
    if (res.status === 400 || res.status === 409 || res.status === 422)
      throw new GitHostError('invalid', said)
    throw new GitHostError('failed', said)
  }
}

/** GitLab's error bodies: `{message}` as a string, a list, or fields with lists; or `{error}`. */
function detail(json: unknown): string {
  const body = (json ?? {}) as { message?: unknown; error?: unknown }
  const message = body.message ?? body.error
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.map(String).join('; ')
  if (message && typeof message === 'object')
    return Object.entries(message)
      .map(([field, v]) => `${field} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join('; ')
  return ''
}

/**
 * GitLab's push webhook (M31): `X-Gitlab-Token` is the webhook's secret token, compared in constant time (GitLab
 * doesn't sign the body). `Push Hook` deploys by its ref (GitLab's "Test → Push events" sends one too); other events
 * are acknowledged and ignored.
 */
export function checkGitLabWebhook(
  secret: string,
  headers: IncomingHttpHeaders,
  raw: Buffer,
): GitWebhookCheck {
  const given = Buffer.from(String(headers['x-gitlab-token'] ?? ''))
  const expected = Buffer.from(secret)
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, status: 401, code: 'bad_signature', message: 'The webhook token does not match' }
  const event = String(headers['x-gitlab-event'] ?? 'unknown')
  if (event !== 'Push Hook') return { ok: true, event: 'other', name: event }
  let payload: { ref?: unknown; project?: { path_with_namespace?: unknown } }
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, status: 400, code: 'invalid_request', message: 'The payload is not valid JSON' }
  }
  const repo = payload.project?.path_with_namespace
  return {
    ok: true,
    event: 'push',
    ref: typeof payload.ref === 'string' ? payload.ref : '',
    ...(typeof repo === 'string' && { repo }),
  }
}
