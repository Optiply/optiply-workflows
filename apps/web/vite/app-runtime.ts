import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

/**
 * `virtual:app-runtime`: the script of an app's sandbox (src/pages/apps/runtime/sandbox-entry.ts and what it
 * imports), bundled by esbuild into one IIFE and exported as a string. The sandbox is an iframe with an opaque
 * origin and no network access running the app in a Worker, so this code is written into the frame's document,
 * which starts the Worker from it through a blob: URL, rather than loaded from a URL. Rebuilt whenever a file it
 * includes changes.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A virtual module exporting one entry's IIFE bundle as a string; rebuilt whenever a file it includes changes. */
function bundledScript(
  name: string,
  id: string,
  entry: string,
  options: { define?: (minify: boolean) => Record<string, string> } = {},
): Plugin {
  const resolved = `\0${id}`
  let minify = false
  return {
    name,
    configResolved(config) {
      minify = config.command === 'build'
    },
    resolveId: (source) => (source === id ? resolved : undefined),
    async load(loading) {
      if (loading !== resolved) return
      const result = await build({
        entryPoints: [entry],
        absWorkingDir: ROOT,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify,
        legalComments: 'none',
        write: false,
        metafile: true,
        logLevel: 'silent',
        ...(options.define && { define: options.define(minify) }),
      })
      for (const input of Object.keys(result.metafile.inputs)) {
        if (!input.includes('node_modules')) this.addWatchFile(resolve(ROOT, input))
      }
      return `export default ${JSON.stringify(result.outputFiles[0]!.text)}`
    },
  }
}

export function appRuntimePlugin(): Plugin {
  return bundledScript(
    'ow-app-runtime',
    'virtual:app-runtime',
    resolve(ROOT, 'src/pages/apps/runtime/sandbox-entry.ts'),
  )
}

/**
 * `virtual:component-frame` (M25): the script of a custom component's frame (`@ow/component-sdk`'s `frame.tsx`:
 * React, ReactDOM, the SDK and the message handling), written into the frame's document like the app sandbox's.
 * React needs `process.env.NODE_ENV` replaced.
 */
export function componentFramePlugin(): Plugin {
  return bundledScript(
    'ow-component-frame',
    'virtual:component-frame',
    resolve(ROOT, '../../packages/component-sdk/src/frame.tsx'),
    {
      define: (minify) => ({ 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') }),
    },
  )
}
