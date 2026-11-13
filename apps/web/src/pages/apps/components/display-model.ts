/** The presentation components' pure parts (session 41), tested without a page. */

/** A number as the statistic's format says; anything else as text. */
export function formatStatistic(
  value: unknown,
  format: string,
  options: { currency?: string; decimals?: number | null } = {},
): string {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (format === 'plain' || Number.isNaN(n))
    return value === null || value === undefined ? '—' : String(value)
  const digits =
    options.decimals === null || options.decimals === undefined
      ? {}
      : { minimumFractionDigits: options.decimals, maximumFractionDigits: options.decimals }
  try {
    if (format === 'currency')
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: options.currency || 'EUR',
        ...digits,
      }).format(n)
    if (format === 'percent')
      return new Intl.NumberFormat(undefined, { style: 'percent', ...digits }).format(n)
    return new Intl.NumberFormat(undefined, digits).format(n)
  } catch {
    // A currency code Intl doesn't know.
    return new Intl.NumberFormat(undefined, digits).format(n)
  }
}

/**
 * Why an Image can't show `src`, or null when it can: http(s) and data:image only; a source computed from `{{ }}`
 * only as a data:image URL or on this site (`origin`), since the app's data in it would reach another site.
 */
export function imageSourceProblem(src: unknown, computed: boolean, origin: string): string | null {
  if (typeof src !== 'string' || !src.trim()) return 'No image source'
  const value = src.trim()
  if (/^data:image\//i.test(value)) return null
  let url: URL
  try {
    url = new URL(value, origin)
  } catch {
    return 'Not a valid image address'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http(s) and data:image sources show'
  if (computed && url.origin !== origin)
    return 'A computed source must be a data:image URL or an address on this site; type an outside address as it is'
  return null
}
