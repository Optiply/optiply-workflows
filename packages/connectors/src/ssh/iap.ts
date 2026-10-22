import { Duplex } from 'node:stream'
import WebSocket from 'ws'

/**
 * Google Cloud IAP's TCP forwarding, as `gcloud compute start-iap-tunnel` does it (the Cloud SDK's
 * `iap_tunnel_websocket*.py`): a WebSocket to `tunnel.cloudproxy.app` carrying the bytes in frames of its
 * `relay.tunnel.cloudproxy.app` subprotocol. Each frame starts with a 2-byte tag; data frames carry at most 16 KiB and
 * each side acks the total bytes it has received.
 */

export const IAP_URL = 'wss://tunnel.cloudproxy.app/v4'
const SUBPROTOCOL = 'relay.tunnel.cloudproxy.app'
const ORIGIN = 'bot:iap-tunneler'
const TAG_CONNECT_SUCCESS_SID = 0x0001
const TAG_RECONNECT_SUCCESS_ACK = 0x0002
const TAG_DATA = 0x0004
const TAG_ACK = 0x0007
/** The largest data frame. */
export const IAP_MAX_FRAME = 16 * 1024
/** We ack once this much has come in since the last ack (twice a frame, as gcloud does). */
const ACK_EVERY = 2 * IAP_MAX_FRAME

/** A VM's port, reached through IAP. */
export interface IapTarget {
  project: string
  zone: string
  instance: string
  /** The VM's network interface, `nic0` unless it has several. */
  interface?: string
  port: number
}

export type IapErrorCode = 'iap_auth' | 'iap_target' | 'iap_connect'

export class IapError extends Error {
  override name = 'IapError'
  constructor(
    readonly code: IapErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface IapOptions {
  /** An access token for IAP (`cloud-platform` scope); `force` after Google refused one. */
  getToken(signal: AbortSignal, force?: boolean): Promise<string>
  signal?: AbortSignal
  /** The endpoint, `wss://tunnel.cloudproxy.app/v4` (tests use a fake). */
  url?: string
  /** Until IAP says it's connected to the VM. */
  connectTimeoutMs?: number
}

/** A duplex stream to the target's port, once IAP has connected to it. */
export async function openIapStream(target: IapTarget, options: IapOptions): Promise<IapStream> {
  const stream = new IapStream(target, options)
  await stream.connected
  return stream
}

export class IapStream extends Duplex {
  /** Settles when IAP has connected to the VM (or couldn't). */
  readonly connected: Promise<void>
  /** The session id IAP gave this connection. */
  sid?: string
  private ws?: WebSocket
  private received = 0
  private acked = 0

  constructor(
    private readonly target: IapTarget,
    private readonly options: IapOptions,
  ) {
    super({ allowHalfOpen: false })
    this.connected = this.connect()
    // The caller awaits `connected` and gets the error there; after that, errors reach the stream.
    this.connected.catch(() => {})
  }

  private async connect(): Promise<void> {
    const signal = AbortSignal.any([
      ...(this.options.signal ? [this.options.signal] : []),
      AbortSignal.timeout(this.options.connectTimeoutMs ?? 15_000),
    ])
    const token = await this.options.getToken(signal)
    const { project, zone, instance, port } = this.target
    const url = new URL(`${this.options.url ?? IAP_URL}/connect`)
    url.search = new URLSearchParams({
      project,
      zone,
      instance,
      interface: this.target.interface ?? 'nic0',
      port: String(port),
      newWebsocket: 'true',
    }).toString()
    const where = `${instance} (${project}, ${zone}) port ${port}`
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, [SUBPROTOCOL], {
        headers: { authorization: `Bearer ${token}` },
        origin: ORIGIN,
      })
      this.ws = ws
      let settled = false
      let opened = false
      const fail = (err: IapError) => {
        if (settled) return
        settled = true
        ws.terminate()
        reject(err)
      }
      const onAbort = () => fail(new IapError('iap_connect', `Google IAP didn't connect to ${where} in time`))
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (body.length < 2048) body += c
        })
        res.on('end', () => fail(handshakeError(res.statusCode ?? 0, body.trim(), where)))
      })
      // After a failed connect the caller has the error: what the WebSocket says while closing goes nowhere.
      ws.on('error', (err) => {
        if (!settled) fail(new IapError('iap_connect', `Couldn't reach Google IAP: ${err.message}`))
        else if (opened) this.destroy(new IapError('iap_connect', `Google IAP: ${err.message}`))
      })
      ws.on('close', (code, reason) => {
        signal.removeEventListener('abort', onAbort)
        const err = closeError(code, reason.toString(), where)
        if (!settled)
          fail(err ?? new IapError('iap_connect', `Google IAP closed before connecting to ${where}`))
        else if (!opened) return
        else if (err) this.destroy(err)
        else this.push(null)
      })
      ws.on('message', (data: Buffer) => {
        const connectedNow = this.onMessage(data)
        if (connectedNow && !settled) {
          settled = true
          opened = true
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
      })
    })
  }

  /** Handles one message (one or more frames); true when it's the connect success. */
  private onMessage(data: Buffer): boolean {
    let connected = false
    let at = 0
    while (at + 2 <= data.length) {
      const tag = data.readUInt16BE(at)
      at += 2
      if (tag === TAG_CONNECT_SUCCESS_SID) {
        const length = data.readUInt32BE(at)
        this.sid = data.subarray(at + 4, at + 4 + length).toString('utf8')
        at += 4 + length
        connected = true
      } else if (tag === TAG_DATA) {
        const length = data.readUInt32BE(at)
        const bytes = data.subarray(at + 4, at + 4 + length)
        at += 4 + length
        this.received += bytes.length
        this.push(bytes)
        if (this.received - this.acked > ACK_EVERY) this.sendAck()
      } else if (tag === TAG_ACK || tag === TAG_RECONNECT_SUCCESS_ACK) {
        // What the server has; kept for resuming (3b).
        at += 8
      } else {
        // An unknown tag: its length is unknown too, so the rest of the message goes (gcloud discards it as well).
        break
      }
    }
    return connected
  }

  private sendAck(): void {
    const frame = Buffer.alloc(10)
    frame.writeUInt16BE(TAG_ACK, 0)
    frame.writeBigUInt64BE(BigInt(this.received), 2)
    this.acked = this.received
    this.ws?.send(frame)
  }

  override _read(): void {
    // Data is pushed as it arrives; IAP's own window is its acks.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      callback(new IapError('iap_connect', 'Google IAP is closed'))
      return
    }
    // Each frame waits for the one before to be written: the socket's backpressure becomes the stream's.
    let at = 0
    const next = (err?: Error) => {
      if (err || at >= chunk.length) {
        callback(err)
        return
      }
      const bytes = chunk.subarray(at, at + IAP_MAX_FRAME)
      at += bytes.length
      const frame = Buffer.alloc(6 + bytes.length)
      frame.writeUInt16BE(TAG_DATA, 0)
      frame.writeUInt32BE(bytes.length, 2)
      bytes.copy(frame, 6)
      ws.send(frame, next)
    }
    next()
  }

  override _final(callback: (err?: Error | null) => void): void {
    // IAP has no half-close: ending our side ends the connection (as gcloud does when its client hangs up).
    this.ws?.close(1000)
    callback()
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    this.ws?.terminate()
    callback(err)
  }
}

function handshakeError(status: number, body: string, where: string): IapError {
  const detail = body ? `: ${body.slice(0, 300)}` : ''
  if (status === 401 || status === 403)
    return new IapError(
      'iap_auth',
      `Google IAP refused the identity (HTTP ${status}${detail}). It needs the IAP-secured Tunnel User role ` +
        '(roles/iap.tunnelResourceAccessor) on the VM or its project',
    )
  if (status === 404)
    return new IapError('iap_target', `Google IAP doesn't know ${where} (HTTP 404${detail})`)
  return new IapError('iap_connect', `Google IAP answered HTTP ${status}${detail}`)
}

/** IAP's close codes; undefined for a normal close. */
function closeError(code: number, reason: string, where: string): IapError | undefined {
  if (code === 1000 || code === 1005) return undefined
  const said = `${code}${reason ? ` ${reason}` : ''}`
  switch (code) {
    case 4003:
      return new IapError(
        'iap_target',
        `Google IAP couldn't connect to ${where} (${said}): is something listening on that port, and does a ` +
          'firewall rule let IAP (35.235.240.0/20) reach it?',
      )
    case 4033:
      return new IapError(
        'iap_auth',
        `Google IAP refused the identity for ${where} (${said}). It needs the IAP-secured Tunnel User role ` +
          '(roles/iap.tunnelResourceAccessor) on the VM or its project',
      )
    case 4047:
      return new IapError(
        'iap_target',
        `Google IAP couldn't find the VM ${where} (${said}): check the project, zone and instance name`,
      )
    default:
      return new IapError('iap_connect', `Google IAP closed the connection to ${where} (${said})`)
  }
}
