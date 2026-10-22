import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { readPrivateKey, SshTunnel } from '@ow/connectors'
import { startTestSshServer, type TestSshServer } from '@ow/connectors/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { logSshTunnels } from '../src/services/ssh-log'

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/connectors/test/fixtures/ssh/${name}`, import.meta.url), 'utf8')

let ssh: TestSshServer
let echo: Server
let port: number
beforeAll(async () => {
  echo = createServer((s) => s.on('data', (d) => s.write(d)))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  port = (echo.address() as { port: number }).port
  ssh = await startTestSshServer({ users: [{ username: 'ow', password: 'Ssh-Log-Secret-1185' }] })
})
afterAll(async () => {
  await ssh?.close()
  await new Promise((r) => echo?.close(r))
})

/** M17 step 6: what the log says about tunnels, and that it never holds a secret. */
describe('SSH tunnel log lines', () => {
  it('logs connecting, dropping, connecting again and failing, without secrets', async () => {
    const lines: { level: string; fields: Record<string, unknown>; message: string }[] = []
    const stop = logSshTunnels({
      info: ((fields: Record<string, unknown>, message: string) =>
        lines.push({ level: 'info', fields, message })) as never,
      warn: ((fields: Record<string, unknown>, message: string) =>
        lines.push({ level: 'warn', fields, message })) as never,
    })
    const hop = { id: 'srv', host: ssh.host, port: ssh.port, username: 'ow', hostKey: ssh.hostKey }
    const tunnel = new SshTunnel([{ ...hop, credential: { password: 'Ssh-Log-Secret-1185' } }])
    try {
      ;(await tunnel.open('127.0.0.1', port)).end()
      ssh.dropAll()
      await vi.waitFor(() => expect(lines.map((l) => l.message)).toContain('ssh tunnel dropped'))
      ;(await tunnel.open('127.0.0.1', port)).end()
      await tunnel.close()
      const untrusted = new SshTunnel([
        { ...hop, hostKey: undefined, credential: { key: readPrivateKey(fixture('openssh-ed25519')) } },
      ])
      await untrusted.open('127.0.0.1', port).catch(() => {})
      await untrusted.close()
    } finally {
      stop()
    }
    const server = `ow@${ssh.host}:${ssh.port}`
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ['info', 'ssh tunnel connected'],
      ['warn', 'ssh tunnel dropped'],
      ['warn', 'ssh tunnel connected again'],
      ['warn', 'ssh tunnel failed'],
    ])
    expect(lines[0]!.fields).toMatchObject({ servers: [server], durationMs: expect.any(Number) })
    expect(lines[3]!.fields).toMatchObject({ servers: [server], hop: 'srv', code: 'ssh_host_key_unknown' })
    const logged = JSON.stringify(lines)
    expect(logged).not.toContain('Ssh-Log-Secret-1185')
    expect(logged).not.toContain('PRIVATE KEY')
  })
})
