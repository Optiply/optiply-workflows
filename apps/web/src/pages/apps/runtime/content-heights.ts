import { create } from 'zustand'

/**
 * Custom components on Auto height (M33): the height their content needs, in CSS pixels, by instance
 * (`<scope><name>`), as their frames report it. The app's grids lay them out at that height (in rows) instead of
 * their stored one.
 */
export const useContentHeights = create<{
  px: Record<string, number>
  set(key: string, px: number | null): void
}>()((set) => ({
  px: {},
  set: (key, px) =>
    set((s) => {
      if ((s.px[key] ?? null) === px) return s
      const next = { ...s.px }
      if (px === null) delete next[key]
      else next[key] = px
      return { px: next }
    }),
}))
