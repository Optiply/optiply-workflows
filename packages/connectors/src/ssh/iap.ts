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
  /** Until IAP says it's connected to the VM (and per attempt to resume). */
  connectTimeoutMs?: number
  /** How long a dropped WebSocket may take to resume before the stream fails: 30 s (SSH's keepalives give up later). */
  resumeWithinMs?: number
  /** The first wait before trying to resume, doubling up to 5 s: 250 ms. */
  resumeDelayMs?: number
}

/** Closes worth resuming after: the network went (1006), IAP went away or restarted, or wants a new token (4004). */
const RESUMABLE = new Set([1001, 1006, 1011, 1012, 1013, 4004])
/** Past this much sent and not yet confirmed by IAP, writes wait for its acks (what a resume would resend). */
const MAX_UNCONFIRMED = 8 * 1024 * 1024

/** A duplex stream to the target's port, once IAP has connected to it. */
export async function openIapStream(target: IapTarget, options: IapOptions): Promise<IapStream> {
  const stream = new IapStream(target, options)
  await stream.connected
  return stream
}

/**
 * The bytes sent are kept until IAP confirms them; when the WebSocket drops for a reason worth resuming after, the
 * stream reconnects with its session id and what it received, and resends what IAP hadn't confirmed (as gcloud does).
 * Writes wait meanwhile. Emits `resumed` after each resume.
 */
export class IapStream extends Duplex {
  /** Settles when IAP has connected to the VM (or couldn't). */
  readonly connected: Promise<void>
  /** The session id IAP gave this connection. */
  sid?: string
  /** Times a dropped WebSocket was resumed. */
  resumes = 0
  private ws?: WebSocket
  private received = 0
  private acked = 0
  /** Payloads sent and not yet confirmed, oldest first; IAP has confirmed `confirmed` bytes before them. */
  private unconfirmed: Buffer[] = []
  private unconfirmedBytes = 0
  private confirmed = 0
  private waiters: (() => void)[] = []
  private ending = false
  private readonly where: string

  constructor(
    private readonly target: IapTarget,
    private readonly options: IapOptions,
  ) {
    super({ allowHalfOpen: false })
    this.where = `${target.instance} (${target.project}, ${target.zone}) port ${target.port}`
    this.connected = this.connect()
    // The caller awaits `connected` and gets the error there; after that, errors reach the stream.
    this.connected.catch(() => {})
  }

  private async connect(): Promise<void> {
    const signal = this.attemptSignal(this.options.connectTimeoutMs ?? 15_000)
    const token = await this.options.getToken(signal)
    await this.open('connect', token, signal)
  }

  private attemptSignal(ms: number): AbortSignal {
    return AbortSignal.any([...(this.options.signal ? [this.options.signal] : []), AbortSignal.timeout(ms)])
  }

  /** A WebSocket that IAP has connected (`CONNECT_SUCCESS_SID`) or resumed (`RECONNECT_SUCCESS_ACK`). */
  private open(kind: 'connect' | 'reconnect', token: string, signal: AbortSignal): Promise<void> {
    const { project, zone, instance, port } = this.target
    const url = new URL(`${this.options.url ?? IAP_URL}/${kind}`)
    url.search = new URLSearchParams(
      kind === 'connect'
        ? {
            project,
            zone,
            instance,
            interface: this.target.interface ?? 'nic0',
            port: String(port),
            newWebsocket: 'true',
          }
        : { sid: this.sid ?? '', ack: String(this.received), zone, newWebsocket: 'true' },
    ).toString()
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, [SUBPROTOCOL], {
        headers: { authorization: `Bearer ${token}` },
        origin: ORIGIN,
      })
      let settled = false
      const fail = (err: IapError) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        ws.terminate()
        reject(err)
      }
      const onAbort = () =>
        fail(new IapError('iap_connect', `Google IAP didn't connect to ${this.where} in time`))
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (body.length < 2048) body += c
        })
        res.on('end', () => fail(handshakeError(res.statusCode ?? 0, body.trim(), this.where)))
      })
      // An error is followed by a close, which decides; before IAP connected, the error says more.
      ws.on('error', (err) => fail(new IapError('iap_connect', `Couldn't reach Google IAP: ${err.message}`)))
      ws.on('close', (code, reason) => {
        if (!settled)
          fail(
            closeError(code, reason.toString(), this.where) ??
              new IapError('iap_connect', `Google IAP closed before connecting to ${this.where}`),
          )
        else if (this.ws === ws) this.dropped(code, reason.toString())
      })
      ws.on('message', (data: Buffer) => {
        const ready = this.onMessage(data, kind)
        if (ready && !settled) {
          settled = true
          signal.removeEventListener('abort', onAbort)
          this.ws = ws
          resolve()
        }
      })
    })
  }

  /** Handles one message (one or more frames); true when it's the connect or resume success. */
  private onMessage(data: Buffer, kind: 'connect' | 'reconnect'): boolean {
    let ready = false
    let at = 0
    while (at + 2 <= data.length) {
      const tag = data.readUInt16BE(at)
      at += 2
      if (tag === TAG_CONNECT_SUCCESS_SID && kind === 'connect') {
        const length = data.readUInt32BE(at)
        this.sid = data.subarray(at + 4, at + 4 + length).toString('utf8')
        at += 4 + length
        ready = true
      } else if (tag === TAG_RECONNECT_SUCCESS_ACK && kind === 'reconnect') {
        this.confirm(Number(data.readBigUInt64BE(at)))
        at += 8
        ready = true
      } else if (tag === TAG_DATA) {
        const length = data.readUInt32BE(at)
        const bytes = data.subarray(at + 4, at + 4 + length)
        at += 4 + length
        this.received += bytes.length
        this.push(bytes)
        if (this.received - this.acked > ACK_EVERY) this.sendAck()
      } else if (tag === TAG_ACK) {
        this.confirm(Number(data.readBigUInt64BE(at)))
        at += 8
      } else {
        // An unknown or out-of-place tag: its length is unknown, so the rest of the message goes (as gcloud does).
        break
      }
    }
    return ready
  }

  /** IAP has `total` bytes of ours: they needn't be kept any more. */
  private confirm(total: number): void {
    if (total < this.confirmed || total > this.confirmed + this.unconfirmedBytes) {
      this.destroy(new IapError('iap_connect', `Google IAP acknowledged ${total} bytes, not what was sent`))
      return
    }
    let n = total - this.confirmed
    while (n > 0) {
      const head = this.unconfirmed[0]!
      const used = Math.min(head.length, n)
      if (used === head.length) this.unconfirmed.shift()
      else this.unconfirmed[0] = head.subarray(used)
      this.unconfirmedBytes -= used
      n -= used
    }
    this.confirmed = total
    this.wake()
  }

  private sendAck(): void {
    const frame = Buffer.alloc(10)
    frame.writeUInt16BE(TAG_ACK, 0)
    frame.writeBigUInt64BE(BigInt(this.received), 2)
    this.acked = this.received
    this.ws?.send(frame)
  }

  private dropped(code: number, reason: string): void {
    this.ws = undefined
    if (this.destroyed) return
    const err = closeError(code, reason, this.where)
    if (!err) this.push(null)
    else if (this.ending || !RESUMABLE.has(code)) this.destroy(err)
    else void this.resumeSession(code === 4004, err)
  }

  private async resumeSession(forceToken: boolean, cause: Error): Promise<void> {
    const within = this.options.resumeWithinMs ?? 30_000
    const deadline = Date.now() + within
    let delay = this.options.resumeDelayMs ?? 250
    let last = cause
    let force = forceToken
    while (!this.destroyed) {
      const left = deadline - Date.now()
      if (left <= 0 || this.options.signal?.aborted) {
        this.destroy(
          new IapError(
            'iap_connect',
            `Google IAP dropped the connection to ${this.where} and it couldn't be resumed within ` +
              `${Math.round(within / 1000)} s (${last.message})`,
          ),
        )
        return
      }
      try {
        const signal = this.attemptSignal(Math.min(this.options.connectTimeoutMs ?? 15_000, left))
        await this.open('reconnect', await this.options.getToken(signal, force), signal)
        // The reconnect said what we had received; resend what IAP hadn't confirmed, before any new write.
        this.acked = this.received
        for (const bytes of this.unconfirmed) this.ws?.send(dataFrame(bytes))
        this.resumes++
        this.emit('resumed')
        this.wake()
        return
      } catch (err) {
        last = err as Error
        force = err instanceof IapError && err.code === 'iap_auth'
        await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))))
        delay = Math.min(delay * 2, 5000)
      }
    }
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  /** Until there's an open WebSocket and room for more unconfirmed bytes. */
  private async ready(): Promise<void> {
    while (!this.destroyed && (!this.ws || this.unconfirmedBytes > MAX_UNCONFIRMED))
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    if (this.destroyed) throw new IapError('iap_connect', 'Google IAP is closed')
  }

  override _read(): void {
    // Data is pushed as it arrives; IAP's own window is its acks.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this.send(chunk).then(() => callback(), callback)
  }

  private async send(chunk: Buffer): Promise<void> {
    for (let at = 0; at < chunk.length; at += IAP_MAX_FRAME) {
      await this.ready()
      const frame = dataFrame(chunk.subarray(at, at + IAP_MAX_FRAME))
      // Kept (our copy, inside the frame) until IAP confirms it.
      this.unconfirmed.push(frame.subarray(6))
      this.unconfirmedBytes += frame.length - 6
      const ws = this.ws!
      // Each frame waits for the one before to be written: the socket's backpressure becomes the stream's. A send
      // that fails with the WebSocket is resent when it resumes.
      await new Promise<void>((resolve) => ws.send(frame, () => resolve()))
    }
  }

  override _final(callback: (err?: Error | null) => void): void {
    // IAP has no half-close: ending our side ends the connection (as gcloud does when its client hangs up).
    this.ending = true
    this.ws?.close(1000)
    callback()
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    this.ws?.terminate()
    this.ws = undefined
    this.wake()
    callback(err)
  }
}

function dataFrame(bytes: Buffer): Buffer {
  const frame = Buffer.alloc(6 + bytes.length)
  frame.writeUInt16BE(TAG_DATA, 0)
  frame.writeUInt32BE(bytes.length, 2)
  bytes.copy(frame, 6)
  return frame
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
