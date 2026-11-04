import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanEnv = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/** A scratch directory, removed by `cleanup`. */
export async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ow-git-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** An empty bare repo to push to, like a new GitHub repo. */
export function bareRepo(path: string): string {
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', path], { env: cleanEnv })
  return path
}

/** A hook on the remote that refuses every push to `branch`, like GitHub's branch protection. */
export async function protectBranch(repoPath: string, branch: string): Promise<void> {
  const hook = join(repoPath, 'hooks', 'pre-receive')
  await writeFile(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/${branch}" ]; then echo "protected branch hook declined" >&2; exit 1; fi\ndone\n`,
    { mode: 0o755 },
  )
}

/**
 * Serves the bare repos under `root` over smart HTTP (`git http-backend` as CGI), asking for basic auth with the
 * user `x-access-token` and `token`, as GitHub does for tokens.
 */
export async function gitHttpServer(
  root: string,
  token: string,
  /** Where to listen; 0.0.0.0 to serve containers too (a Compose check). */
  host = '127.0.0.1',
  /** The username it takes with the token: GitHub's, or GitLab's `oauth2` (M31). */
  username = 'x-access-token',
): Promise<{
  url: string
  port: number
  requests: { authorized: number; refused: number }
  close: () => Promise<void>
}> {
  const backend = join(
    execFileSync('git', ['--exec-path'], { env: cleanEnv }).toString().trim(),
    'git-http-backend',
  )
  const expected = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
  const requests = { authorized: 0, refused: 0 }
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      requests.refused++
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end('Unauthorized')
      return
    }
    requests.authorized++
    const url = new URL(req.url ?? '/', 'http://localhost')
    const child = spawn(backend, [], {
      env: {
        ...cleanEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        REMOTE_USER: 'x-access-token',
        REMOTE_ADDR: '127.0.0.1',
      },
    })
    req.pipe(child.stdin)
    let head = Buffer.alloc(0)
    let headersSent = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) return void res.write(chunk)
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      let status = 200
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const [name, ...rest] = line.split(':')
        const value = rest.join(':').trim()
        if (name!.toLowerCase() === 'status') status = Number.parseInt(value, 10)
        else res.setHeader(name!, value)
      }
      res.writeHead(status)
      headersSent = true
      res.write(head.subarray(end + 4))
    })
    child.on('close', () => res.end())
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
