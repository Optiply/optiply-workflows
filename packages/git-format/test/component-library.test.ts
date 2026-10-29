import { componentLibraryHash, emptyComponentLibrary } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { type ComponentLibraryObject, decodeComponentLibrary, encodeComponentLibrary } from '../src'

const object = (extra: Partial<ComponentLibraryObject> = {}): ComponentLibraryObject => {
  const definition = emptyComponentLibrary()
  definition.files.push(
    { path: 'src/styles.css', content: '.a { color: red }' },
    { path: 'README.md.svg', content: '<svg/>\n\n' },
  )
  definition.dependencies = { 'left-pad': '^1.3.0', '@scope/pkg': '2.x' }
  definition.allowedOrigins = ['https://api.example.com']
  return { name: 'Widgets', description: 'Shared widgets', folder: 'Finance/UI', definition, ...extra }
}

describe('component libraries in Git', () => {
  it('writes library.json, package.json, the lock and each source at its path', () => {
    const { files, warnings } = encodeComponentLibrary(object({ lock: '{"lockfileVersion":3}\n' }))
    expect(Object.keys(files)).toEqual([
      'README.md.svg',
      'library.json',
      'package-lock.json',
      'package.json',
      'src/Hello.tsx',
      'src/styles.css',
    ])
    expect(warnings).toEqual([])
    expect(files['src/styles.css']).toBe('.a { color: red }')
    expect(JSON.parse(files['package.json']!)).toEqual({
      private: true,
      dependencies: { '@scope/pkg': '2.x', 'left-pad': '^1.3.0' },
    })
    const lib = JSON.parse(files['library.json']!)
    expect(Object.keys(lib).sort()).toEqual([
      'allowedOrigins',
      'components',
      'description',
      'folder',
      'name',
      'schemaVersion',
    ])
  })

  it('reads back exactly what it wrote, with the same hash', async () => {
    for (const lock of [undefined, '{"lockfileVersion":3}\n']) {
      const before = object(lock === undefined ? {} : { lock })
      const decoded = decodeComponentLibrary(encodeComponentLibrary(before).files)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) return
      expect(decoded.value.lock).toBe(lock)
      expect(decoded.value.name).toBe('Widgets')
      expect(decoded.value.folder).toBe('Finance/UI')
      expect(await componentLibraryHash(decoded.value.definition)).toBe(
        await componentLibraryHash(before.definition),
      )
    }
  })

  it('reads a directory without package.json as no dependencies', () => {
    const { files } = encodeComponentLibrary(object())
    const { 'package.json': _, ...rest } = files
    const decoded = decodeComponentLibrary(rest)
    expect(decoded.ok && decoded.value.definition.dependencies).toEqual({})
  })

  it('names the file a problem is in', () => {
    const { files } = encodeComponentLibrary(object())
    expect(decodeComponentLibrary({ ...files, 'library.json': undefined as never })).toMatchObject({
      ok: false,
    })
    const { 'library.json': _, ...noLib } = files
    expect(decodeComponentLibrary(noLib)).toMatchObject({ ok: false, problems: [{ code: 'missing_file' }] })
    const pkg = { ...files, 'package.json': '{"dependencies":{},"scripts":{"postinstall":"x"}}' }
    expect(decodeComponentLibrary(pkg)).toMatchObject({
      ok: false,
      problems: [{ path: 'package.json', code: 'invalid_definition' }],
    })
    const lib = JSON.parse(files['library.json']!)
    const inline = { ...files, 'library.json': JSON.stringify({ ...lib, files: [] }) }
    expect(decodeComponentLibrary(inline)).toMatchObject({ ok: false, problems: [{ path: 'library.json' }] })
    expect(decodeComponentLibrary({ ...files, 'package.json': '{' })).toMatchObject({
      ok: false,
      problems: [{ code: 'invalid_json' }],
    })
  })
})
