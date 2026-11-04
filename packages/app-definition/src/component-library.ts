import { blockNameSchema, canonicalJson, isReservedWord } from '@ow/definition'
import { z } from 'zod'
import type { ComponentSpec, JsonValue, PropSpec, PropType } from './components'
import type { AppComponent, AppDefinition } from './schema'

/**
 * A component library (M25): React components written in the platform, built on the server and run in a sandboxed
 * iframe. The definition holds the source files, the npm dependencies, the origins the components may reach and
 * each component's **declared** interface (props, state, events, methods): the validator, the graph, the inspector
 * and the completions need it without running anything. The build (the lock, the bundle) is the server's.
 */

export const COMPONENT_LIBRARY_SCHEMA_VERSION = 1

/** Source extensions a library may hold. */
export const COMPONENT_FILE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json', '.svg'] as const
/** Entry files (a component's `entry`) are code. */
const ENTRY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']
/** The source a library may hold, in bytes (UTF-16 length, close enough for a limit). */
export const MAX_COMPONENT_SOURCE = 2 * 1024 * 1024
const MAX_FILES = 200
const MAX_COMPONENTS = 100

/** Props every custom component instance has besides its declared ones: the library, release and component. */
export const CUSTOM_PROPS = ['library', 'version', 'component'] as const
/** Names a component's declared props, state and methods can't take (the instance's own, and the common ones). */
const RESERVED_MEMBERS = new Set<string>([...CUSTOM_PROPS, 'hidden', 'setHidden'])

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

const propTypeSchema: z.ZodType<PropType> = z.union([
  z.enum(['string', 'number', 'boolean', 'array', 'object', 'any']),
  z.strictObject({ enum: z.array(z.string()).min(1).max(100) }),
])

export const customPropSchema = z.strictObject({
  type: propTypeSchema,
  default: jsonValue,
  label: z.string().max(100),
  nullable: z.boolean().optional(),
  /** The value the library editor's preview gives it. */
  testValue: jsonValue.optional(),
})

export const customComponentSchema = z.strictObject({
  name: blockNameSchema,
  label: z.string().max(100),
  description: z.string().max(2000).optional(),
  /** The file whose default export is the component. */
  entry: z.string().max(300),
  props: z.record(z.string(), customPropSchema).default({}),
  state: z.record(z.string(), z.strictObject({ default: jsonValue })).default({}),
  events: z.array(z.string()).max(100).default([]),
  methods: z.record(z.string(), z.strictObject({ params: z.array(z.string()).max(20) })).default({}),
  defaultSize: z
    .strictObject({ w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(1000) })
    .default({ w: 6, h: 20 }),
  /** Grows and shrinks with its content in apps by default (M33); an instance's Height can say otherwise. */
  autoHeight: z.boolean().optional(),
})

export const componentFileSchema = z.strictObject({ path: z.string().max(300), content: z.string() })

export const componentLibraryDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(COMPONENT_LIBRARY_SCHEMA_VERSION),
  files: z.array(componentFileSchema).max(MAX_FILES).default([]),
  /** npm package name → semver range, as in a `package.json`. */
  dependencies: z.record(z.string(), z.string().max(200)).default({}),
  /** Origins the components may fetch from and load images, fonts and media from (set by admins). */
  allowedOrigins: z.array(z.string().max(300)).max(50).default([]),
  components: z.array(customComponentSchema).max(MAX_COMPONENTS).default([]),
})

export type ComponentLibraryDefinition = z.infer<typeof componentLibraryDefinitionSchema>
export type CustomComponentDefinition = z.infer<typeof customComponentSchema>
export type CustomPropDefinition = z.infer<typeof customPropSchema>
export type ComponentFile = z.infer<typeof componentFileSchema>

const STARTER = `import { useEvent, useProp, useStateValue } from '@ow/component-sdk'

export default function Hello() {
  const name = useProp<string>('name')
  const [clicks, setClicks] = useStateValue<number>('clicks')
  const clicked = useEvent('click')
  return (
    <button
      type="button"
      onClick={() => {
        setClicks((clicks ?? 0) + 1)
        clicked()
      }}
    >
      Hello {name}: {clicks ?? 0}
    </button>
  )
}
`

/** A new library: one component to start from. */
export function emptyComponentLibrary(): ComponentLibraryDefinition {
  return {
    schemaVersion: COMPONENT_LIBRARY_SCHEMA_VERSION,
    files: [{ path: 'src/Hello.tsx', content: STARTER }],
    dependencies: {},
    allowedOrigins: [],
    components: [
      {
        name: 'Hello',
        label: 'Hello',
        entry: 'src/Hello.tsx',
        props: { name: { type: 'string', default: 'world', label: 'Name' } },
        state: { clicks: { default: 0 } },
        events: ['click'],
        methods: {},
        defaultSize: { w: 4, h: 6 },
      },
    ],
  }
}

/** The library in a fixed form: files by path, components by name, dependencies and origins sorted. */
export function canonicalizeComponentLibrary(def: ComponentLibraryDefinition): ComponentLibraryDefinition {
  const by = <T>(items: readonly T[], key: (t: T) => string) =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  return {
    ...def,
    files: by(def.files, (f) => f.path),
    dependencies: Object.fromEntries(by(Object.entries(def.dependencies), ([k]) => k)),
    allowedOrigins: [...def.allowedOrigins].sort(),
    components: by(def.components, (c) => c.name),
  }
}

/** SHA-256 (hex) of the canonical library: the identity of what a release holds (Web Crypto: browser and Node). */
export async function componentLibraryHash(def: ComponentLibraryDefinition): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(canonicalizeComponentLibrary(def)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** What an app sees of one custom component in a release: its declared interface, without the code. */
export interface CustomComponentInterface {
  label: string
  description?: string
  props: Record<string, PropSpec>
  state: Record<string, { default: JsonValue }>
  events: string[]
  methods: Record<string, { params: string[] }>
  defaultSize: { w: number; h: number }
  /** Its instances' Height is Auto unless set (M33). */
  autoHeight?: boolean
}

/** A release's components by name, as an app sees them. */
export type ComponentLibraryInterface = Record<string, CustomComponentInterface>

export function componentLibraryInterface(def: ComponentLibraryDefinition): ComponentLibraryInterface {
  return Object.fromEntries(
    def.components.map((c) => [
      c.name,
      {
        label: c.label,
        ...(c.description !== undefined && { description: c.description }),
        props: Object.fromEntries(
          Object.entries(c.props).map(([name, { testValue: _, ...spec }]) => [name, spec as PropSpec]),
        ),
        state: c.state,
        events: c.events,
        methods: c.methods,
        defaultSize: c.defaultSize,
        ...(c.autoHeight && { autoHeight: true }),
      },
    ]),
  )
}

const customBase = {
  type: 'custom',
  label: 'Custom component',
} as const

/**
 * A custom component instance's spec (M25): its declared props (beside `library`, `version`, `component` and
 * `hidden`), state, events and methods when its release is known, otherwise open until it is.
 */
export function customComponentSpec(iface: CustomComponentInterface | null): ComponentSpec {
  const props: Record<string, PropSpec> = {
    library: { type: 'string', default: '', label: 'Library' },
    version: { type: 'string', default: 'latest', label: 'Version' },
    component: { type: 'string', default: '', label: 'Component' },
    hidden: { type: 'boolean', default: false, label: 'Hidden' },
    // M33: Auto grows and shrinks the component with its content (the frame tells its height); Fixed keeps its rows.
    heightMode: {
      type: { enum: ['auto', 'fixed'] },
      default: iface?.autoHeight ? 'auto' : 'fixed',
      label: 'Height',
    },
  }
  const methods: Record<string, { params: readonly string[] }> = { setHidden: { params: ['hidden'] } }
  if (!iface) {
    return {
      ...customBase,
      props,
      state: {},
      methods,
      events: [],
      defaultSize: { w: 6, h: 20 },
      openProps: true,
    }
  }
  // A library from before M33 may declare its own `heightMode`: its prop, then (it follows the default height).
  if (Object.hasOwn(iface.props, 'heightMode')) delete props.heightMode
  for (const [name, spec] of Object.entries(iface.props)) if (!Object.hasOwn(props, name)) props[name] = spec
  for (const [name, spec] of Object.entries(iface.methods))
    if (!Object.hasOwn(methods, name)) methods[name] = spec
  return {
    ...customBase,
    label: iface.label || customBase.label,
    props,
    state: Object.fromEntries(Object.entries(iface.state).map(([n, s]) => [n, { default: s.default }])),
    methods,
    events: [...iface.events],
    defaultSize: iface.defaultSize,
  }
}

export type ComponentLibraryDiagnosticCode =
  | 'schema'
  | 'invalid_path'
  | 'duplicate_path'
  | 'too_large'
  | 'invalid_name'
  | 'duplicate_name'
  | 'unknown_entry'
  | 'invalid_prop'
  | 'invalid_dependency'
  | 'invalid_origin'

export interface ComponentLibraryDiagnostic {
  severity: 'error' | 'warning'
  code: ComponentLibraryDiagnosticCode
  message: string
  path: (string | number)[]
}

export interface ComponentLibraryValidationResult {
  ok: boolean
  definition?: ComponentLibraryDefinition
  diagnostics: ComponentLibraryDiagnostic[]
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** npm's rules for a package name (lowercase, an optional scope, URL-safe). */
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
/** A semver range, a dist-tag or an exact version; no URLs, paths, git or aliases (they'd skip the registry). */
const NPM_RANGE = /^[A-Za-z0-9.^~<>=|*+\- ]+$/
/** The packages the frame gives every component; a library can't bring its own. */
export const PROVIDED_PACKAGES = ['react', 'react-dom', '@ow/component-sdk'] as const

/** Whether `path` is a library file path: relative, forward slashes, no `.`/`..` parts, a known extension. */
export function componentPathReason(path: string): string | null {
  if (!path) return 'A file needs a path'
  if (path.startsWith('/') || path.includes('\\')) return 'Use a relative path with forward slashes'
  const parts = path.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return 'A path can’t have empty, "." or ".." parts'
  if (parts.some((p) => !/^[A-Za-z0-9._@+-]+$/.test(p)))
    return 'Use letters, digits and . _ - @ + in file names'
  if (parts[0] === 'node_modules' || ['package.json', 'package-lock.json', 'library.json'].includes(path)) {
    return `"${parts[0]}" is the build’s`
  }
  if (!COMPONENT_FILE_EXTENSIONS.some((e) => path.endsWith(e))) {
    return `Files end in ${COMPONENT_FILE_EXTENSIONS.join(', ')}`
  }
  return null
}

/**
 * Why `origin` can't be an allowed origin, or null: `https://host[:port]` (a leading `*.` for subdomains), or
 * `http://localhost` / `http://127.0.0.1` with a port; no path, query or credentials.
 */
export function originReason(origin: string): string | null {
  const m = /^(https?):\/\/(\*\.)?([A-Za-z0-9.-]+)(:\d{1,5})?$/.exec(origin)
  if (!m) return 'An origin is scheme://host[:port], nothing after it'
  const [, scheme, wildcard, host = ''] = m
  const local = host === 'localhost' || host === '127.0.0.1'
  if (scheme === 'http' && !local) return 'Use https (http only for localhost)'
  if (wildcard && local) return 'No wildcard on localhost'
  if (!local && !host.includes('.')) return 'Name a full host'
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return 'Not a host name'
  return null
}

/** Checks a component library and returns every problem found. Schema problems are reported alone. */
export function validateComponentLibrary(input: unknown): ComponentLibraryValidationResult {
  const parsed = componentLibraryDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: 'error',
        code: 'schema',
        message: issue.message,
        path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
      })),
    }
  }
  const def = parsed.data
  const diagnostics: ComponentLibraryDiagnostic[] = []
  const report = (d: Omit<ComponentLibraryDiagnostic, 'severity'>) =>
    diagnostics.push({ severity: 'error', ...d })

  const paths = new Set<string>()
  let size = 0
  def.files.forEach((f, i) => {
    size += f.content.length
    const reason = componentPathReason(f.path)
    if (reason) report({ code: 'invalid_path', message: reason, path: ['files', i, 'path'] })
    else if (paths.has(f.path.toLowerCase())) {
      report({ code: 'duplicate_path', message: `Two files are at "${f.path}"`, path: ['files', i, 'path'] })
    }
    paths.add(f.path.toLowerCase())
  })
  if (size > MAX_COMPONENT_SOURCE) {
    report({
      code: 'too_large',
      message: `The source is ${Math.ceil(size / 1024)} KB; a library holds ${MAX_COMPONENT_SOURCE / 1024 / 1024} MB at most`,
      path: ['files'],
    })
  }

  const names = new Set<string>()
  def.components.forEach((c, i) => {
    const base = ['components', i]
    if (names.has(c.name))
      report({
        code: 'duplicate_name',
        message: `Two components are named "${c.name}"`,
        path: [...base, 'name'],
      })
    names.add(c.name)
    if (!def.files.some((f) => f.path === c.entry)) {
      report({ code: 'unknown_entry', message: `No file is at "${c.entry}"`, path: [...base, 'entry'] })
    } else if (!ENTRY_EXTENSIONS.some((e) => c.entry.endsWith(e))) {
      report({
        code: 'unknown_entry',
        message: 'The entry is a code file (.tsx, .ts, .jsx, .js)',
        path: [...base, 'entry'],
      })
    }
    // Props, state and methods share the instance's namespace (`custom1.name`); events are their own.
    const members = new Map<string, string>()
    const member = (kind: string, name: string, path: (string | number)[]) => {
      const reason = memberReason(name)
      if (reason) report({ code: 'invalid_name', message: reason, path })
      else if (members.has(name)) {
        report({ code: 'duplicate_name', message: `"${name}" is already a ${members.get(name)}`, path })
      }
      members.set(name, kind)
    }
    for (const [name, prop] of Object.entries(c.props)) {
      const path = [...base, 'props', name]
      member('prop', name, path)
      if (!defaultFits(prop)) {
        report({
          code: 'invalid_prop',
          message: `"${name}"’s default doesn’t fit its type`,
          path: [...path, 'default'],
        })
      }
    }
    for (const name of Object.keys(c.state)) member('state', name, [...base, 'state', name])
    for (const [name, m] of Object.entries(c.methods)) {
      member('method', name, [...base, 'methods', name])
      m.params.forEach((p, j) => {
        if (!IDENTIFIER.test(p)) {
          report({
            code: 'invalid_name',
            message: `"${p}" isn’t a parameter name`,
            path: [...base, 'methods', name, 'params', j],
          })
        }
      })
    }
    const events = new Set<string>()
    c.events.forEach((e, j) => {
      const path = [...base, 'events', j]
      if (!IDENTIFIER.test(e)) report({ code: 'invalid_name', message: `"${e}" isn’t an event name`, path })
      else if (events.has(e)) report({ code: 'duplicate_name', message: `Two events are named "${e}"`, path })
      events.add(e)
    })
  })

  for (const [name, range] of Object.entries(def.dependencies)) {
    const path = ['dependencies', name]
    if (!NPM_NAME.test(name) || name.length > 214) {
      report({ code: 'invalid_dependency', message: `"${name}" isn’t an npm package name`, path })
    } else if ((PROVIDED_PACKAGES as readonly string[]).includes(name)) {
      report({
        code: 'invalid_dependency',
        message: `"${name}" is given to every component; remove it`,
        path,
      })
    } else if (!range.trim() || !NPM_RANGE.test(range)) {
      report({
        code: 'invalid_dependency',
        message: `"${range}" isn’t a version range (URLs, git and file: aren’t allowed)`,
        path,
      })
    }
  }

  const origins = new Set<string>()
  def.allowedOrigins.forEach((o, i) => {
    const reason = originReason(o)
    if (reason) report({ code: 'invalid_origin', message: reason, path: ['allowedOrigins', i] })
    else if (origins.has(o))
      report({ code: 'invalid_origin', message: `"${o}" is listed twice`, path: ['allowedOrigins', i] })
    origins.add(o)
  })

  const ok = !diagnostics.some((d) => d.severity === 'error')
  return { ok, definition: def, diagnostics }
}

function memberReason(name: string): string | null {
  if (!IDENTIFIER.test(name)) return `"${name}" isn’t a JavaScript name`
  if (name.startsWith('$')) return 'Names starting with $ are the platform’s'
  if (isReservedWord(name)) return `"${name}" is a JavaScript keyword`
  if (RESERVED_MEMBERS.has(name)) return `"${name}" is every custom component’s`
  return null
}

/** What the validator needs to know about a component library an app uses (M25). */
export interface ComponentLibraryInfo {
  /** The live release's version, or null when it has none. */
  liveVersion: string | null
  /** Each release's components, by version. */
  versions: Record<string, ComponentLibraryInterface>
  /** The library exists but the person may not use it: reported as needing use access. */
  noUse?: boolean
}

/**
 * The library release and component a custom instance names (`version` is `latest` when missing), and the
 * `slug@version` key its release is looked up by; null when they aren't plain strings.
 */
export function customInstanceRelease(
  c: AppComponent,
): { slug: string; version: string; component: string; key: string } | null {
  if (c.type !== 'custom') return null
  const slug = c.props?.library
  const version = c.props?.version ?? 'latest'
  const component = c.props?.component
  if (typeof slug !== 'string' || !slug || typeof version !== 'string' || typeof component !== 'string')
    return null
  if (slug.includes('{{') || version.includes('{{') || component.includes('{{')) return null
  return { slug, version, component, key: `${slug}@${version}` }
}

const customPlaced = (def: AppDefinition) =>
  def.components.flatMap((c) => {
    const ref = customInstanceRelease(c)
    return ref ? [ref] : []
  })

/** The component libraries an app's custom components use, by slug, sorted. */
export const usedComponentLibraries = (def: AppDefinition): string[] =>
  [...new Set(customPlaced(def).map((r) => r.slug))].sort()

/** The `slug@version` keys of the library releases an app's custom components run, sorted. */
export const customInstanceKeys = (def: AppDefinition): string[] =>
  [...new Set(customPlaced(def).map((r) => r.key))].sort()

/** The interface of the component a custom instance names; null when it can't be told. */
export function customInstanceInterface(
  c: AppComponent,
  resolve: (slug: string) => ComponentLibraryInfo | undefined,
): CustomComponentInterface | null {
  const ref = customInstanceRelease(c)
  if (!ref) return null
  const info = resolve(ref.slug)
  const at = ref.version === 'latest' ? info?.liveVersion : ref.version
  const release = at && info && Object.hasOwn(info.versions, at) ? info.versions[at] : undefined
  return (release && Object.hasOwn(release, ref.component) ? release[ref.component] : null) ?? null
}

/** A declared default is a value, not a template: it has the prop's own type (null when nullable). */
function defaultFits({ type, default: value, nullable }: CustomPropDefinition): boolean {
  if (value === null) return nullable === true || type === 'any'
  if (typeof type === 'object') return typeof value === 'string' && type.enum.includes(value)
  switch (type) {
    case 'any':
      return true
    case 'string':
    case 'number':
    case 'boolean':
      return typeof value === type
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
  }
}
