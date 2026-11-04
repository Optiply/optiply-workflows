import frameCode from 'virtual:component-frame'

/**
 * A custom component's frame document (M25, architecture §2.28). The frame is an iframe with `sandbox="allow-scripts"`
 * only (an opaque origin: no cookies, no access to this page), and this policy limits where it can reach: nothing but
 * its library's allowed origins, for fetches, images, fonts and media. Scripts run inline and from blob: URLs only
 * (the frame runtime is written in; the library's bundle arrives as text and loads from a blob). A policy guards the
 * requests a page makes, not every way out (a frame can navigate itself, which the page detects and stops), so the
 * origins an admin allows are a guard, and who may publish a library is trusted with what its components are given.
 */
export function componentFrameCsp(origins: readonly string[]): string {
  const allowed = origins.filter((o) => /^https?:\/\/(\*\.)?[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o))
  const list = (...extra: string[]) => [...extra, ...allowed].join(' ') || "'none'"
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    `img-src ${list('data:', 'blob:')}`,
    `font-src ${list('data:')}`,
    `media-src ${list('data:', 'blob:')}`,
    `connect-src ${list()}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

function inlineScript(code: string): string {
  // `</script` would end the element early; `<\/script` means the same in JavaScript.
  return `<script>${code.replaceAll('</script', '<\\/script')}</script>`
}

/** The frame's document: the policy, a root to mount into, a base style, and the frame runtime. */
export function componentFrameDocument(origins: readonly string[]): string {
  const csp = componentFrameCsp(origins).replaceAll('"', '&quot;')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<style>html,body{margin:0;height:100%;font-family:var(--ow-font,system-ui,sans-serif);color:var(--ow-text,inherit);background:transparent}#root{height:100%;overflow:auto}.ow-frame-error{padding:8px;font:12px/1.4 system-ui,sans-serif;color:#b42318;white-space:pre-wrap}</style>',
    '</head><body><div id="root"></div>',
    inlineScript(frameCode),
    '</body></html>',
  ].join('')
}
