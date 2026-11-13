import { describe, expect, it } from 'vitest'
import {
  addCustomInstance,
  buildAppGraph,
  type ComponentLibraryDefinition,
  type ComponentLibraryInfo,
  componentLibraryHash,
  componentLibraryInterface,
  customComponentSpec,
  customInstanceKeys,
  emptyComponentLibrary,
  originReason,
  usedComponentLibraries,
  validateApp,
  validateComponentLibrary,
} from '../src'
import { app, comp } from './helpers'

const library = (extra: Partial<ComponentLibraryDefinition> = {}): ComponentLibraryDefinition => ({
  ...emptyComponentLibrary(),
  ...extra,
})

const codes = (input: unknown) => validateComponentLibrary(input).diagnostics.map((d) => d.code)

describe('validateComponentLibrary', () => {
  it('accepts the starter library', () => {
    expect(validateComponentLibrary(emptyComponentLibrary())).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('refuses bad paths, duplicates and the build’s own files', () => {
    const files = [
      { path: '../x.tsx', content: '' },
      { path: '/abs.tsx', content: '' },
      { path: 'src/a.exe', content: '' },
      { path: 'package.json', content: '{}' },
      { path: 'node_modules/x/index.js', content: '' },
      { path: 'src/Hello.tsx', content: '' },
      { path: 'src/hello.tsx', content: '' },
    ]
    expect(codes(library({ files }))).toEqual([
      'invalid_path',
      'invalid_path',
      'invalid_path',
      'invalid_path',
      'invalid_path',
      'duplicate_path',
    ])
  })

  it('refuses an entry that isn’t there or isn’t code', () => {
    const base = emptyComponentLibrary()
    const [hello] = base.components
    expect(codes({ ...base, components: [{ ...hello, entry: 'src/Nope.tsx' }] })).toEqual(['unknown_entry'])
    const css = { ...base, files: [...base.files, { path: 'src/a.css', content: '' }] }
    expect(codes({ ...css, components: [{ ...hello, entry: 'src/a.css' }] })).toEqual(['unknown_entry'])
  })

  it('checks member names, clashes, defaults and events', () => {
    const base = emptyComponentLibrary()
    const [hello] = base.components
    const component = {
      ...hello,
      props: {
        library: { type: 'string', default: '', label: 'x' },
        count: { type: 'number', default: 'many', label: 'Count' },
        size: { type: { enum: ['s', 'm'] }, default: 'l', label: 'Size' },
      },
      state: { count: { default: 0 }, $x: { default: 0 } },
      methods: { 'bad-name': { params: ['1x'] } },
      events: ['click', 'click', 'no way'],
    }
    expect(codes({ ...base, components: [component, { ...hello }] })).toEqual([
      'invalid_name',
      'invalid_prop',
      'invalid_prop',
      'duplicate_name',
      'invalid_name',
      'invalid_name',
      'invalid_name',
      'duplicate_name',
      'invalid_name',
      'duplicate_name',
    ])
  })

  it('checks dependencies and origins', () => {
    const def = library({
      dependencies: {
        'left-pad': '^1.3.0',
        react: '19',
        'Bad Name': '1',
        evil: 'git+https://x/y.git',
        '@s/ok': 'latest',
      },
      allowedOrigins: [
        'https://api.example.com',
        'https://*.example.com',
        'http://example.com',
        'https://x.io/path',
        'https://api.example.com',
      ],
    })
    expect(validateComponentLibrary(def).diagnostics.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['invalid_dependency', 'dependencies.react'],
      ['invalid_dependency', 'dependencies.Bad Name'],
      ['invalid_dependency', 'dependencies.evil'],
      ['invalid_origin', 'allowedOrigins.2'],
      ['invalid_origin', 'allowedOrigins.3'],
      ['invalid_origin', 'allowedOrigins.4'],
    ])
    expect(originReason('http://localhost:5173')).toBeNull()
    expect(originReason('https://localhost')).toBeNull()
    expect(originReason('https://*.localhost')).not.toBeNull()
    expect(originReason('https://user:pw@x.io')).not.toBeNull()
  })

  it('hashes the same library the same whatever the order', async () => {
    const a = library({ dependencies: { a: '1', b: '2' }, allowedOrigins: ['https://b.io', 'https://a.io'] })
    const b = library({ dependencies: { b: '2', a: '1' }, allowedOrigins: ['https://a.io', 'https://b.io'] })
    expect(await componentLibraryHash(a)).toBe(await componentLibraryHash(b))
  })
})

describe('custom components in an app', () => {
  const lib = emptyComponentLibrary()
  lib.components[0]!.methods = { highlight: { params: ['id'] } }
  lib.components[0]!.props.name!.testValue = 'test'
  const info: ComponentLibraryInfo = {
    liveVersion: '1.0.0',
    versions: { '1.0.0': componentLibraryInterface(lib) },
  }
  const resolveComponentLibrary = (slug: string) => (slug === 'widgets' ? info : undefined)

  it('builds a spec from the declared interface, without test values', () => {
    const iface = componentLibraryInterface(lib).Hello!
    expect(iface.props.name).toEqual({ type: 'string', default: 'world', label: 'Name' })
    const spec = customComponentSpec(iface)
    expect(Object.keys(spec.props)).toEqual([
      'library',
      'version',
      'component',
      'hidden',
      'heightMode',
      'name',
    ])
    // Height (M33): Fixed unless the component grows with its content.
    expect(spec.props.heightMode).toMatchObject({ type: { enum: ['auto', 'fixed'] }, default: 'fixed' })
    expect(customComponentSpec({ ...iface, autoHeight: true }).props.heightMode!.default).toBe('auto')
    expect(
      componentLibraryInterface({ ...lib, components: [{ ...lib.components[0]!, autoHeight: true }] }).Hello,
    ).toMatchObject({ autoHeight: true })
    // A library declaring its own heightMode (before M33) keeps it.
    const own = customComponentSpec({
      ...iface,
      props: { ...iface.props, heightMode: { type: 'string', default: 'x', label: 'Mine' } },
    })
    expect(own.props.heightMode).toMatchObject({ label: 'Mine' })
    expect(Object.keys(spec.state)).toEqual(['clicks'])
    expect(Object.keys(spec.methods)).toEqual(['setHidden', 'highlight'])
    expect(spec.events).toEqual(['click'])
    expect(customComponentSpec(null).openProps).toBe(true)
  })

  it('places an instance named after the component, sized by it', () => {
    const { definition, name } = addCustomInstance(app(), {
      library: 'widgets',
      version: 'latest',
      component: 'Hello',
      defaultSize: { w: 4, h: 6 },
    })
    expect(name).toBe('hello1')
    expect(definition.components[0]).toEqual({
      name: 'hello1',
      type: 'custom',
      props: { library: 'widgets', version: 'latest', component: 'Hello' },
    })
    expect(definition.layout?.hello1).toMatchObject({ w: 4, h: 6 })
    expect(usedComponentLibraries(definition)).toEqual(['widgets'])
    expect(customInstanceKeys(definition)).toEqual(['widgets@latest'])
  })

  it('validates props, state reads, methods and events against the release', () => {
    const def = app({
      components: [
        comp(
          'hello1',
          'custom',
          { library: 'widgets', component: 'Hello', name: '{{ hello1.clicks }}', colour: 'red' },
          {
            events: [
              {
                id: 'h1',
                event: 'click',
                action: { type: 'controlComponent', component: 'hello1', method: 'highlight', args: ['2'] },
              },
            ],
          },
        ),
        comp('text1', 'text', { value: '{{ hello1.clicks + hello1.nope }}' }),
      ],
    })
    const result = validateApp(def, { resolveComponentLibrary })
    expect(result.diagnostics.map((d) => d.code)).toEqual(['unknown_prop', 'unknown_property'])
    // Without the resolver, the instance is open: nothing is reported against it.
    expect(validateApp(def).diagnostics.map((d) => d.code)).toEqual([])
    const graph = buildAppGraph(def)
    expect(graph.entities.get('hello1')?.kind).toBe('component')
  })

  it('reports unknown libraries, releases and components', () => {
    const check = (props: Record<string, unknown>) =>
      validateApp(app({ components: [comp('c1', 'custom', props)] }), {
        resolveComponentLibrary,
      }).diagnostics.map((d) => d.code)
    expect(check({ library: '{{ x }}', component: 'Hello' })).toContain('unknown_component_library')
    expect(check({ library: 'widgets' })).toEqual(['unknown_custom_component'])
    expect(check({ library: 'nope', component: 'Hello' })).toEqual(['unknown_component_library'])
    expect(check({ library: 'widgets', version: '2.0.0', component: 'Hello' })).toEqual(['unknown_version'])
    expect(check({ library: 'widgets', component: 'Bye' })).toEqual(['unknown_custom_component'])
    expect(check({ library: 'widgets', version: '1.0.0', component: 'Hello' })).toEqual([])
    const unpublished = () => ({ liveVersion: null, versions: {} })
    expect(
      validateApp(app({ components: [comp('c1', 'custom', { library: 'w', component: 'Hello' })] }), {
        resolveComponentLibrary: unpublished,
      }).diagnostics.map((d) => d.code),
    ).toEqual(['unpublished_component_library'])
  })
})
