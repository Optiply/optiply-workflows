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

/** One SSH server of a tunnel, with what it signs in with. */
export interface TunnelHop extends Pick<SshHop, 'id' | 'host' | 'port' | 'username' | 'hostKey'> {
  credential: SshCredential
}

export interface SshTunnelOptions {
  /** Connecting and signing in, per hop. */
  connectTimeoutMs?: number
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
    return forward(clients.at(-1)!, last, host, port)
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

  private async connectAll(): Promise<ssh2.Client[]> {
    const clients: ssh2.Client[] = []
    try {
      for (const [i, hop] of this.hops.entries()) {
        // Each next server is reached through the one before.
        const sock =
          i === 0 ? undefined : await forward(clients[i - 1]!, this.hops[i - 1]!, hop.host, hop.port)
        clients.push(await this.connectHop(hop, sock))
      }
    } catch (err) {
      for (const c of clients.reverse()) c.end()
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
    this.connectedOnce = true
    for (const client of clients) {
      // One link gone (ended, or keepalives unanswered): the whole chain is; the next `open` connects again.
      client.once('close', () => {
        if (this.clients !== clients) return
        this.chain = null
        this.drop(clients)
      })
    }
    return clients
  }

  private connectHop(hop: TunnelHop, sock: Duplex | undefined): Promise<ssh2.Client> {
    const client = new ssh2.Client()
    let refused: SshError | undefined
    return new Promise((resolve, reject) => {
      client.once('ready', () => {
        client.removeAllListeners('error')
        // Errors after this end the connection, which `close` handles.
        client.on('error', () => {})
        resolve(client)
      })
      client.once('error', (err: Error & { level?: string; code?: string }) => {
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
        readyTimeout: this.options.connectTimeoutMs ?? 15_000,
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
    `SSH server ${hop.host}:${hop.port}: couldn't connect (${err.code ?? err.message})`,
  )
}

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
