import { readFileSync } from 'node:fs'
import { secretStrings } from '@ow/crypto'
import { describe, expect, it } from 'vitest'
import { normalizeSsh, SshSettingsError, sshConfigSchema, sshCredentials } from '../src/ssh/settings'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
const hop = (id: string, auth: 'key' | 'password' = 'key') => ({
  id,
  host: `${id}.example.com`,
  port: 22,
  username: 'ow',
  auth,
})

/** M17 step 1b: a resource configuration's SSH tunnel settings. */
describe('SSH settings', () => {
  it('allows the server and two jump hosts, each with its own id', () => {
    expect(sshConfigSchema.safeParse({ hops: [hop('a'), hop('b'), hop('c')] }).success).toBe(true)
    expect(sshConfigSchema.safeParse({ hops: [hop('a'), hop('b'), hop('c'), hop('d')] }).success).toBe(false)
    expect(sshConfigSchema.safeParse({ hops: [] }).success).toBe(false)
    expect(sshConfigSchema.safeParse({ hops: [hop('a'), hop('a')] }).success).toBe(false)
    expect(sshConfigSchema.parse({ hops: [{ id: 'a', host: ' h ', username: 'u' }] }).hops[0]).toEqual({
      id: 'a',
      host: 'h',
      port: 22,
      username: 'u',
      auth: 'key',
    })
  })

  it('drops every SSH secret when the tunnel is turned off', () => {
    expect(normalizeSsh({ hops: [hop('a')] }, undefined, { a: { privateKey: 'k' } })).toEqual({
      ssh: undefined,
      secrets: undefined,
    })
  })

  it('reads each hop: a PuTTY key with its passphrase, or a password', () => {
    const ssh = { hops: [hop('jump', 'password'), hop('server')] }
    const credentials = sshCredentials(ssh, {
      jump: { password: 'pw' },
      server: { privateKey: fixture('ppk3-ed25519-encrypted.ppk'), passphrase: 'fixture pass' },
    })
    expect(credentials.get('jump')).toEqual({ password: 'pw' })
    expect(credentials.get('server')).toMatchObject({ key: { type: 'ssh-ed25519', format: 'ppk' } })
  })

  it("names the hop and the field that's wrong, never a secret", () => {
    const key = fixture('ppk3-ed25519-encrypted.ppk')
    const attempt = () =>
      sshCredentials(
        { hops: [hop('server')] },
        { server: { privateKey: key, passphrase: 'Wr0ng-Passphrase-77' } },
      )
    expect(attempt).toThrow(SshSettingsError)
    try {
      attempt()
    } catch (err) {
      const e = err as SshSettingsError
      expect([e.hopId, e.field]).toEqual(['server', 'passphrase'])
      expect(e.message).not.toContain('Wr0ng-Passphrase-77')
    }
  })

  it('lets error scrubbing find SSH secrets like any other (they are nested)', () => {
    expect(
      secretStrings({ password: 'p', ssh: { server: { privateKey: 'KEY', passphrase: 'PASS' } } }),
    ).toEqual(['p', 'KEY', 'PASS'])
  })
})
