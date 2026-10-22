import { createHash, timingSafeEqual } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import ssh2 from 'ssh2'

/** One account on the test SSH server: a password, or the public half of a key (an `authorized_keys` line). */
export type TestSshUser = { username: string; password: string } | { username: string; publicKey: string }

export interface TestSshServer {
  host: string
  port: number
  /** The server's host key, as a trusted pin would hold it. */
  hostKey: { algorithm: string; fingerprint: string }
  /** Clients signed in now. */
  readonly clients: number
  /** Every `direct-tcpip` forward asked for, allowed or not. */
  readonly forwards: { host: string; port: number; allowed: boolean }[]
  /** Ends every connection and stops listening, then listens again on the same port (a restart). */
  restart(): Promise<void>
  /** Ends every connection, as a dropped network would (the server keeps listening). */
  dropAll(): void
  /**
   * Stops as a killed sshd does (a container restart): every TCP connection cut without an SSH goodbye, then listening
   * again on the same port with the same host key.
   */
  crash(): Promise<void>
  close(): Promise<void>
}

/**
 * An in-process SSH server for tests (M17): password and key accounts, its own host key, and `direct-tcpip`
 * forwarding to whatever `allowForward` lets through (by default only loopback, where the tests' databases and HTTP
 * servers listen). Restartable on the same port, to test a tunnel reopening.
 */
export async function startTestSshServer(options: {
  users: TestSshUser[]
  allowForward?: (host: string, port: number) => boolean
  /** Names only this server resolves (its own /etc/hosts), so a test can tell a tunnelled connection from a direct one. */
  hosts?: Record<string, string>
  /** A fixed host key (OpenSSH form), e.g. to restart "as another server"; generated otherwise. */
  hostKey?: string
}): Promise<TestSshServer> {
  const hostKey = options.hostKey ?? ssh2.utils.generateKeyPairSync('ed25519').private
  const parsedHostKey = ssh2.utils.parseKey(hostKey)
  if (parsedHostKey instanceof Error) throw parsedHostKey
  const blob = parsedHostKey.getPublicSSH()
  const hosts = options.hosts ?? {}
  const allow =
    options.allowForward ??
    ((host) => host in hosts || host === '127.0.0.1' || host === 'localhost' || host === '::1')
  const forwards: TestSshServer['forwards'] = []
  const connections = new Set<ssh2.Connection>()
  const sockets = new Set<Socket>()
  let signedIn = 0

  const users = options.users.map((u) => {
    if ('password' in u) return u
    const key = ssh2.utils.parseKey(u.publicKey)
    if (key instanceof Error) throw key
    return { username: u.username, key }
  })

  const make = () =>
    new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      connections.add(client)
      let authed = false
      // This connection's forwarded connections: they go with it, as sshd's do.
      const targets = new Set<Socket>()
      client.on('authentication', (ctx) => {
        const user = users.find((u) => u.username === ctx.username)
        if (ctx.method === 'password' && user && 'password' in user && same(ctx.password, user.password))
          return ctx.accept()
        if (ctx.method === 'publickey' && user && 'key' in user) {
          const offered = ctx.key.data
          if (offered.equals(user.key.getPublicSSH())) {
            // Without a signature the client only asks whether this key would do.
            if (!ctx.signature || !ctx.blob) return ctx.accept()
            if (user.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept()
          }
        }
        ctx.reject(['password', 'publickey'])
      })
      client.on('ready', () => {
        authed = true
        signedIn++
        client.on('tcpip', (accept, reject, info) => {
          const allowed = allow(info.destIP, info.destPort)
          forwards.push({ host: info.destIP, port: info.destPort, allowed })
          if (!allowed) return reject()
          const target = connect(info.destPort, hosts[info.destIP] ?? info.destIP)
          sockets.add(target)
          targets.add(target)
          target.on('close', () => {
            sockets.delete(target)
            targets.delete(target)
          })
          target.once('error', () => reject())
          target.once('connect', () => {
            const channel = accept()
            channel.pipe(target)
            // As OpenSSH's sshd does (seen against it in M17's Compose check): the forwarded connection gone, the
            // channel only gets an EOF, and is closed once the client has sent its EOF too. (ssh2's own server
            // channels close right after their EOF, which hid a tunnel that only listened for the close.)
            let clientEnded = false
            let targetGone = false
            target.on('data', (chunk) => channel.write(chunk))
            channel.on('end', () => {
              clientEnded = true
              if (targetGone) channel.close()
            })
            channel.on('close', () => target.destroy())
            target.on('close', () => {
              targetGone = true
              channel.eof()
              if (clientEnded) channel.close()
            })
            target.on('error', () => channel.destroy())
          })
        })
      })
      const gone = () => {
        for (const t of targets) t.destroy()
        if (!connections.delete(client)) return
        if (authed) signedIn--
      }
      client.on('close', gone)
      client.on('error', gone)
    })

  let server = make()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const dropAll = () => {
    for (const c of connections) c.end()
    for (const s of sockets) s.destroy()
  }
  const stop = () =>
    new Promise<void>((resolve) => {
      dropAll()
      server.close(() => resolve())
    })

  return {
    host: '127.0.0.1',
    port,
    hostKey: {
      algorithm: parsedHostKey.type,
      fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    },
    get clients() {
      return signedIn
    },
    forwards,
    async restart() {
      await stop()
      server = make()
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    dropAll,
    async crash() {
      for (const c of connections) (c as unknown as { _sock?: Socket })._sock?.destroy()
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server = make()
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    close: stop,
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
