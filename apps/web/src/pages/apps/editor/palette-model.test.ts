import { COMPONENTS } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { filterPalette, PALETTE_ENTRIES, PALETTE_GROUPS } from './palette-model'

const labelOf = (type: string) => COMPONENTS[type]?.label ?? type
const types = (groups: { types: string[] }[]) => groups.flatMap((g) => g.types)

describe('the palette', () => {
  it('lists every entry in exactly one group, and every one is a registered component', () => {
    const grouped = PALETTE_GROUPS.flatMap((g) => g.types)
    expect(new Set(grouped).size).toBe(grouped.length)
    expect([...grouped].sort()).toEqual(Object.keys(PALETTE_ENTRIES).sort())
    for (const type of grouped) expect(COMPONENTS[type]).toBeDefined()
  })

  it('shows everything for an empty search, in the groups’ order', () => {
    expect(filterPalette('  ', labelOf).map((g) => g.title)).toEqual(PALETTE_GROUPS.map((g) => g.title))
  })

  it('finds by label, type or keyword, every word, any case; empty groups go', () => {
    expect(types(filterPalette('TEXT', labelOf))).toEqual(['textInput', 'textArea', 'text'])
    expect(types(filterPalette('dropdown', labelOf))).toEqual(['select'])
    expect(types(filterPalette('input date', labelOf))).toEqual(['dateInput', 'dateRange'])
    expect(filterPalette('dialog', labelOf).map((g) => g.title)).toEqual(['Containers and forms'])
    expect(filterPalette('nothing like it', labelOf)).toEqual([])
  })

  it('leaves out what the editor can’t place', () => {
    expect(types(filterPalette('nav', labelOf, (t) => t !== 'navigation'))).toEqual([])
  })
})
