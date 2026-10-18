/**
 * Optiply's colour tokens (styles.css) as the theme in effect has them, for what can't use CSS variables (Monaco's
 * themes, Chart.js). Read after the theme's class is on <html>, so the values are that theme's.
 */

/** A token's value as `#rrggbb` (Monaco wants six digits), e.g. `token('--blue-3')`. */
export function token(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#[0-9a-f]{3}$/i.test(raw) ? `#${[...raw.slice(1)].map((c) => c + c).join('')}` : raw
}
