import { execFileSync } from 'node:child_process'
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
export async function fakeGitHub(opts: { repoPath: string; owner: string; repo: string; token: string }) {
  const pulls: FakePull[] = []
  const calls: string[] = []
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
    return commit
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
    if (req.headers.authorization !== `Bearer ${opts.token}`)
      return send(res, 401, { message: 'Bad credentials' })
    const prefix = `/repos/${opts.owner}/${opts.repo}`
    if (!url.pathname.startsWith(prefix)) return send(res, 404, { message: 'Not Found' })
    const path = url.pathname.slice(prefix.length)
    const now = new Date().toISOString()

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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    pulls,
    calls,
    merge,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
