import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FrameBridge, frameGlobal } from '../src/bridge'
import { FrameController, type FrameHost } from '../src/frame-core'
import * as sdk from '../src/index'
import type { FromFrame, ToFrame } from '../src/protocol'
import { SDK_EXPORTS } from '../src/types'

const theme = { mode: 'light' as const, tokens: { primary: '#0a6' } }
const init = (extra: Partial<Extract<ToFrame, { type: 'init' }>> = {}): ToFrame => ({
  type: 'init',
  js: 'bundle',
  css: '.a{}',
  component: 'Chart',
  props: { title: 'Sales' },
  state: { selected: null },
  theme,
  ...extra,
})

function setup(exports: Record<string, unknown> = { Chart: () => null }, load?: FrameHost['load']) {
  const sent: FromFrame[] = []
  const calls: string[] = []
  const controller = new FrameController((m) => sent.push(m), {
    load: load ?? (async (js) => (calls.push(`load ${js}`), exports)),
    render: (component) => calls.push(`render ${component === exports.Chart}`),
    style: (css, t) => calls.push(`style ${css} ${t.mode}`),
  })
  return { controller, sent, calls }
}

describe('the frame controller', () => {
  it('loads the bundle, styles, renders the component and says it is ready', async () => {
    const { controller, sent, calls } = setup()
    await controller.receive(init())
    expect(calls).toEqual(['style .a{} light', 'load bundle', 'render true'])
    expect(sent).toEqual([{ type: 'ready' }])
    expect(controller.bridge.props).toEqual({ title: 'Sales' })
    // A second init changes nothing.
    await controller.receive(init({ component: 'Other' }))
    expect(sent).toEqual([{ type: 'ready' }])
  })

  it('reports a bundle that fails and a component that isn’t there', async () => {
    const failing = setup({}, async () => {
      throw new SyntaxError('Unexpected token')
    })
    await failing.controller.receive(init())
    expect(failing.sent).toEqual([
      { type: 'error', message: "The component library didn't load: Unexpected token" },
    ])
    const missing = setup({ Other: () => null })
    await missing.controller.receive(init())
    expect(missing.sent).toEqual([{ type: 'error', message: 'The library has no component "Chart"' }])
  })

  it('answers method calls, pings, props and theme changes', async () => {
    const { controller, sent } = setup()
    await controller.receive(init())
    sent.length = 0
    controller.bridge.methods.set('highlight', async (...args: unknown[]) => `highlighted ${args[0]}`)
    controller.bridge.methods.set('boom', () => {
      throw new Error('nope')
    })
    await controller.receive({ type: 'call', id: 1, method: 'highlight', args: [2] })
    await controller.receive({ type: 'call', id: 2, method: 'boom', args: [] })
    await controller.receive({ type: 'call', id: 3, method: 'missing', args: [] })
    await controller.receive({ type: 'ping', n: 7 })
    expect(sent).toEqual([
      { type: 'result', id: 1, ok: true, value: 'highlighted 2' },
      { type: 'result', id: 2, ok: false, error: 'nope' },
      { type: 'result', id: 3, ok: false, error: expect.stringContaining('doesn\'t answer "missing"') },
      { type: 'pong', n: 7 },
    ])
    let notified = 0
    controller.bridge.subscribe(() => notified++)
    await controller.receive({ type: 'props', props: { title: 'Costs' } })
    await controller.receive({ type: 'theme', theme: { mode: 'dark', tokens: {} } })
    expect(controller.bridge.props).toEqual({ title: 'Costs' })
    expect(controller.bridge.theme.mode).toBe('dark')
    expect(notified).toBe(2)
  })

  it('reports a value that can’t cross to the app instead of throwing', () => {
    const sent: FromFrame[] = []
    const bridge = new FrameBridge((m) => {
      if (m.type === 'setState' && typeof m.value === 'function') throw new Error('could not be cloned')
      if (m.type === 'result' && m.ok && typeof m.value === 'function') throw new Error('could not be cloned')
      sent.push(m)
    })
    bridge.setState('selected', () => 1)
    bridge.post({ type: 'result', id: 4, ok: true, value: () => 1 })
    expect(sent).toEqual([
      { type: 'error', message: 'State "selected" can\'t be sent to the app: could not be cloned' },
      { type: 'result', id: 4, ok: false, error: "The result can't be sent: could not be cloned" },
    ])
  })
})

describe('the SDK hooks', () => {
  it('read props, state and theme, and send state, events and utils', () => {
    const sent: FromFrame[] = []
    const bridge = new FrameBridge((m) => sent.push(m))
    bridge.props = { title: 'Sales' }
    bridge.state = { count: 2 }
    frameGlobal().bridge = bridge
    let setCount: ((n: number | ((p: number) => number)) => void) | undefined
    let fire: (() => void) | undefined
    function Chart() {
      const title = sdk.useProp<string>('title')
      const [count, set] = sdk.useStateValue<number>('count')
      setCount = set
      fire = sdk.useEvent('select')
      return createElement('b', null, `${title} ${count} ${sdk.useTheme().mode}`)
    }
    expect(renderToString(createElement(Chart))).toBe('<b>Sales 2 light</b>')
    setCount!((n) => n + 1)
    fire!()
    sdk.utils.notify('Saved', 'success')
    sdk.utils.openUrl('https://example.com', { newTab: true })
    expect(sent).toEqual([
      { type: 'setState', name: 'count', value: 3 },
      { type: 'event', name: 'select' },
      { type: 'util', action: 'notify', message: 'Saved', tone: 'success' },
      { type: 'util', action: 'openUrl', url: 'https://example.com', newTab: true },
    ])
    frameGlobal().bridge = undefined
    expect(() => sdk.utils.notify('x')).toThrow('inside a custom component’s frame only')
  })

  it('declares exactly what it exports', () => {
    expect(Object.keys(sdk).sort()).toEqual([...SDK_EXPORTS].sort())
  })
})
