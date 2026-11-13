import { create } from 'zustand'

/** The most a component's content may ask for (M33), also checked here: the frame's own cap is the frame's word. */
export const MAX_CONTENT_HEIGHT = 4000

/**
 * Custom components on Auto height (M33): the height their content needs, in CSS pixels, by instance
 * (`<scope><name>`) and by mounted frame (an instance can be on screen twice: the editor's canvas and its preview,
 * a restart), as their frames report it. The app's grids lay them out at the tallest (in rows) instead of their
 * stored height; a frame going away removes only its own report.
 */
export const useContentHeights = create<{
  px: Record<string, Record<string, number>>
  set(key: string, frame: string, px: number | null): void
}>()((set) => ({
  px: {},
  set: (key, frame, px) =>
    set((s) => {
      const reports = s.px[key] ?? {}
      if ((reports[frame] ?? null) === px) return s
      const next = { ...reports }
      if (px === null) delete next[frame]
      else next[frame] = px
      const all = { ...s.px }
      if (Object.keys(next).length) all[key] = next
      else delete all[key]
      return { px: all }
    }),
}))

/** An instance's content height: the tallest of its frames' reports, or undefined without any. */
export function contentHeight(px: Record<string, Record<string, number>>, key: string): number | undefined {
  const reports = px[key]
  return reports ? Math.max(...Object.values(reports)) : undefined
}

/** A frame's report, if it's a height at all: a finite number, clamped to 0..MAX_CONTENT_HEIGHT. */
export function reportedHeight(px: unknown): number | null {
  return typeof px === 'number' && Number.isFinite(px) ? Math.min(MAX_CONTENT_HEIGHT, Math.max(0, px)) : null
}
