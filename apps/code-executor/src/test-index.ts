/**
 * A Python package index for tests (M23): wheels made here, served as a PEP 503 "simple" index on a local port, so
 * the builder's tests and the e2e need no PyPI. Only what pip reads: `/simple/<name>/` pages linking the files with
 * their sha256, and the files.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { crc32 } from 'node:zlib'

export interface TestPackage {
  name: string
  version: string
  /** The package's modules: path in the wheel → source (`owtest_a/__init__.py`). */
  files?: Record<string, string>
  /** `Requires-Dist` lines (`owtest-b>=1`). */
  requires?: string[]
  /** Served as an sdist only (a `.tar.gz` pip won't take with `--only-binary`). */
  sdistOnly?: boolean
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

/** Serves `packages` as a simple index on a random port, on every interface (the builder's container comes in). */
export async function startTestIndex(packages: TestPackage[]): Promise<TestIndex> {
  const files = new Map<string, Buffer>()
  const links = new Map<string, string[]>()
  const hashes: Record<string, string> = {}
  for (const pkg of packages) {
    const { filename, data } = pkg.sdistOnly
      ? { filename: `${pkg.name}-${pkg.version}.tar.gz`, data: Buffer.from('not really a tarball') }
      : buildWheel(pkg)
    files.set(filename, data)
    hashes[`${pkg.name}==${pkg.version}`] = sha256(data)
    const page = links.get(normalize(pkg.name)) ?? []
    page.push(`<a href="/files/${filename}#sha256=${sha256(data)}">${filename}</a>`)
    links.set(normalize(pkg.name), page)
  }
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    const simple = /^\/simple\/([^/]+)\/?$/.exec(path)
    if (simple && links.has(normalize(simple[1]!))) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><html><body>${links.get(normalize(simple[1]!))!.join('<br>')}</body></html>`)
      return
    }
    const file = /^\/files\/([^/]+)$/.exec(path)
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
