import type { FrameTheme, FrameUtil, FromFrame } from './protocol'

/**
 * What a component's hooks read and write inside its frame (M25): the props the app gives it, the state it keeps
 * (which the app reads as `custom1.<name>`), its methods, and the theme. The frame runtime makes one and puts it on
 * `globalThis.__owFrame.bridge`; the SDK's hooks find it there.
 */
export class FrameBridge {
  props: Record<string, unknown> = {}
  state: Record<string, unknown> = {}
  theme: FrameTheme = { mode: 'light', tokens: {} }
  readonly methods = new Map<string, (...args: unknown[]) => unknown>()
  private readonly listeners = new Set<() => void>()
  /** Bumped on every change, so `useSyncExternalStore` sees one. */
  private version = 0

  constructor(private readonly send: (message: FromFrame) => void) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.version

  private changed() {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  setProps(props: Record<string, unknown>) {
    this.props = props
    this.changed()
  }

  setTheme(theme: FrameTheme) {
    this.theme = theme
    this.changed()
  }

  /** The component sets one of its state values: kept here and sent to the app. */
  setState(name: string, value: unknown) {
    this.state = { ...this.state, [name]: value }
    this.changed()
    this.post({ type: 'setState', name, value })
  }

  fire(name: string) {
    this.post({ type: 'event', name })
  }

  util(util: FrameUtil) {
    this.post({ type: 'util', ...util })
  }

  /** Sends, or reports that a value couldn't cross to the app (a function, a DOM node…). */
  post(message: FromFrame) {
    try {
      this.send(message)
    } catch (err) {
      if (message.type === 'setState') {
        this.send({
          type: 'error',
          message: `State "${message.name}" can't be sent to the app: ${errorText(err)}`,
        })
      } else if (message.type === 'result') {
        this.send({
          type: 'result',
          id: message.id,
          ok: false,
          error: `The result can't be sent: ${errorText(err)}`,
        })
      } else throw err
    }
  }
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface FrameGlobal {
  bridge?: FrameBridge
  modules?: Record<string, unknown>
}

export function frameGlobal(): FrameGlobal {
  const g = globalThis as { __owFrame?: FrameGlobal }
  g.__owFrame ??= {}
  return g.__owFrame
}

export function currentBridge(): FrameBridge {
  const bridge = frameGlobal().bridge
  if (!bridge) throw new Error('@ow/component-sdk works inside a custom component’s frame only')
  return bridge
}
