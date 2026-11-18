/**
 * A Python package index for tests (M23): wheels made here, served as a PEP 503 "simple" index on a local port, so
 * the builder's tests and the e2e need no PyPI. Only what pip reads: `/simple/<name>/` pages linking the files with
 * their sha256, and the files.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { crc32, gzipSync } from 'node:zlib'

export interface TestPackage {
  name: string
  version: string
  /** The package's modules: path in the wheel → source (`owtest_a/__init__.py`). */
  files?: Record<string, string>
  /** `Requires-Dist` lines (`owtest-b>=1`). */
  requires?: string[]
  /** Served as an sdist only (a `.tar.gz` pip won't take with `--only-binary`), and not a real one: unbuildable. */
  sdistOnly?: boolean
  /**
   * Served as a real sdist only (M32): its build backend is in the sdist (`backend-path`), so building it needs
   * nothing but `buildRequires` (its `build-system.requires`). `dynamicRequires` are asked for at build time without
   * being declared; `hook` is Python run at build time (in the builder's jail) with `files` (path → text) to add to.
   */
  sdist?: { buildRequires?: string[]; dynamicRequires?: string[]; hook?: string; wheelName?: string }
  /** Its index page answers this late the first time: a build that holds the builder's slot a while. */
  delayMs?: number
}

export interface TestIndex {
  /** The index as the builder's container reaches it (through `host.docker.internal`). */
  url: string
  /** The index from this process. */
  localUrl: string
  /** The sha256 of each package's file, by `name==version`. */
  hashes: Record<string, string>
  stop(): Promise<void>
}

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')
const sha256 = (data: Buffer, encoding: 'hex' | 'base64url' = 'hex') =>
  createHash('sha256').update(data).digest(encoding)

/** A pure-Python wheel (`<name>-<version>-py3-none-any.whl`): a zip of the files, the metadata and its RECORD. */
export function buildWheel(pkg: TestPackage): { filename: string; data: Buffer } {
  const dist = `${pkg.name.replace(/[-.]+/g, '_')}-${pkg.version}`
  const files: [string, Buffer][] = Object.entries(pkg.files ?? {}).map(([path, text]) => [
    path,
    Buffer.from(text),
  ])
  const metadata = [
    'Metadata-Version: 2.1',
    `Name: ${pkg.name}`,
    `Version: ${pkg.version}`,
    ...(pkg.requires ?? []).map((r) => `Requires-Dist: ${r}`),
    '',
  ].join('\n')
  files.push([`${dist}.dist-info/METADATA`, Buffer.from(metadata)])
  files.push([
    `${dist}.dist-info/WHEEL`,
    Buffer.from('Wheel-Version: 1.0\nGenerator: ow-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n'),
  ])
  const record = [
    ...files.map(([path, data]) => `${path},sha256=${sha256(data, 'base64url')},${data.length}`),
    `${dist}.dist-info/RECORD,,`,
    '',
  ].join('\n')
  files.push([`${dist}.dist-info/RECORD`, Buffer.from(record)])
  return { filename: `${dist}-py3-none-any.whl`, data: zip(files) }
}

/** The build backend in every test sdist: a wheel of `ow_meta.json`'s files, after the test's hook. */
const SDIST_BACKEND = `import base64, hashlib, json, os, zipfile

def _meta():
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ow_meta.json")) as f:
        return json.load(f)

def get_requires_for_build_wheel(config_settings=None):
    return _meta()["dynamic"]

def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    m = _meta()
    files = dict(m["files"])
    if m["hook"]:
        exec(m["hook"], {"files": files})
    dist = (m.get("wheel_name") or m["name"]).replace("-", "_") + "-" + m["version"]
    files[dist + ".dist-info/METADATA"] = "Metadata-Version: 2.1\\nName: %s\\nVersion: %s\\n%s" % (
        m["name"], m["version"], "".join("Requires-Dist: %s\\n" % r for r in m["requires"]))
    files[dist + ".dist-info/WHEEL"] = "Wheel-Version: 1.0\\nGenerator: ow-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"
    name = dist + "-py3-none-any.whl"
    record = []
    with zipfile.ZipFile(os.path.join(wheel_directory, name), "w") as z:
        for path, text in files.items():
            data = text.encode()
            z.writestr(path, data)
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            record.append("%s,sha256=%s,%d" % (path, digest, len(data)))
        record.append(dist + ".dist-info/RECORD,,")
        z.writestr(dist + ".dist-info/RECORD", "\\n".join(record) + "\\n")
    return name
`

/** A real sdist (`<name>-<version>.tar.gz`) with its own build backend (M32). */
export function buildSdist(pkg: TestPackage): { filename: string; data: Buffer } {
  const stem = `${pkg.name.replace(/[-.]+/g, '_')}-${pkg.version}`
  const requires = JSON.stringify(pkg.sdist?.buildRequires ?? [])
  const files: [string, string][] = [
    [
      'pyproject.toml',
      `[build-system]\nrequires = ${requires}\nbuild-backend = "backend"\nbackend-path = ["."]\n`,
    ],
    ['backend.py', SDIST_BACKEND],
    [
      'ow_meta.json',
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        requires: pkg.requires ?? [],
        files: pkg.files ?? {},
        dynamic: pkg.sdist?.dynamicRequires ?? [],
        hook: pkg.sdist?.hook ?? '',
        ...(pkg.sdist?.wheelName && { wheel_name: pkg.sdist.wheelName }),
      }),
    ],
    ['PKG-INFO', `Metadata-Version: 2.1\nName: ${pkg.name}\nVersion: ${pkg.version}\n`],
  ]
  return {
    filename: `${stem}.tar.gz`,
    data: gzipSync(tar(files.map(([p, t]) => [`${stem}/${p}`, Buffer.from(t)]))),
  }
}

/** A ustar archive of regular files (mode 644, mtime 0): what gzip makes an sdist of. */
function tar(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = []
  const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`
  for (const [path, data] of files) {
    const header = Buffer.alloc(512)
    header.write(path, 0, 100, 'utf8')
    header.write(octal(0o644, 8), 100)
    header.write(octal(0, 8), 108)
    header.write(octal(0, 8), 116)
    header.write(octal(data.length, 12), 124)
    header.write(octal(0, 12), 136)
    header.write('        ', 148) // the checksum, as spaces while it's summed
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** A zip with its files stored (not compressed): local headers, the central directory, its end. */
function zip(files: [string, Buffer][]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, data] of files) {
    const name = Buffer.from(path)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date: 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(0o644 << 16, 38) // external attributes: rw-r--r--
    header.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    central.push(header, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/**
 * Serves `packages` as a simple index on a random port, on every interface (the builder's container comes in).
 * With `auth` (M32), every request needs that HTTP basic sign-in (401 without it, 403 with another).
 */
export async function startTestIndex(
  packages: TestPackage[],
  opts: {
    auth?: { username: string; password: string }
    /** Files (not pages) answer a 302 to this base URL's `/files/<name>` (another host, in tests). */
    redirectFilesTo?: string
    /** The root page answers 404, as Google's Artifact Registry's does: only packages' pages are there. */
    noRootListing?: boolean
  } = {},
): Promise<TestIndex> {
  const expected = opts.auth
    ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}`
    : null
  const files = new Map<string, Buffer>()
  const links = new Map<string, string[]>()
  const delays = new Map<string, number>()
  const hashes: Record<string, string> = {}
  for (const pkg of packages) {
    const { filename, data } = pkg.sdistOnly
      ? { filename: `${pkg.name}-${pkg.version}.tar.gz`, data: Buffer.from('not really a tarball') }
      : pkg.sdist
        ? buildSdist(pkg)
        : buildWheel(pkg)
    files.set(filename, data)
    hashes[`${pkg.name}==${pkg.version}`] = sha256(data)
    const page = links.get(normalize(pkg.name)) ?? []
    page.push(`<a href="/files/${filename}#sha256=${sha256(data)}">${filename}</a>`)
    links.set(normalize(pkg.name), page)
    if (pkg.delayMs) delays.set(normalize(pkg.name), pkg.delayMs)
  }
  const server: Server = createServer((req, res) => {
    if (expected && req.headers.authorization !== expected) {
      res.writeHead(req.headers.authorization ? 403 : 401, { 'www-authenticate': 'Basic realm="test index"' })
      res.end()
      return
    }
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    const simple = /^\/simple\/([^/]+)\/?$/.exec(path)
    if (simple && links.has(normalize(simple[1]!))) {
      const name = normalize(simple[1]!)
      const delay = delays.get(name) ?? 0
      delays.delete(name) // the first request only (pip reads the page again to install)
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><html><body>${links.get(name)!.join('<br>')}</body></html>`)
      }, delay)
      return
    }
    if ((path === '/simple/' || path === '/simple') && !opts.noRootListing) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        `<!doctype html><html><body>${[...links.keys()].map((n) => `<a href="/simple/${n}/">${n}</a>`).join('')}</body></html>`,
      )
      return
    }
    const file = /^\/files\/([^/]+)$/.exec(path)
    if (file && opts.redirectFilesTo) {
      res.writeHead(302, { location: `${opts.redirectFilesTo}/files/${file[1]}` })
      res.end()
      return
    }
    if (file && files.has(file[1]!)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(files.get(file[1]!))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://host.docker.internal:${port}/simple`,
    localUrl: `http://127.0.0.1:${port}/simple`,
    hashes,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
