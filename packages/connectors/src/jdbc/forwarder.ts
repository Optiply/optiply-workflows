import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { hostname } from 'node:os'
import type { SshTunnel } from '../ssh/tunnel'
import { ConnectorError } from '../types'

// The SSH tunnel for JDBC resources (M38 step 4, docs/architecture.md §2.42). SSH stays here, in the app (M17/M18:
// jump hosts, host keys, IAP); the JDBC runner borrows connections through it. Each runner connection opens with one
// line, `<tunnelId> <secret> <host> <port>`; the forwarder answers `OK` and pipes it through the tunnel to that host,
// or `ERR <why>` and closes. Only a resource's own hosts, only with its tunnel's secret (which only the runner gets, in
// its queries): code in the code executor, on the same network, can't use it.

export interface JdbcTunnel {
  /** Where the runner reaches this process's forwarder: `host:port`. */
  forwarder: string
  tunnelId: string
  secret: string
  /** `host:port`, as the resource lists them. */
  hosts: string[]
  /** The SSH servers it goes through, hashed: the runner shares hosts' addresses between registrations on one route. */
  route: string
}

interface Entry {
  secret: Buffer
  tunnel: SshTunnel
  hosts: Set<string>
}

const HELLO_MAX = 1024
const HELLO_TIMEOUT_MS = 10_000

export class JdbcForwarder {
  private server: Server | undefined
  private address: Promise<string> | undefined
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly opts: {
      /** The port to listen on (0: any free one). */
      port: number
      /** The interface to listen on (all by default). */
      bind?: string
      /** The host name the runner reaches this process by (this container's, by default). */
      advertise?: string
    },
  ) {}

  /** Lets the runner reach these hosts through this tunnel, until `unregister`. */
  async register(tunnel: SshTunnel, hosts: string[], route: string): Promise<JdbcTunnel> {
    const forwarder = await this.listen()
    const tunnelId = randomBytes(8).toString('hex')
    const secret = randomBytes(32).toString('hex')
    const normal = hosts.map(normalHost)
    this.entries.set(tunnelId, { secret: Buffer.from(secret), tunnel, hosts: new Set(normal) })
    return { forwarder, tunnelId, secret, hosts: normal, route }
  }

  unregister(tunnelId: string): void {
    this.entries.delete(tunnelId)
  }

  async close(): Promise<void> {
    this.entries.clear()
    const server = this.server
    this.server = undefined
    this.address = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private listen(): Promise<string> {
    this.address ??= new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handle(socket))
      server.once('error', (err) => {
        this.address = undefined
        reject(new ConnectorError('connection', `The JDBC tunnel forwarder can't listen: ${err.message}`))
      })
      server.listen(this.opts.port, this.opts.bind, () => {
        this.server = server
        const { port } = server.address() as { port: number }
        resolve(`${this.opts.advertise || hostname()}:${port}`)
      })
    })
    return this.address
  }

  private handle(socket: Socket): void {
    socket.setNoDelay(true)
    let buffered = Buffer.alloc(0)
    const refuse = (why: string) => {
      socket.end(`ERR ${why}\n`)
    }
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const nl = buffered.indexOf(0x0a)
      if (nl === -1) {
        if (buffered.length > HELLO_MAX) socket.destroy()
        return
      }
      socket.off('data', onData)
      socket.pause()
      clearTimeout(timer)
      const rest = buffered.subarray(nl + 1)
      void this.connect(socket, buffered.subarray(0, nl).toString('utf8'), rest, refuse)
    }
    socket.on('data', onData)
    socket.on('error', () => socket.destroy())
  }

  private async connect(
    socket: Socket,
    hello: string,
    rest: Buffer,
    refuse: (why: string) => void,
  ): Promise<void> {
    const [tunnelId, secret, host, portText, ...extra] = hello.trim().split(' ')
    const entry = tunnelId ? this.entries.get(tunnelId) : undefined
    const given = Buffer.from(secret ?? '')
    if (
      !entry ||
      extra.length ||
      given.length !== entry.secret.length ||
      !timingSafeEqual(given, entry.secret)
    ) {
      return refuse('unknown tunnel')
    }
    const port = Number(portText)
    const target = `${(host ?? '').toLowerCase()}:${port}`
    if (!host || !Number.isInteger(port) || !entry.hosts.has(target)) {
      return refuse(`${host}:${portText} isn't one of this resource's tunnel hosts`)
    }
    let channel: Awaited<ReturnType<SshTunnel['open']>>
    try {
      // The name as the resource lists it (DNS names compare without case).
      channel = await entry.tunnel.open(host.toLowerCase(), port)
    } catch (err) {
      return refuse((err as Error).message.replace(/\s+/g, ' ').slice(0, 300))
    }
    if (socket.destroyed) {
      channel.destroy()
      return
    }
    socket.write('OK\n')
    if (rest.length) channel.write(rest)
    socket.pipe(channel)
    channel.pipe(socket)
    const end = () => {
      socket.destroy()
      channel.destroy()
    }
    socket.on('close', end)
    channel.on('close', end)
    channel.on('error', end)
    socket.resume()
  }
}

/** `Host:Port` as the forwarder and the runner compare them: the host in lower case. */
export function normalHost(hostPort: string): string {
  const at = hostPort.lastIndexOf(':')
  return `${hostPort.slice(0, at).trim().toLowerCase()}:${Number(hostPort.slice(at + 1))}`
}

/** This process's forwarder, set by the server (`JDBC_FORWARDER_PORT`); none: JDBC resources can't use SSH. */
let forwarder: JdbcForwarder | null = null

export function configureJdbcForwarder(next: JdbcForwarder | null): void {
  void forwarder?.close()
  forwarder = next
}

export function jdbcForwarder(): JdbcForwarder {
  if (!forwarder) {
    throw new ConnectorError(
      'invalid_config',
      "This instance has no JDBC tunnel forwarder (JDBC_FORWARDER_PORT): JDBC resources can't connect through SSH here",
    )
  }
  return forwarder
}
