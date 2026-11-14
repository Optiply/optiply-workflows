import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * A fake npm registry for tests (M25): the packages given, packed by `npm pack` here (no network), served as
 * packuments and tarballs the way registry.npmjs.org does. `requests` lists the paths asked for.
 */

export interface TestPackage {
  name: string
  version: string
  /** Files by path inside the package; `package.json` is written from the fields above. */
  files: Record<string, string>
  dependencies?: Record<string, string>
  /** Install scripts, to check they never run. */
  scripts?: Record<string, string>
}

export interface TestRegistry {
  url: string
  requests: string[]
  /** The Authorization header of each request (M33), in order. */
  authorizations: (string | undefined)[]
  stop(): Promise<void>
}

const run = promisify(execFile)

/**
 * With `token` (M33), every request needs `Authorization: Bearer <token>` (401 without it, 403 with another), and
 * `/-/whoami` answers `{ username: 'ci' }`, as a private registry does.
 */
export async function startTestRegistry(
  packages: TestPackage[],
  opts: {
    token?: string
    /** Serve to containers (M37's builder): listen on every address, links through `host.docker.internal`. */
    forContainers?: boolean
  } = {},
): Promise<TestRegistry> {
  const work = await mkdtemp(join(tmpdir(), 'ow-npm-registry-'))
  const tarballs = new Map<string, Buffer>()
  const packuments = new Map<
    string,
    { name: string; 'dist-tags': { latest: string }; versions: Record<string, unknown> }
  >()
  const server = createServer()
  await new Promise<void>((resolve) =>
    server.listen(0, opts.forContainers ? '0.0.0.0' : '127.0.0.1', resolve),
  )
  const host = opts.forContainers ? 'host.docker.internal' : '127.0.0.1'
  const url = `http://${host}:${(server.address() as AddressInfo).port}`

  for (const pkg of packages) {
    const dir = join(work, 'src', pkg.name, pkg.version)
    for (const [path, content] of Object.entries(pkg.files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      main: 'index.js',
      ...(pkg.dependencies && { dependencies: pkg.dependencies }),
      ...(pkg.scripts && { scripts: pkg.scripts }),
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    const out = join(work, 'packed')
    await mkdir(out, { recursive: true })
    const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: work, npm_config_update_notifier: 'false' },
    })
    const [packed] = JSON.parse(stdout) as { filename: string }[]
    const tgz = await readFile(join(out, packed!.filename))
    const file = `${pkg.name.replace('/', '-')}-${pkg.version}.tgz`
    tarballs.set(`/${pkg.name}/-/${file}`, tgz)
    const packument = packuments.get(pkg.name) ?? {
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: {},
    }
    packument.versions[pkg.version] = {
      ...manifest,
      dist: {
        tarball: `${url}/${pkg.name}/-/${file}`,
        shasum: createHash('sha1').update(tgz).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
      },
    }
    // The highest version is the latest.
    const versions = Object.keys(packument.versions).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )
    packument['dist-tags'].latest = versions.at(-1)!
    packuments.set(pkg.name, packument)
  }

  const requests: string[] = []
  const authorizations: (string | undefined)[] = []
  server.on('request', (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    requests.push(path)
    authorizations.push(req.headers.authorization)
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(req.headers.authorization ? 403 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    if (path === '/-/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ username: 'ci' }))
      return
    }
    const tgz = tarballs.get(path)
    if (tgz) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tgz.length })
      res.end(tgz)
      return
    }
    const packument = packuments.get(path.slice(1))
    if (packument) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(packument))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  return {
    url,
    requests,
    authorizations,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(work, { recursive: true, force: true })
    },
  }
}
