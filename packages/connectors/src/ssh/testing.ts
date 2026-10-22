import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import ssh2 from 'ssh2'
import { type WebSocket, WebSocketServer } from 'ws'

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

export interface TestIapServer {
  /** For `IapOptions.url` (`ws://…/v4`). */
  url: string
  /** Access tokens it accepts; any other gets the handshake refused with 403. */
  readonly tokens: Set<string>
  /** Every connect asked for, accepted or not. */
  readonly connects: { project: string; zone: string; instance: string; port: number; origin?: string }[]
  /** WebSocket connections open now. */
  readonly open: number
  /** The largest data frame a client sent. */
  readonly largestClientFrame: number
  /** The last ack a client sent: the total bytes it said it had received. */
  readonly lastClientAck: number
  /** The next connect is closed with this code (and reason) before reaching the VM. */
  refuseNext(code: number, reason: string): void
  close(): Promise<void>
}

/**
 * A stand-in for Google IAP's TCP forwarding (M18), speaking the `relay.tunnel.cloudproxy.app` subprotocol: it checks
 * the bearer token, finds `instances` by `project/zone/instance` (the VM's address, e.g. a test SSH server on
 * loopback; an unknown one closes with 4047), connects to the asked port there (refused: 4003), says
 * `CONNECT_SUCCESS_SID`, then relays data frames both ways and acks what it receives, as IAP does.
 */
export async function startTestIapServer(options: {
  tokens: string[]
  instances: Record<string, string>
}): Promise<TestIapServer> {
  const tokens = new Set(options.tokens)
  const connects: TestIapServer['connects'] = []
  const sockets = new Set<WebSocket>()
  let largestClientFrame = 0
  let lastClientAck = 0
  let refusal: { code: number; reason: string } | undefined
  let sid = 0
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (p) => (p.has('relay.tunnel.cloudproxy.app') ? 'relay.tunnel.cloudproxy.app' : false),
  })
  const http = createHttpServer((_req, res) => res.writeHead(404).end())
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://iap')
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (url.pathname !== '/v4/connect' || !token || !tokens.has(token)) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nnot authorized',
      )
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      const q = url.searchParams
      const target = {
        project: q.get('project') ?? '',
        zone: q.get('zone') ?? '',
        instance: q.get('instance') ?? '',
        port: Number(q.get('port')),
        origin: req.headers.origin,
      }
      connects.push(target)
      if (refusal) {
        const { code, reason } = refusal
        refusal = undefined
        return ws.close(code, reason)
      }
      const host = options.instances[`${target.project}/${target.zone}/${target.instance}`]
      if (!host) return ws.close(4047, 'Failed to lookup instance')
      const vm = connect(target.port, host)
      let received = 0
      let acked = 0
      const frame = (tag: number, body: Buffer) => {
        const out = Buffer.alloc(6 + body.length)
        out.writeUInt16BE(tag, 0)
        out.writeUInt32BE(body.length, 2)
        body.copy(out, 6)
        return out
      }
      vm.on('connect', () => ws.send(frame(0x0001, Buffer.from(`sid-${++sid}`))))
      vm.on('error', () => ws.close(4003, 'failed to connect to backend'))
      vm.on('close', () => ws.readyState === ws.OPEN && ws.close(1000))
      vm.on('data', (chunk: Buffer) => {
        for (let at = 0; at < chunk.length; at += 16 * 1024)
          ws.send(frame(0x0004, chunk.subarray(at, at + 16 * 1024)))
      })
      ws.on('message', (data: Buffer) => {
        if (data.readUInt16BE(0) === 0x0007) lastClientAck = Number(data.readBigUInt64BE(2))
        if (data.readUInt16BE(0) !== 0x0004) return
        const length = data.readUInt32BE(2)
        largestClientFrame = Math.max(largestClientFrame, length)
        received += length
        vm.write(data.subarray(6, 6 + length))
        if (received - acked > 32 * 1024) {
          const ack = Buffer.alloc(10)
          ack.writeUInt16BE(0x0007, 0)
          ack.writeBigUInt64BE(BigInt(received), 2)
          acked = received
          ws.send(ack)
        }
      })
      ws.on('close', () => vm.destroy())
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}/v4`,
    tokens,
    connects,
    get open() {
      return sockets.size
    },
    get largestClientFrame() {
      return largestClientFrame
    },
    get lastClientAck() {
      return lastClientAck
    },
    refuseNext(code, reason) {
      refusal = { code, reason }
    },
    async close() {
      for (const ws of sockets) ws.terminate()
      wss.close()
      await new Promise((r) => http.close(r))
    },
  }
}
