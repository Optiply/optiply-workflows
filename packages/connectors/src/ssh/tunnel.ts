import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import ssh2 from 'ssh2'
import type { SshCredential, SshHop } from './settings'

export type SshErrorCode =
  | 'ssh_connect'
  | 'ssh_auth'
  | 'ssh_host_key_unknown'
  | 'ssh_host_key_changed'
  | 'ssh_forward'

export interface SshHostKey {
  algorithm: string
  fingerprint: string
}

/** Why a tunnel couldn't open, and at which hop; for host keys, the key the server presented (and the trusted one). */
export class SshError extends Error {
  override name = 'SshError'
  constructor(
    readonly code: SshErrorCode,
    readonly hop: { id: string; host: string; port: number },
    message: string,
    readonly hostKey?: SshHostKey & { trusted?: string },
  ) {
    super(message)
  }
}

/** One hop as Test connection reports it: reached or not, how long it took, and the host key it presented. */
export interface SshTestStep {
  hop: string
  host: string
  port: number
  ok: boolean
  durationMs: number
  /** `trusted`: matches the pin; `untrusted`: no pin yet; `changed`: another key than the pinned one (`trusted`). */
  hostKey?: SshHostKey & { status: 'trusted' | 'untrusted' | 'changed'; trusted?: string }
  error?: { code: SshErrorCode; message: string }
}

/** One SSH server of a tunnel, with what it signs in with. */
export interface TunnelHop extends Pick<SshHop, 'id' | 'host' | 'port' | 'username' | 'hostKey'> {
  credential: SshCredential
}

export interface SshTunnelOptions {
  /** Connecting and signing in, per hop. */
  connectTimeoutMs?: number
  /** When everything must be done by (epoch ms): each hop gets what's left, at most `connectTimeoutMs`. */
  deadline?: number
  /** How often each SSH connection is checked; this many unanswered checks in a row end it. */
  keepaliveMs?: number
  keepaliveCountMax?: number
}

/**
 * This process's tunnels, for its metrics: how many are connected now, and how many times one connected again after
 * its connection dropped.
 */
export const sshTunnelStats = { open: 0, reconnects: 0 }

/**
 * What happens to this process's tunnels, for its log (never a secret): `servers` are `user@host:port`, in order.
 * Test connection's probes aren't reported (their result is shown to whoever tests).
 */
export type SshTunnelEvent =
  | { type: 'connected'; servers: string[]; reconnect: boolean; durationMs: number }
  | { type: 'dropped'; servers: string[] }
  | { type: 'failed'; servers: string[]; hop: string; code: SshErrorCode; message: string }

const listeners = new Set<(event: SshTunnelEvent) => void>()

/** Hears every tunnel event of this process; returns the way to stop. */
export function onSshTunnelEvent(listener: (event: SshTunnelEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: SshTunnelEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A listener's problem isn't the tunnel's.
    }
  }
}

/**
 * The SSH connections of one resource configuration (M17, architecture §2.20), opened on first use: no local port, the
 * driver gets a forwarded channel from `open`. Each hop's host key must match its trusted one; the key a server
 * presented is kept in `seen` (Test connection shows it, trusted or not).
 */
export class SshTunnel {
  /** The host key each hop last presented, by hop id. */
  readonly seen = new Map<string, SshHostKey>()
  private chain: Promise<ssh2.Client[]> | null = null
  private clients: ssh2.Client[] = []
  private closed = false
  /** Connected before: the next connection is a reconnect. */
  private connectedOnce = false

  constructor(
    private hops: TunnelHop[],
    private options: SshTunnelOptions = {},
  ) {
    if (!hops.length) throw new Error('An SSH tunnel needs at least one server')
  }

  /** A connection to `host:port` as the last SSH server sees it. */
  async open(host: string, port: number): Promise<Duplex> {
    const clients = await this.connected()
    const last = this.hops.at(-1)!
    return socketLike(await forward(clients.at(-1)!, last, host, port), host, port)
  }

  /**
   * Connects hop by hop and reports each (Test connection): how long it took, the host key it presented (trusted or
   * not) and why it failed; stops at the first failure. Leaves nothing connected.
   */
  async probe(): Promise<SshTestStep[]> {
    const steps: SshTestStep[] = []
    const clients: ssh2.Client[] = []
    try {
      for (const [i, hop] of this.hops.entries()) {
        const started = performance.now()
        const step = (ok: boolean): SshTestStep => ({
          hop: hop.id,
          host: hop.host,
          port: hop.port,
          ok,
          durationMs: Math.round(performance.now() - started),
        })
        try {
          const sock =
            i === 0 ? undefined : await forward(clients[i - 1]!, this.hops[i - 1]!, hop.host, hop.port)
          clients.push(await this.connectHop(hop, sock))
          const seen = this.seen.get(hop.id)
          steps.push({ ...step(true), ...(seen ? { hostKey: { ...seen, status: 'trusted' as const } } : {}) })
        } catch (err) {
          if (!(err instanceof SshError)) throw err
          const presented = err.hostKey ?? this.seen.get(hop.id)
          const status =
            err.code === 'ssh_host_key_changed'
              ? 'changed'
              : err.code === 'ssh_host_key_unknown'
                ? 'untrusted'
                : 'trusted'
          steps.push({
            ...step(false),
            ...(presented
              ? {
                  hostKey: {
                    algorithm: presented.algorithm,
                    fingerprint: presented.fingerprint,
                    status,
                    ...(err.hostKey?.trusted ? { trusted: err.hostKey.trusted } : {}),
                  },
                }
              : {}),
            error: { code: err.code, message: err.message },
          })
          break
        }
      }
    } finally {
      for (const c of clients.reverse()) c.end()
    }
    return steps
  }

  async close(): Promise<void> {
    this.closed = true
    this.chain = null
    this.drop(this.clients)
  }

  /** Ends a chain; counted as no longer open if it was the connected one. */
  private drop(clients: ssh2.Client[]): void {
    if (clients === this.clients && clients.length) {
      this.clients = []
      sshTunnelStats.open--
    }
    for (const c of [...clients].reverse()) c.end()
  }

  private connected(): Promise<ssh2.Client[]> {
    if (this.closed) return Promise.reject(new Error('This SSH tunnel is closed'))
    this.chain ??= this.connectAll().catch((err) => {
      this.chain = null
      throw err
    })
    return this.chain
  }

  private get servers(): string[] {
    return this.hops.map((h) => `${h.username}@${h.host}:${h.port}`)
  }

  private async connectAll(): Promise<ssh2.Client[]> {
    const clients: ssh2.Client[] = []
    const started = performance.now()
    try {
      for (const [i, hop] of this.hops.entries()) {
        // Each next server is reached through the one before.
        const sock =
          i === 0 ? undefined : await forward(clients[i - 1]!, this.hops[i - 1]!, hop.host, hop.port)
        clients.push(await this.connectHop(hop, sock))
      }
    } catch (err) {
      for (const c of clients.reverse()) c.end()
      if (err instanceof SshError)
        emit({ type: 'failed', servers: this.servers, hop: err.hop.id, code: err.code, message: err.message })
      throw err
    }
    // Closed while connecting: nobody will use these.
    if (this.closed) {
      for (const c of clients.reverse()) c.end()
      throw new Error('This SSH tunnel is closed')
    }
    this.clients = clients
    sshTunnelStats.open++
    if (this.connectedOnce) sshTunnelStats.reconnects++
    emit({
      type: 'connected',
      servers: this.servers,
      reconnect: this.connectedOnce,
      durationMs: Math.round(performance.now() - started),
    })
    this.connectedOnce = true
    const lost = () => {
      if (this.clients !== clients) return
      this.chain = null
      this.drop(clients)
      emit({ type: 'dropped', servers: this.servers })
    }
    for (const client of clients) {
      // One link gone: the whole chain is; the next `open` connects again. `end` as well as `close`: a hop reached
      // through a jump host whose server dies only gets the jump host's EOF on its channel, and OpenSSH closes the
      // channel only after an EOF back, so `close` never comes; ssh2 also stops that hop's keepalives on `end`.
      client.once('close', lost)
      client.once('end', lost)
    }
    return clients
  }

  private connectHop(hop: TunnelHop, sock: Duplex | undefined): Promise<ssh2.Client> {
    const client = new ssh2.Client()
    let refused: SshError | undefined
    const timeout = Math.min(
      this.options.connectTimeoutMs ?? 15_000,
      this.options.deadline === undefined ? Number.POSITIVE_INFINITY : this.options.deadline - Date.now(),
    )
    if (timeout <= 0)
      return Promise.reject(
        new SshError('ssh_connect', hop, `SSH server ${hop.host}: no time left to connect`),
      )
    return new Promise((resolve, reject) => {
      let settled = false
      client.once('ready', () => {
        settled = true
        client.removeAllListeners('error')
        // Errors after this end the connection, which `close` handles.
        client.on('error', () => {})
        resolve(client)
      })
      // `on`, not `once`: a refused connection can report another error (its socket reset) after the first, and an
      // 'error' nobody listens to would bring the process down.
      client.on('error', (err: Error & { level?: string; code?: string }) => {
        if (settled) return
        settled = true
        client.end()
        reject(refused ?? connectError(hop, err))
      })
      const credential =
        'key' in hop.credential
          ? {
              privateKey: hop.credential.key.privateKey,
              ...(hop.credential.key.passphrase ? { passphrase: hop.credential.key.passphrase } : {}),
            }
          : { password: hop.credential.password }
      client.connect({
        ...(sock ? { sock } : { host: hop.host, port: hop.port }),
        username: hop.username,
        ...credential,
        readyTimeout: timeout,
        keepaliveInterval: this.options.keepaliveMs ?? 15_000,
        keepaliveCountMax: this.options.keepaliveCountMax ?? 3,
        tryKeyboard: false,
        hostVerifier: (key: Buffer) => {
          const presented = { algorithm: algorithmOf(key), fingerprint: fingerprintOf(key) }
          this.seen.set(hop.id, presented)
          if (hop.hostKey?.fingerprint === presented.fingerprint) return true
          refused = hop.hostKey
            ? new SshError(
                'ssh_host_key_changed',
                hop,
                `SSH server ${hop.host}: its host key changed: it presented ${presented.fingerprint}, but ` +
                  `${hop.hostKey.fingerprint} is trusted. If the server was reinstalled, check the new key and trust ` +
                  'it in Test connection; otherwise something may be in between.',
                { ...presented, trusted: hop.hostKey.fingerprint },
              )
            : new SshError(
                'ssh_host_key_unknown',
                hop,
                `SSH server ${hop.host}: its host key (${presented.fingerprint}) isn't trusted yet: check it and ` +
                  'trust it in Test connection',
                presented,
              )
          return false
        },
      })
    })
  }
}

/**
 * A channel with what drivers read off a socket: `readyState` (postgres only says goodbye and ends a socket whose
 * `readyState` is `'open'`, then waits for it to close: without one, every pool end waited out its 5 s timeout), and
 * `host` and `port` (postgres's TLS `servername`: without it, `verify-full` checked the certificate against
 * "localhost").
 */
function socketLike(channel: Duplex, host: string, port: number): Duplex {
  // Where it leads, as net.Socket's own: postgres takes TLS's servername (and so the certificate check) from `host`.
  Object.defineProperties(channel, { host: { value: host }, port: { value: port } })
  let closed = false
  channel.once('close', () => {
    closed = true
  })
  Object.defineProperty(channel, 'readyState', {
    configurable: true,
    get: () =>
      closed || channel.destroyed
        ? 'closed'
        : channel.writable && channel.readable
          ? 'open'
          : channel.writable
            ? 'writeOnly'
            : 'readOnly',
  })
  return channel
}

/** A `direct-tcpip` channel from `client`'s server to `host:port`. */
function forward(client: ssh2.Client, hop: TunnelHop, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
      if (err)
        reject(
          new SshError(
            'ssh_forward',
            hop,
            `SSH server ${hop.host} couldn't open a connection to ${host}:${port} (${err.message}): is the address ` +
              'right, reachable from it, and port forwarding allowed (AllowTcpForwarding)?',
          ),
        )
      else resolve(channel)
    })
  })
}

function connectError(hop: TunnelHop, err: Error & { level?: string; code?: string }): SshError {
  if (err.level === 'client-authentication')
    return new SshError('ssh_auth', hop, `SSH server ${hop.host}: signing in as ${hop.username} was refused`)
  if (err.level === 'client-timeout')
    return new SshError('ssh_connect', hop, `SSH server ${hop.host}:${hop.port} didn't answer in time`)
  return new SshError(
    'ssh_connect',
    hop,
    `SSH server ${hop.host}:${hop.port}: couldn't connect (${err.code ?? err.message})` +
      (err.code === 'ECONNREFUSED' && LOOPBACK.has(hop.host.toLowerCase())
        ? `. ${hop.host} is the machine this server runs on: in Docker, its own container. For a tunnel or ` +
          'SSH server on the Docker host, use host.docker.internal'
        : ''),
  )
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** `SHA256:` and the key's hash, as `ssh-keygen -l` shows it. */
function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** A public key blob starts with its algorithm's name. */
function algorithmOf(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const length = key.readUInt32BE(0)
  return key.subarray(4, 4 + length).toString('latin1')
}
