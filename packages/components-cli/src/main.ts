import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { ApiError, CliError, init, login, type Output, pull, push, pushPrebuilt } from './commands'
import { dev } from './dev'

const HELP = `ow-components: work on Optiply Workflows component libraries from a folder

  ow-components login <url> [--token <owpat_…>]   sign in (the token from Settings → Access tokens; asked if not given)
  ow-components init <slug> [--name <name>] [--dir <dir>]
                                                 create a library on the instance and its folder
  ow-components pull <slug> [--dir <dir>] [--force]
                                                 the library's draft into a folder
  ow-components push [--dir <dir>] [--build] [--publish <version> [--notes <text>]] [--force]
                                                 the folder into the draft (then build, publish)
  ow-components push --prebuilt <dir> [--slug <slug>] [--version <version>] [--notes <text>]
                                                 a release from manifest.json, bundle.js and bundle.css
  ow-components dev [--dir <dir>]                 push on every save, build, print problems

In CI: OW_URL and OW_TOKEN instead of login. The folder is the Git layout: library.json, package.json, src/.`

const options = {
  token: { type: 'string' },
  name: { type: 'string' },
  dir: { type: 'string' },
  force: { type: 'boolean' },
  build: { type: 'boolean' },
  publish: { type: 'string' },
  notes: { type: 'string' },
  prebuilt: { type: 'string' },
  slug: { type: 'string' },
  version: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

const io: Output = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

async function readToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text.trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('Access token (Settings → Access tokens): ')).trim()
  } finally {
    rl.close()
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true })
  const [command, arg] = positionals
  if (values.help || !command) {
    io.out(HELP)
    return command || values.help ? 0 : 1
  }
  switch (command) {
    case 'login':
      if (!arg) throw new CliError('login <url>')
      await login(arg, values.token ?? (await readToken()), io)
      return 0
    case 'init':
      if (!arg) throw new CliError('init <slug>')
      await init(arg, { name: values.name, dir: values.dir }, io)
      return 0
    case 'pull':
      await pull(arg, { dir: values.dir, force: values.force }, io)
      return 0
    case 'push':
      if (values.prebuilt) {
        await pushPrebuilt(
          values.prebuilt,
          { slug: values.slug, version: values.version, notes: values.notes },
          io,
        )
        return 0
      }
      return (await push(
        {
          dir: values.dir,
          force: values.force,
          build: values.build,
          publish: values.publish,
          notes: values.notes,
        },
        io,
      ))
        ? 0
        : 1
    case 'dev':
      await dev({ dir: values.dir }, io)
      return 0
    default:
      throw new CliError(`Unknown command ${command}: ow-components --help`)
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof CliError || err instanceof ApiError) io.err(err.message)
    else if (err instanceof TypeError && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS')) {
      io.err(`${err.message}: ow-components --help`)
    } else io.err(String((err as Error)?.stack ?? err))
    process.exit(1)
  },
)
