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
