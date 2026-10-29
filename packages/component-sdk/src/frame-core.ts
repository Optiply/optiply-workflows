import { errorText, FrameBridge } from './bridge'
import type { FrameTheme, FromFrame, ToFrame } from './protocol'

/**
 * The frame's message handling without the DOM (M25), so it can be tested: `load` turns the bundle into its
 * exports, `render` mounts a component (and reports a render error through `fail`), `style` applies CSS and the
 * theme. The DOM side is `frame.tsx`.
 */
export interface FrameHost {
  load(js: string): Promise<Record<string, unknown>>
  render(component: unknown, bridge: FrameBridge): void
  /** The bundle's CSS (null: keep it) and the theme's tokens. */
  style(css: string | null, theme: FrameTheme): void
}

export class FrameController {
  readonly bridge: FrameBridge
  private started = false

  constructor(
    private readonly send: (message: FromFrame) => void,
    private readonly host: FrameHost,
  ) {
    this.bridge = new FrameBridge(send)
  }

  async receive(message: ToFrame): Promise<void> {
    switch (message.type) {
      case 'init': {
        if (this.started) return
        this.started = true
        this.bridge.props = message.props
        this.bridge.state = message.state
        this.bridge.theme = message.theme
        this.host.style(message.css, message.theme)
        let exports: Record<string, unknown>
        try {
          exports = await this.host.load(message.js)
        } catch (err) {
          this.send({ type: 'error', message: `The component library didn't load: ${errorText(err)}` })
          return
        }
        const component = Object.hasOwn(exports, message.component) ? exports[message.component] : undefined
        if (typeof component !== 'function' && (typeof component !== 'object' || component === null)) {
          this.send({ type: 'error', message: `The library has no component "${message.component}"` })
          return
        }
        this.host.render(component, this.bridge)
        this.send({ type: 'ready' })
        return
      }
      case 'props':
        this.bridge.setProps(message.props)
        return
      case 'theme':
        this.bridge.setTheme(message.theme)
        this.host.style(null, message.theme)
        return
      case 'ping':
        this.send({ type: 'pong', n: message.n })
        return
      case 'call': {
        const method = this.bridge.methods.get(message.method)
        if (!method) {
          this.send({
            type: 'result',
            id: message.id,
            ok: false,
            error: `The component doesn't answer "${message.method}" (it calls useMethod for it once mounted)`,
          })
          return
        }
        try {
          const value = await method(...message.args)
          this.bridge.post({ type: 'result', id: message.id, ok: true, value })
        } catch (err) {
          this.send({ type: 'result', id: message.id, ok: false, error: errorText(err) })
        }
        return
      }
    }
  }
}
