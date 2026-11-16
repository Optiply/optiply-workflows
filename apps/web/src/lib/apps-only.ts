/**
 * What someone whose access is apps only may open: their apps page, and an app in use (`/apps/<slug>` or one of its
 * pages, never its editor). Anything else takes them to their apps (the server refuses them the platform anyway).
 */
export function appsOnlyMayOpen(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'my-apps') return true
  return parts[0] === 'apps' && (parts.length === 2 || (parts.length === 3 && parts[2] !== 'edit'))
}
