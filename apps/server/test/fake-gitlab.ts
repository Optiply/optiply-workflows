import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'GitLab',
  GIT_AUTHOR_EMAIL: 'noreply@gitlab.com',
  GIT_COMMITTER_NAME: 'GitLab',
  GIT_COMMITTER_EMAIL: 'noreply@gitlab.com',
}

export interface FakeMergeRequest {
  iid: number
  title: string
  description: string
  source: string
  target: string
  state: 'opened' | 'closed' | 'merged'
  updatedAt: string
}

/**
 * The slice of GitLab's REST API (v4) the instance uses (M31): listing, opening and reading a project's merge requests,
 * over a local bare repo, and merging them for real (`git merge-tree` + a merge commit on the target branch), so a
 * test can play the reviewer. Every call needs `PRIVATE-TOKEN: <token>`; the project is its full path (URL-encoded,
 * nested groups allowed), as GitLab takes it.
 */
export async function fakeGitLab(opts: {
  repoPath: string
  /** `group/subgroup/project`. */
  project: string
  token: string
  host?: string
}) {
  const mergeRequests: FakeMergeRequest[] = []
  const calls: string[] = []
  /** Where merges send a push webhook, like a project webhook on GitLab (set with `POST /_test/webhook`). */
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
  const view = (m: FakeMergeRequest) => ({
    iid: m.iid,
    id: 1000 + m.iid,
    web_url: `https://gitlab.com/${opts.project}/-/merge_requests/${m.iid}`,
    title: m.title,
    description: m.description,
    state: m.state,
    draft: m.title.startsWith('Draft:'),
    source_branch: m.source,
    target_branch: m.target,
    updated_at: m.updatedAt,
    merged_at: m.state === 'merged' ? m.updatedAt : null,
  })

  /** Merges a merge request like GitLab's Merge button: a merge commit on the target branch. */
  const merge = (iid: number): string => {
    const mr = mergeRequests.find((m) => m.iid === iid)
    if (mr?.state !== 'opened') throw new Error(`Merge request !${iid} isn't open`)
    const target = ref(mr.target)
    const source = ref(mr.source)
    if (!target || !source) throw new Error('Missing branch')
    const tree = git('merge-tree', '--write-tree', target, source).split('\n')[0]!
    const commit = git(
      'commit-tree',
      tree,
      '-p',
      target,
      '-p',
      source,
      '-m',
      `Merge branch '${mr.source}' into '${mr.target}'\n\n${mr.title}\n\nSee merge request ${opts.project}!${iid}`,
    )
    git('update-ref', `refs/heads/${mr.target}`, commit, target)
    mr.state = 'merged'
    mr.updatedAt = new Date().toISOString()
    if (webhook) void deliverPush(webhook, mr.target, commit)
    return commit
  }

  const deliverPush = async (target: { url: string; secret: string }, branch: string, after: string) => {
    await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-token': target.secret,
      },
      body: JSON.stringify({ object_kind: 'push', ref: `refs/heads/${branch}`, after }),
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
    // GitLab takes the project's path URL-encoded: keep the raw path to tell `%2F` from `/`.
    const rawPath = (req.url ?? '/').split('?')[0]!
    const url = new URL(req.url ?? '/', 'http://localhost')
    calls.push(`${req.method} ${rawPath}${url.search}`)
    const testMerge = /^\/_test\/merge_requests\/(\d+)\/merge$/.exec(rawPath)
    if (req.method === 'POST' && testMerge) {
      try {
        return send(res, 200, { commit: merge(Number(testMerge[1])) })
      } catch (err) {
        return send(res, 409, { message: (err as Error).message })
      }
    }
    if (req.method === 'POST' && rawPath === '/_test/webhook') {
      const body = (await readBody(req)) as { url?: string; secret?: string }
      webhook = body.url && body.secret ? { url: body.url, secret: body.secret } : null
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && rawPath === '/_test/merge_requests') return send(res, 200, mergeRequests)
    if (req.headers['private-token'] !== opts.token) return send(res, 401, { message: '401 Unauthorized' })
    const prefix = `/projects/${encodeURIComponent(opts.project)}`
    if (!rawPath.startsWith(`${prefix}/`)) return send(res, 404, { message: '404 Project Not Found' })
    const path = rawPath.slice(prefix.length)
    const now = new Date().toISOString()

    if (req.method === 'GET' && path === '/merge_requests') {
      const source = url.searchParams.get('source_branch')
      const target = url.searchParams.get('target_branch')
      const state = url.searchParams.get('state') ?? 'all'
      const found = mergeRequests
        .filter((m) => (!source || m.source === source) && (!target || m.target === target))
        .filter((m) => state === 'all' || m.state === state)
        .sort((a, b) => b.iid - a.iid)
      return send(res, 200, found.map(view))
    }
    if (req.method === 'POST' && path === '/merge_requests') {
      const body = (await readBody(req)) as {
        source_branch: string
        target_branch: string
        title: string
        description?: string
      }
      if (!ref(body.source_branch) || !ref(body.target_branch))
        return send(res, 400, { message: { source_branch: ['is invalid'] } })
      const open = mergeRequests.find(
        (m) => m.source === body.source_branch && m.target === body.target_branch && m.state === 'opened',
      )
      if (open)
        return send(res, 409, {
          message: [`Another open merge request already exists for this source branch: !${open.iid}`],
        })
      const mr: FakeMergeRequest = {
        iid: mergeRequests.length + 1,
        title: body.title,
        description: body.description ?? '',
        source: body.source_branch,
        target: body.target_branch,
        state: 'opened',
        updatedAt: now,
      }
      mergeRequests.push(mr)
      return send(res, 201, view(mr))
    }
    const one = /^\/merge_requests\/(\d+)$/.exec(path)
    if (req.method === 'GET' && one) {
      const mr = mergeRequests.find((m) => m.iid === Number(one[1]))
      return mr ? send(res, 200, view(mr)) : send(res, 404, { message: '404 Not found' })
    }
    return send(res, 404, { error: '404 Not Found' })
  })
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    mergeRequests,
    calls,
    merge,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
