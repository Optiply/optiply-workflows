/**
 * The app's JavaScript packages in its sandbox: the bundle (from the server, through the page) sets
 * `globalThis.__owModules`; import lines, rewritten by the app's code runner, read it through `__owImport`, with
 * the same CommonJS interop as workflows' sandbox (`default` is a CommonJS module itself, its properties are named
 * imports; ES modules are as they are).
 */

type Modules = Record<string, unknown>

/** The package `name`, as an import line reads it. */
export function owImport(name: string): unknown {
  const modules = (globalThis as { __owModules?: Modules }).__owModules
  if (!modules || !Object.hasOwn(modules, name)) {
    const slash = name.startsWith('@') ? name.indexOf('/', name.indexOf('/') + 1) : name.indexOf('/')
    if (slash > 0 && modules && Object.hasOwn(modules, name.slice(0, slash))) {
      throw new Error(
        `Import "${name}": only a package itself can be imported, from "${name.slice(0, slash)}"`,
      )
    }
    throw new Error(`The package "${name}" is not installed: add it to the app's JavaScript packages`)
  }
  const m = modules[name]
  if (m !== null && (typeof m === 'object' || typeof m === 'function')) {
    if ((m as { __esModule?: unknown }).__esModule) return m
    return new Proxy(m, { get: (target, key) => (key === 'default' ? m : Reflect.get(target, key)) })
  }
  return { default: m }
}

/** Loads a bundle into this sandbox (replacing the one before), or none. */
export function loadPackages(bundle: { js: string } | null): void {
  const g = globalThis as { __owModules?: Modules }
  delete g.__owModules
  // The bundle is an IIFE setting `globalThis.__owModules` itself: run it as a function's body.
  if (bundle) new Function(bundle.js)()
}
