import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { CliError, type Output, push } from './commands'
import { readState, SKIP, STATE_FILE } from './folder'

/** How long the folder must stay quiet after a save before it's pushed (editors write a file in several steps). */
const DEBOUNCE_MS = 300

/**
 * Pushes the folder into the library's draft on every save, then builds it and prints the problems (M33). The
 * library editor's Preview, open in a browser, rebuilds from the draft. While someone else's change to the draft (in
 * the browser) is newer, each push is refused saying so, until the folder is pulled or pushed with --force. Runs
 * until Ctrl-C.
 */
export async function dev(opts: { dir?: string }, io: Output): Promise<void> {
  const dir = resolve(opts.dir ?? '.')
  const state = await readState(dir)
  if (!state)
    throw new CliError(`${dir} isn't a library's folder (no .ow-components.json): init or pull first`)
  let timer: NodeJS.Timeout | null = null
  let running = false
  let again = false
  const once = async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await push({ dir, build: true, onlyIfChanged: true }, io)
    } catch (err) {
      io.err((err as Error).message)
    } finally {
      running = false
      if (again) {
        again = false
        schedule()
      }
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void once(), DEBOUNCE_MS)
  }

  // Watching first, then said, then the first push: a save right after the message is seen.
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    const name = String(file ?? '')
    if (!name || name === STATE_FILE || name.split(/[\\/]/).some((p) => p.startsWith('.') || SKIP.has(p))) {
      return
    }
    schedule()
  })
  io.out(`Watching ${dir} for ${state.slug} on ${state.url} (Ctrl-C to stop)`)
  await once()
  await new Promise<void>((done) => {
    const stop = () => {
      watcher.close()
      if (timer) clearTimeout(timer)
      done()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
