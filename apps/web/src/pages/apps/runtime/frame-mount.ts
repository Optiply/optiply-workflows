import { CONNECT_MESSAGE, type FromFrame, type ToFrame } from '@ow/component-sdk/protocol'

/**
 * A custom component's frame (M25), shared by apps and the library editor's Preview: an iframe with an opaque origin
 * (`sandbox="allow-scripts"` only) written from `componentFrameDocument` (loaded lazily: the frame runtime is large),
 * its port, the bundle fetched by hash and the init message. A frame whose document is replaced (it navigated
 * itself) is removed and reported through `onLeft`. Messages that aren't objects with a type are ignored.
 */

/** The bundles fetched so far, by hash (they never change). */
const bundles = new Map<string, Promise<{ js: string; css: string }>>()

export function fetchBundle(hash: string): Promise<{ js: string; css: string }> {
  let found = bundles.get(hash)
  if (!found) {
    const get = async (ext: string) => {
      const res = await fetch(`/api/component-bundles/${hash}.${ext}`, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`The component library's bundle didn't load (${res.status})`)
      return res.text()
    }
    found = Promise.all([get('js'), get('css')]).then(([js, css]) => ({ js, css }))
    found.catch(() => bundles.delete(hash))
    bundles.set(hash, found)
  }
  return found
}

export interface MountedFrame {
  /** Sends to the frame (nothing once it's closed). */
  post(message: ToFrame): void
  /** Whether its port is open. */
  readonly open: boolean
  /** Closes its port and removes it (stuck, gone or replaced). */
  close(): void
}

export function mountComponentFrame(
  container: HTMLElement,
  opts: {
    title: string
    bundleHash: string
    origins: readonly string[]
    /** The init message's other fields, read when the bundle arrives. */
    init: () => Omit<Extract<ToFrame, { type: 'init' }>, 'type' | 'js' | 'css'>
    onMessage(message: FromFrame): void
    /** The bundle didn't load. */
    onError(message: string): void
    /** It navigated itself away, and was removed. */
    onLeft(): void
  },
): MountedFrame {
  let port: MessagePort | null = null
  let closed = false
  let loads = 0
  const iframe = document.createElement('iframe')
  // No allow-same-origin: an opaque origin, so it reads neither this page nor its cookies.
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.title = opts.title
  iframe.className = 'size-full border-0 bg-transparent'
  const frame: MountedFrame = {
    post: (message) => port?.postMessage(message),
    get open() {
      return port !== null
    },
    close() {
      closed = true
      port?.close()
      port = null
      iframe.remove()
    },
  }
  iframe.addEventListener('load', () => {
    if (closed) return
    if (++loads > 1) {
      // Its document was replaced: it navigated (to send data somewhere?). Removed, and reported.
      frame.close()
      opts.onLeft()
      return
    }
    const channel = new MessageChannel()
    port = channel.port1
    channel.port1.onmessage = (event: MessageEvent<FromFrame>) => {
      const message = event.data as unknown
      if (
        closed ||
        !message ||
        typeof message !== 'object' ||
        typeof (message as FromFrame).type !== 'string'
      )
        return
      opts.onMessage(message as FromFrame)
    }
    iframe.contentWindow?.postMessage(CONNECT_MESSAGE, '*', [channel.port2])
    fetchBundle(opts.bundleHash).then(
      ({ js, css }) => {
        if (!closed) frame.post({ type: 'init', js, css, ...opts.init() })
      },
      (err: Error) => {
        if (!closed) opts.onError(err.message)
      },
    )
  })
  void import('./component-frame').then(({ componentFrameDocument }) => {
    if (closed) return
    iframe.srcdoc = componentFrameDocument(opts.origins)
    container.appendChild(iframe)
  })
  return frame
}
