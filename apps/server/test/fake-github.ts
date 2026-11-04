import { execFileSync } from 'node:child_process'
import { createHmac, createPublicKey, verify } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'GitHub',
  GIT_AUTHOR_EMAIL: 'noreply@github.com',
  GIT_COMMITTER_NAME: 'GitHub',
  GIT_COMMITTER_EMAIL: 'noreply@github.com',
}

export interface FakePull {
  number: number
  title: string
  body: string
  head: string
  base: string
  state: 'open' | 'closed'
  mergedAt: string | null
  updatedAt: string
}

/**
 * The slice of GitHub's REST API the instance uses (pull requests), over a local bare repo: listing, opening and
 * reading pull requests, and merging them for real (`git merge-tree` + a merge commit on the base branch), so a
 * test can play the reviewer. Every call needs `Authorization: Bearer <token>`.
 */
export async function fakeGitHub(opts: {
  repoPath: string
  owner: string
  repo: string
  token: string
  /** Where to listen; 0.0.0.0 to serve containers too (a Compose check). */
  host?: string
  /**
   * A GitHub App installed on the repo (M31): its JWT checked with `publicKey`, installation tokens (`ghs_…`) minted
   * for `tokenTtlMs` and taken by the pull request calls like the token.
   */
  app?: {
    id: string
    publicKey: string
    installationId?: number
    account?: string
    slug?: string
    permissions?: Record<string, string>
    tokenTtlMs?: number
  }
}) {
  /** Installation tokens minted, and when each expires (ms). */
  const appTokens = new Map<string, number>()
  let minted = 0
  const appJwtValid = (authorization: string | undefined): boolean => {
    if (!opts.app || !authorization?.startsWith('Bearer ')) return false
    const [header, payload, signature] = authorization.slice('Bearer '.length).split('.')
    if (!header || !payload || !signature) return false
    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey(opts.app.publicKey),
      Buffer.from(signature, 'base64url'),
    )
    if (!ok) return false
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iss?: string; exp?: number }
    return claims.iss === opts.app.id && (claims.exp ?? 0) * 1000 > Date.now()
  }
  const repoAuthorized = (authorization: string | undefined): boolean => {
    if (authorization === `Bearer ${opts.token}`) return true
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    return (appTokens.get(token) ?? 0) > Date.now()
  }
  const pulls: FakePull[] = []
  const calls: string[] = []
  /** Where merges send a signed push webhook, like a repo webhook on GitHub (set with `POST /_test/webhook`). */
  let webhook: { url: string; secret: string } | null = null
  const git = (...args: string[]) =>
    execFileSync('git', ['--git-dir', opts.repoPath, ...args], { env: gitEnv })
      .toString()
      .trim()
  const ref = (branch: string) => {
    try {
      return git('rev-parse', '--verify', `refs/heads/${branch}`)
    } catch {
      return null
    }
  }
  const view = (p: FakePull) => ({
    number: p.number,
    html_url: `https://github.com/${opts.owner}/${opts.repo}/pull/${p.number}`,
    title: p.title,
    body: p.body,
    state: p.state,
    merged_at: p.mergedAt,
    draft: false,
    head: { ref: p.head },
    base: { ref: p.base },
    updated_at: p.updatedAt,
  })

  /** Merges a pull request like GitHub's merge button: a merge commit on the base branch. */
  const merge = (number: number): string => {
    const pull = pulls.find((p) => p.number === number)
    if (pull?.state !== 'open') throw new Error(`Pull request #${number} isn't open`)
    const base = ref(pull!.base)
    const head = ref(pull!.head)
    if (!base || !head) throw new Error('Missing branch')
    const tree = git('merge-tree', '--write-tree', base, head).split('\n')[0]!
    const commit = git(
      'commit-tree',
      tree,
      '-p',
      base,
      '-p',
      head,
      '-m',
      `Merge pull request #${number} from ${opts.owner}/${pull.head}\n\n${pull.title}`,
    )
    git('update-ref', `refs/heads/${pull.base}`, commit, base)
    pull.state = 'closed'
    pull.mergedAt = new Date().toISOString()
    pull.updatedAt = pull.mergedAt
    if (webhook) void deliverPush(webhook, pull.base, commit)
    return commit
  }

  const deliverPush = async (target: { url: string; secret: string }, branch: string, after: string) => {
    const body = JSON.stringify({ ref: `refs/heads/${branch}`, after })
    const signature = `sha256=${createHmac('sha256', target.secret).update(body).digest('hex')}`
    await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
      body,
    }).catch(() => {})
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    calls.push(`${req.method} ${url.pathname}${url.search}`)
    // Test controls (no auth): play the reviewer from another process, e.g. a Playwright spec.
    const testMerge = /^\/_test\/pulls\/(\d+)\/merge$/.exec(url.pathname)
    if (req.method === 'POST' && testMerge) {
      try {
        return send(res, 200, { commit: merge(Number(testMerge[1])) })
      } catch (err) {
        return send(res, 409, { message: (err as Error).message })
      }
    }
    if (req.method === 'POST' && url.pathname === '/_test/webhook') {
      const body = (await readBody(req)) as { url?: string; secret?: string }
      webhook = body.url && body.secret ? { url: body.url, secret: body.secret } : null
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/_test/pulls') return send(res, 200, pulls)
    // The App's tokens expire now (a test of minting again).
    if (req.method === 'POST' && url.pathname === '/_test/expire-app-tokens') {
      for (const token of appTokens.keys()) appTokens.set(token, 0)
      return send(res, 200, { ok: true })
    }
    const prefix = `/repos/${opts.owner}/${opts.repo}`
    // A GitHub App (M31): its installation on the repo, and installation tokens, for the App's JWT.
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(url.pathname)) {
      if (!appJwtValid(req.headers.authorization))
        return send(res, 401, { message: 'A JSON web token could not be decoded' })
      if (url.pathname !== `${prefix}/installation`) return send(res, 404, { message: 'Not Found' })
      return send(res, 200, {
        id: opts.app!.installationId ?? 77,
        account: { login: opts.app!.account ?? opts.owner },
        app_slug: opts.app!.slug ?? 'optiply-sync',
        permissions: opts.app!.permissions ?? { contents: 'write', pull_requests: 'write', metadata: 'read' },
      })
    }
    const tokens = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
    if (req.method === 'POST' && tokens) {
      if (!appJwtValid(req.headers.authorization))
        return send(res, 401, { message: 'A JSON web token could not be decoded' })
      if (Number(tokens[1]) !== (opts.app!.installationId ?? 77))
        return send(res, 404, { message: 'Not Found' })
      const token = `ghs_installation${++minted}`
      const expiresAt = Date.now() + (opts.app!.tokenTtlMs ?? 3_600_000)
      appTokens.set(token, expiresAt)
      calls.push(`minted ${token}`)
      return send(res, 201, { token, expires_at: new Date(expiresAt).toISOString() })
    }
    if (!repoAuthorized(req.headers.authorization)) return send(res, 401, { message: 'Bad credentials' })
    if (!url.pathname.startsWith(prefix)) return send(res, 404, { message: 'Not Found' })
    const path = url.pathname.slice(prefix.length)
    const now = new Date().toISOString()

    if (req.method === 'GET' && path === '') {
      return send(res, 200, {
        full_name: `${opts.owner}/${opts.repo}`,
        permissions: { admin: false, push: true, pull: true },
      })
    }

    if (req.method === 'GET' && path === '/pulls') {
      const head = url.searchParams.get('head')
      const base = url.searchParams.get('base')
      const state = url.searchParams.get('state') ?? 'open'
      const found = pulls
        .filter((p) => (!head || `${opts.owner}:${p.head}` === head) && (!base || p.base === base))
        .filter((p) => state === 'all' || p.state === state)
        .sort((a, b) => b.number - a.number)
      return send(res, 200, found.map(view))
    }
    if (req.method === 'POST' && path === '/pulls') {
      const body = (await readBody(req)) as { title: string; head: string; base: string; body?: string }
      if (!ref(body.head) || !ref(body.base)) {
        return send(res, 422, {
          message: 'Validation Failed',
          errors: [{ message: `No branch ${body.head}` }],
        })
      }
      if (pulls.some((p) => p.head === body.head && p.base === body.base && p.state === 'open')) {
        return send(res, 422, {
          message: 'Validation Failed',
          errors: [{ message: `A pull request already exists for ${opts.owner}:${body.head}.` }],
        })
      }
      const pull: FakePull = {
        number: pulls.length + 1,
        title: body.title,
        body: body.body ?? '',
        head: body.head,
        base: body.base,
        state: 'open',
        mergedAt: null,
        updatedAt: now,
      }
      pulls.push(pull)
      return send(res, 201, view(pull))
    }
    const one = /^\/pulls\/(\d+)$/.exec(path)
    if (req.method === 'GET' && one) {
      const pull = pulls.find((p) => p.number === Number(one[1]))
      return pull ? send(res, 200, view(pull)) : send(res, 404, { message: 'Not Found' })
    }
    return send(res, 404, { message: 'Not Found' })
  })
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    pulls,
    calls,
    merge,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
