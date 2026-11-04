import { createHash, createPrivateKey, type KeyObject, sign } from 'node:crypto'
import type { GitHubTarget } from './github'
import { GitHostError } from './types'

/**
 * A GitHub App's sign-in for one repo (M31): a JWT signed with the App's private key finds the App's installation on
 * the repo, and installation tokens (an hour long, limited to the repo) are minted from it when needed. Tokens are
 * kept per process until 5 minutes before they expire, and minted again when GitHub refuses one (`refresh`).
 */
export interface GitHubAppInstallation {
  id: number
  account: string
  appSlug: string | null
  /** What the installation was granted, e.g. `{contents: 'write', pull_requests: 'write', metadata: 'read'}`. */
  permissions: Record<string, string>
}

/** What Git sync needs of the App: to read and push the repo, and to open pull requests. */
export const APP_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const

const REFRESH_BEFORE_MS = 5 * 60_000

interface Cached {
  installation?: Promise<GitHubAppInstallation>
  token?: { value: string; expiresAt: number }
  minting?: Promise<string>
}
const cache = new Map<string, Cached>()

/** Checks a private key the App gave (PEM, PKCS#1 or PKCS#8): the key object, or why it isn't one. */
export function appPrivateKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'rsa') throw new Error(`it's an ${key.asymmetricKeyType} key`)
    return key
  } catch (err) {
    throw new GitHostError(
      'invalid',
      `The GitHub App's private key isn't an RSA private key in PEM: ${(err as Error).message}`,
    )
  }
}

/** The App's JWT (RS256): issued 60 s back (clock drift), good for 9 minutes (GitHub allows 10). */
export function appJwt(appId: string, key: KeyObject, now = Date.now()): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const seconds = Math.floor(now / 1000)
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`
  return `${body}.${sign('sha256', Buffer.from(body), key).toString('base64url')}`
}

export class GitHubAppTokens {
  private readonly key: KeyObject
  private readonly cached: Cached

  constructor(
    private readonly target: GitHubTarget,
    private readonly appId: string,
    privateKeyPem: string,
  ) {
    this.key = appPrivateKey(privateKeyPem)
    const id = createHash('sha256')
      .update([target.api, target.owner, target.repo, appId, privateKeyPem].join('\n'))
      .digest('hex')
    let cached = cache.get(id)
    if (!cached) {
      cached = {}
      cache.set(id, cached)
    }
    this.cached = cached
  }

  /** The App's installation on the repo (found once per process; again after a failure). */
  installation(): Promise<GitHubAppInstallation> {
    this.cached.installation ??= this.request<{
      id: number
      account?: { login?: string }
      app_slug?: string
      permissions?: Record<string, string>
    }>('GET', `/repos/${this.target.owner}/${this.target.repo}/installation`, undefined, 'installation').then(
      (i) => ({
        id: i.id,
        account: i.account?.login ?? '',
        appSlug: i.app_slug ?? null,
        permissions: i.permissions ?? {},
      }),
    )
    this.cached.installation.catch(() => {
      this.cached.installation = undefined
    })
    return this.cached.installation
  }

  /** An installation token good for at least 5 more minutes; `refresh` mints a new one (GitHub refused the last). */
  async token(opts: { refresh?: boolean } = {}): Promise<string> {
    const held = this.cached.token
    if (!opts.refresh && held && held.expiresAt - REFRESH_BEFORE_MS > Date.now()) return held.value
    if (opts.refresh) this.cached.token = undefined
    this.cached.minting ??= this.mint().finally(() => {
      this.cached.minting = undefined
    })
    return this.cached.minting
  }

  private async mint(): Promise<string> {
    const installation = await this.installation()
    const minted = await this.request<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${installation.id}/access_tokens`,
      { repositories: [this.target.repo], permissions: APP_PERMISSIONS },
      'token',
    )
    this.cached.token = { value: minted.token, expiresAt: Date.parse(minted.expires_at) }
    return minted.token
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    doing: 'installation' | 'token',
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.target.api}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${appJwt(this.appId, this.key)}`,
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
    let json: { message?: string } | null = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (res.ok) return json as T
    const said = `GitHub said ${res.status}${json?.message ? `: ${json.message}` : ''}`
    const repo = `${this.target.owner}/${this.target.repo}`
    if (res.status === 401)
      throw new GitHostError('auth', `${said}. Check the GitHub App's id and private key`)
    if (res.status === 404 && doing === 'installation')
      throw new GitHostError(
        'not_found',
        `${said}. The GitHub App isn't installed on ${repo}: install it there (Contents and Pull requests: read and write)`,
      )
    if (res.status === 403 || res.status === 422)
      throw new GitHostError(
        'auth',
        `${said}. The App's installation needs Contents and Pull requests (read and write) on ${repo}`,
      )
    throw new GitHostError('failed', said)
  }
}

/** The permissions Git sync needs that an installation lacks, as "contents: write". */
export function missingAppPermissions(granted: Record<string, string>): string[] {
  const rank = (level: string | undefined) =>
    level === 'write' || level === 'admin' ? 2 : level === 'read' ? 1 : 0
  return Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => rank(granted[name]) < rank(level))
    .map(([name, level]) => `${name}: ${level}`)
}

/** Forgets every App's tokens and installations (tests; and when the settings change). */
export function forgetGitHubAppTokens(): void {
  cache.clear()
}
