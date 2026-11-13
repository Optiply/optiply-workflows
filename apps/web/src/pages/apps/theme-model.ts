import type { AppTheme } from '@ow/app-definition'

/*
 * The app's theme and custom CSS (session 41), applied inside the app only. Pure, so it's tested without a page.
 *
 * The design tokens are `@theme inline`: utilities read the palette variables underneath (`bg-accent` is
 * `var(--blue-3)`), so a theme overrides those palette variables on the app's root, not the `--color-*` tokens.
 */

const mix = (color: string, amount: number, base: string) =>
  `color-mix(in srgb, ${color} ${amount}%, ${base})`

/** A role's palette: the base, its darker "strong", and the light tint (and its hover) behind it. */
function role(prefix: string, color: string): Record<string, string> {
  return {
    [`--${prefix}-3`]: color,
    [`--${prefix}-4`]: mix(color, 82, 'black'),
    [`--${prefix}-1`]: mix(color, 12, 'var(--shade-1)'),
    [`--${prefix}-1h`]: mix(color, 20, 'var(--shade-1)'),
  }
}

const FONTS: Record<NonNullable<AppTheme['font']>, string> = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: 'var(--font-mono)',
}

/** The CSS custom properties (and background, font) a theme sets on the app's root. */
export function themeStyle(theme: AppTheme | undefined): Record<string, string> {
  if (!theme) return {}
  const style: Record<string, string> = {}
  if (theme.primary) Object.assign(style, role('blue', theme.primary))
  if (theme.danger) Object.assign(style, role('red', theme.danger))
  if (theme.success) Object.assign(style, role('green', theme.success))
  if (theme.warning) Object.assign(style, role('orange', theme.warning))
  if (theme.text) {
    style['--ink-1'] = theme.text
    style['--ink-2'] = mix(theme.text, 70, 'var(--shade-1)')
    style.color = theme.text
  }
  if (theme.background) style.backgroundColor = theme.background
  if (theme.radius !== undefined) {
    style['--radius-sm'] = `${Math.round(theme.radius * 0.5)}px`
    style['--radius-md'] = `${theme.radius}px`
    style['--radius-lg'] = `${Math.round(theme.radius * 1.3)}px`
    style['--radius-panel'] = `${Math.round(theme.radius * 1.6)}px`
  }
  if (theme.font) style.fontFamily = FONTS[theme.font]
  return style
}

/**
 * The app's custom CSS, safe to put on the page: inside the app's root only (CSS nesting), with nothing loading from
 * elsewhere (`url(…)`, `@import`, `image-set(…)` dropped; the app's code has no network access, and styles mustn't
 * give it one), unable to close the root's block (braces balanced) or its `<style>` element (`<` escaped).
 */
export function scopedCss(css: string | undefined, root: string): string {
  if (!css?.trim()) return ''
  const cleaned = css
    // First: a CSS escape could spell `url(` in a way the checks below can't see.
    .replace(/\\/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/(?:url|image-set|image|cross-fade|element)\s*\([^)]*\)?/gi, 'none')
  // `<` can't end the <style> element in any spelling once escaped (CSS reads `\3c ` as `<` inside strings).
  return `${root} {\n${balanced(cleaned).replace(/</g, '\\3c ')}\n}`
}

/**
 * The CSS with its braces balanced inside the root: a `}` closing more than was opened (which would end the root's
 * block, putting what follows on the whole page) is dropped, and blocks left open are closed. Braces in strings
 * don't count.
 */
function balanced(css: string): string {
  let out = ''
  let depth = 0
  let quote: string | null = null
  for (const ch of css) {
    if (quote) {
      if (ch === quote || ch === '\n') quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      if (depth === 0) continue
      depth--
    }
    out += ch
  }
  return out + (quote ? quote : '') + '}'.repeat(depth)
}
