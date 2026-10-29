import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import { errorText, type FrameBridge, frameGlobal } from './bridge'
import { FrameController } from './frame-core'
import * as sdk from './index'
import { CONNECT_MESSAGE, type FromFrame } from './protocol'

/**
 * The script of a custom component's frame (M25), bundled into one IIFE by the web app (`virtual:component-frame`)
 * and written into the frame's document. It provides React, ReactDOM and the SDK to the library's bundle (one React
 * per frame), waits for the page's port, then loads the bundle from a blob: URL and mounts the component.
 */

const g = frameGlobal()
g.modules = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': { ...jsxRuntime, jsxDEV: jsxRuntime.jsx },
  '@ow/component-sdk': sdk,
}

class Boundary extends React.Component<
  { onError: (error: unknown) => void; children?: React.ReactNode },
  { error: unknown }
> {
  override state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error)
  }
  override render() {
    if (this.state.error) {
      return React.createElement(
        'div',
        { className: 'ow-frame-error', role: 'alert' },
        errorText(this.state.error),
      )
    }
    return this.props.children
  }
}

function applyStyle(css: string | null, theme: { mode: string; tokens: Record<string, string> }) {
  if (css !== null) {
    const bundle =
      document.getElementById('ow-bundle-css') ?? document.head.appendChild(document.createElement('style'))
    bundle.id = 'ow-bundle-css'
    bundle.textContent = css
  }
  const vars = Object.entries(theme.tokens)
    .filter(([name]) => /^[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `--ow-${name}: ${value.replace(/[;{}<]/g, '')};`)
    .join(' ')
  const themed =
    document.getElementById('ow-theme') ?? document.head.appendChild(document.createElement('style'))
  themed.id = 'ow-theme'
  themed.textContent = `:root { color-scheme: ${theme.mode === 'dark' ? 'dark' : 'light'}; ${vars} }`
  document.documentElement.dataset.theme = theme.mode
}

let connected = false
window.addEventListener('message', (event) => {
  // Only the page holding this frame, only once.
  if (connected || event.source !== window.parent || event.data !== CONNECT_MESSAGE) return
  const port = event.ports[0]
  if (!port) return
  connected = true
  const send = (message: FromFrame) => port.postMessage(message)
  const controller = new FrameController(send, {
    async load(js) {
      const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
      try {
        return await import(/* @vite-ignore */ url)
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    render(component, bridge: FrameBridge) {
      const root = ReactDOMClient.createRoot(document.getElementById('root')!)
      root.render(
        React.createElement(
          Boundary,
          { onError: (error) => send({ type: 'error', message: errorText(error) }) },
          React.createElement(component as React.ComponentType),
        ),
      )
      void bridge
    },
    style: applyStyle,
  })
  // Before the bundle loads, so code running as it loads finds the bridge.
  g.bridge = controller.bridge
  window.addEventListener('error', (e) => send({ type: 'log', level: 'error', message: e.message }))
  window.addEventListener('unhandledrejection', (e) =>
    send({ type: 'log', level: 'error', message: `Unhandled: ${errorText(e.reason)}` }),
  )
  port.onmessage = (e) => void controller.receive(e.data)
})
