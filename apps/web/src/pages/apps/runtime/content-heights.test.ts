import { describe, expect, it } from 'vitest'
import { contentHeight, MAX_CONTENT_HEIGHT, reportedHeight, useContentHeights } from './content-heights'

describe('content heights (M33)', () => {
  it('keeps each frame’s report, the tallest counting, and removes only a frame’s own', () => {
    const { set } = useContentHeights.getState()
    set('custom1', 'a', 100)
    set('custom1', 'b', 240)
    expect(contentHeight(useContentHeights.getState().px, 'custom1')).toBe(240)
    set('custom1', 'b', null)
    expect(contentHeight(useContentHeights.getState().px, 'custom1')).toBe(100)
    set('custom1', 'a', null)
    expect(contentHeight(useContentHeights.getState().px, 'custom1')).toBeUndefined()
  })

  it('takes only finite heights from a frame, within bounds', () => {
    expect(reportedHeight(120)).toBe(120)
    expect(reportedHeight(1e9)).toBe(MAX_CONTENT_HEIGHT)
    expect(reportedHeight(-5)).toBe(0)
    expect(reportedHeight(Number.NaN)).toBeNull()
    expect(reportedHeight('300')).toBeNull()
  })
})
