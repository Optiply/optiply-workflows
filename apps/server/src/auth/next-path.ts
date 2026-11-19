/**
 * Where to send someone after they sign in: the page they opened (`next`, which the web app passes to the sign-in), when
 * it is a page of this site's web app. Anything else is dropped, and they land on the home page as before: another site
 * (`https://…`, the protocol-relative `//host`, backslash tricks browsers read as `//`), control characters, the API,
 * the sign-in page itself (it would only send them round again), and the home page (the default anyway).
 */
export function safeNextPath(raw: unknown, publicUrl: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return undefined
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return undefined
  for (const c of raw) {
    const code = c.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return undefined
  }
  let url: URL
  try {
    url = new URL(raw, publicUrl)
  } catch {
    return undefined
  }
  if (url.origin !== new URL(publicUrl).origin) return undefined
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return undefined
  const path = `${url.pathname}${url.search}${url.hash}`
  return path === '/' ? undefined : path
}
