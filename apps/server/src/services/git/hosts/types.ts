import type { GitHostKind } from '@ow/db'

export type { GitHostKind }

/** A pull request (GitHub) or merge request (GitLab) as the instance shows it. */
export interface PullRequestView {
  /** Which the host calls it: the UI says "pull request" or "merge request". */
  kind: 'pull' | 'merge'
  /** GitHub's number, GitLab's iid: what the host's own pages show. */
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

export type GitHostErrorKind = 'auth' | 'not_found' | 'unsupported' | 'invalid' | 'failed'

/** A host's API refusing or failing, in its own words and with what to change. */
export class GitHostError extends Error {
  constructor(
    readonly kind: GitHostErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'GitHostError'
  }
}

/** What git signs in to the remote with (askpass): GitHub's `x-access-token`, GitLab's `oauth2`. */
export interface GitCredentials {
  username: string
  token: string
}

/**
 * A Git host's API, as Git sync uses it (M31): pull or merge requests for Commit with protection, Promote and the
 * branch drafts. Callers don't know which host it is.
 */
export interface GitHost {
  readonly kind: GitHostKind
  /** The newest request from `branch` into `base`, an open one first; null when there's none. */
  findChangeRequest(branch: string, base: string): Promise<PullRequestView | null>
  /** Opens a request, or returns the one already open for the branch (`created` false). */
  openChangeRequest(opts: {
    branch: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestView & { created: boolean }>
  getChangeRequest(number: number): Promise<PullRequestView>
}

/** A push webhook delivery, checked: refused, or what it is. */
export type GitWebhookCheck =
  | { ok: false; status: 400 | 401; code: string; message: string }
  | { ok: true; event: 'ping' }
  | { ok: true; event: 'push'; ref: string }
  | { ok: true; event: 'other'; name: string }
