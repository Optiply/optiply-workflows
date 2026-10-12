// Bundles the server (and the workspace packages it imports as TypeScript source) into dist/main.js.
// npm dependencies stay external and are installed in the image via `pnpm deploy --prod`, which only exposes
// the server's *direct* dependencies — so every external import must be declared in apps/server/package.json.
import { existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { build } from 'esbuild'

const externals = new Set()
const packageName = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/')

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'externalize-npm-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('@ow/')) return undefined
          if (!args.path.startsWith('node:') && !builtinModules.includes(args.path)) {
            externals.add(packageName(args.path))
          }
          return { path: args.path, external: true }
        })
      },
    },
  ],
})

const undeclared = [...externals].filter((name) => !existsSync(`node_modules/${name}/package.json`))
if (undeclared.length) {
  console.error(
    `✘ Bundled code imports packages not declared in apps/server/package.json: ${undeclared.join(', ')}`,
  )
  process.exit(1)
}
