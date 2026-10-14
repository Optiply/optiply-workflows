import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// isolated-vm 7.0.1 drained expired timers recursively on its timer thread, one stack frame per timer. Every
// eval with a `timeout` leaves a timer behind until it would have fired, so when a few thousand of them expire
// together (a burst of fast evaluations, then the thread wakes late) its stack overflows and the process dies
// with SIGILL. Fixed upstream in laverdet/isolated-vm#574 (unreleased), applied by
// `patches/isolated-vm@7.0.1.patch`. The child is stopped until every timer has expired, so they all expire
// together however fast the machine is; a crash would take the process down, hence the child.
const TIMERS = 20_000
const TIMEOUT_MS = 300
const script = `
const ivm = require('isolated-vm')
const context = new ivm.Isolate({ memoryLimit: 32 }).createContextSync()
for (let i = 0; i < ${TIMERS}; i++) context.evalSync('1 + 1', { timeout: ${TIMEOUT_MS} })
console.log('ready')
setTimeout(() => console.log('survived'), 500)
`

describe('isolated-vm timers', () => {
  it(`survives ${TIMERS} expired timers draining at once`, async () => {
    const child = spawn(process.execPath, ['--no-node-snapshot', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    const ready = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes('ready')) resolve()
      })
    })
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    await ready
    child.kill('SIGSTOP')
    await sleep(TIMEOUT_MS + 500)
    child.kill('SIGCONT')
    const [status, signal] = await exited
    expect({ status, signal, stdout: stdout.trim().split('\n') }).toEqual({
      status: 0,
      signal: null,
      stdout: ['ready', 'survived'],
    })
  })
})
