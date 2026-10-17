import { describe, expect, it } from 'vitest'
import { isTextTarget, type ShortcutKeys, shortcutFor, shortcutLabel } from './shortcuts'

const press = (key: string, mods: Partial<ShortcutKeys> = {}): ShortcutKeys => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('shortcutFor', () => {
  it('reads ⌘ on a Mac', () => {
    expect(shortcutFor(press('z', { metaKey: true }), true)).toBe('undo')
    expect(shortcutFor(press('Z', { metaKey: true, shiftKey: true }), true)).toBe('redo')
    expect(shortcutFor(press('d', { metaKey: true }), true)).toBe('duplicate')
    expect(shortcutFor(press('z', { ctrlKey: true }), true)).toBeNull()
    expect(shortcutFor(press('y', { metaKey: true }), true)).toBeNull()
  })

  it('reads Ctrl elsewhere, with Ctrl+Y for redo', () => {
    expect(shortcutFor(press('z', { ctrlKey: true }), false)).toBe('undo')
    expect(shortcutFor(press('Z', { ctrlKey: true, shiftKey: true }), false)).toBe('redo')
    expect(shortcutFor(press('y', { ctrlKey: true }), false)).toBe('redo')
    expect(shortcutFor(press('z', { metaKey: true }), false)).toBeNull()
  })

  it('ignores plain keys, Alt, and keys while composing', () => {
    expect(shortcutFor(press('z'), true)).toBeNull()
    expect(shortcutFor(press('z', { metaKey: true, altKey: true }), true)).toBeNull()
    expect(shortcutFor(press('z', { metaKey: true, isComposing: true }), true)).toBeNull()
    expect(shortcutFor(press('c', { metaKey: true }), true)).toBeNull()
  })
})

describe('shortcutLabel', () => {
  it('uses the platform’s modifier', () => {
    expect(shortcutLabel('Z', { mac: true })).toBe('⌘Z')
    expect(shortcutLabel('Z', { shift: true, mac: true })).toBe('⇧⌘Z')
    expect(shortcutLabel('Z', { shift: true, mac: false })).toBe('Ctrl+Shift+Z')
  })
})

describe('isTextTarget', () => {
  // Enough of an element for `closest`: the selector it's asked for, matched against what it's inside.
  const inside = (...matches: string[]) => ({
    closest: (selector: string) => (selector.split(', ').some((s) => matches.includes(s)) ? {} : null),
  })

  it('leaves text fields and Monaco their keys', () => {
    expect(isTextTarget(inside('input') as unknown as EventTarget)).toBe(true)
    expect(isTextTarget(inside('.monaco-editor') as unknown as EventTarget)).toBe(true)
    expect(isTextTarget(inside() as unknown as EventTarget)).toBe(false)
    expect(isTextTarget(null)).toBe(false)
  })
})
