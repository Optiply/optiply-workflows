import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CollabProvider } from '../src/provider'

/** A socket the test drives: it opens and closes when told to (or on its own, as `onCreate` arranges). */
class FakeSocket {
  static readonly OPEN = 1
  readonly OPEN = 1
  readyState = 0
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  sent: Uint8Array[] = []
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  send(data: Uint8Array) {
    this.sent.push(data)
  }
  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function provider(onCreate: (socket: FakeSocket) => void, options: { minRetryMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const p = new CollabProvider({
    url: 'ws://test/api/collab/workflow:x',
    doc: new Y.Doc(),
    minRetryMs: options.minRetryMs ?? 500,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      onCreate(socket)
      return socket as unknown as WebSocket
    },
  })
  return { p, sockets }
}

/** M16 review: the provider's reconnects and pending saves. */
describe('CollabProvider', () => {
  it('backs off when the server accepts the socket and then closes it, again and again', async () => {
    // As a server does when loading the document fails: the upgrade is accepted, then it's closed.
    const { p, sockets } = provider(
      (socket) =>
        setTimeout(() => {
          socket.open()
          socket.close(1011, 'Could not open the document')
        }, 0),
      { minRetryMs: 20 },
    )
    await new Promise((r) => setTimeout(r, 400))
    p.destroy()
    // 20, 40, 80, 160 ms apart: about five tries. (Starting from 20 each time: about twenty.)
    expect(sockets.length).toBeLessThanOrEqual(6)
  })

  it('answers saves still waiting when it is destroyed', async () => {
    const { p } = provider(() => {})
    const saving = p.save()
    p.destroy()
    await expect(saving).resolves.toEqual({ revision: 0, error: 'Closed' })
  })
})
