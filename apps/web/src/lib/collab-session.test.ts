import { workflowSpec } from '@ow/collab'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type SaveStatus, SessionSlot } from './collab-session'

/** Sockets the slot's providers open: they stay connecting until a test closes one. */
let sockets: FakeSocket[] = []
class FakeSocket {
  readonly OPEN = 1
  readyState = 0
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  constructor(readonly url: string) {
    sockets.push(this)
  }
  send() {}
  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function slot() {
  const statuses: SaveStatus[] = []
  const s = new SessionSlot(workflowSpec, {
    attach: () => {},
    remote: () => {},
    connection: (status) => statuses.push(status),
    saved: () => {},
    readOnly: () => false,
  })
  return { s, statuses }
}

beforeEach(() => {
  sockets = []
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'test' } })
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** M16 review: an editor's open draft. */
describe('SessionSlot', () => {
  it("gives up waiting for a save after 10 s, as before M16 (Run doesn't hang offline)", async () => {
    vi.useFakeTimers()
    const { s } = slot()
    s.open('workflow:a')
    const saving = s.ensureSaved()
    const failed = expect(saving).rejects.toThrow('Saving the draft took too long')
    await vi.advanceTimersByTimeAsync(10_000)
    await failed
    s.close()
  })

  it('connects afresh when the same draft is opened again after the server ended its connection', () => {
    const { s, statuses } = slot()
    s.open('workflow:a')
    const first = s.awareness
    // Opened again while connected (a branch draft replaced): the same connection.
    s.open('workflow:a')
    expect(s.awareness).toBe(first)
    expect(sockets).toHaveLength(1)
    // The server ends it ("You can edit this draft now: reload"); the editor reloads the draft.
    sockets[0]!.close(4403, 'You can edit this draft now: reload')
    expect(statuses.at(-1)).toBe('closed')
    s.open('workflow:a')
    expect(s.awareness).not.toBe(first)
    expect(sockets).toHaveLength(2)
    expect(statuses.at(-1)).toBe('connecting')
    s.close()
  })
})
