import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

/**
 * `virtual:app-runtime`: the script of an app's sandbox (src/pages/apps/runtime/sandbox-entry.ts and what it
 * imports), bundled by esbuild into one IIFE and exported as a string. The sandbox is an iframe with an opaque
 * origin and no network access, so its code is written into the frame's document rather than loaded from a URL.
 * Rebuilt whenever a file it includes changes.
 */
const ID = 'virtual:app-runtime'
const RESOLVED = `\0${ID}`
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = resolve(ROOT, 'src/pages/apps/runtime/sandbox-entry.ts')

export function appRuntimePlugin(): Plugin {
  let minify = false
  return {
    name: 'ow-app-runtime',
    configResolved(config) {
      minify = config.command === 'build'
    },
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    async load(id) {
      if (id !== RESOLVED) return
      const result = await build({
        entryPoints: [ENTRY],
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
      })
      for (const input of Object.keys(result.metafile.inputs)) {
        if (!input.includes('node_modules')) this.addWatchFile(resolve(ROOT, input))
      }
      return `export default ${JSON.stringify(result.outputFiles[0]!.text)}`
    },
  }
}
