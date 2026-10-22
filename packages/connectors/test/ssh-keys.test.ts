import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ssh2 from 'ssh2'
import { describe, expect, it } from 'vitest'
import { readPrivateKey, type SshKeyErrorCode } from '../src/ssh/keys'

/** Keys made with ssh-keygen and puttygen (test/fixtures/ssh/README.md); the encrypted ones' passphrase. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
const PASS = 'fixture pass'

/** What `ssh-keygen -l` would say for a public key line, and its blob. */
function publicOf(line: string) {
  const [type, base64] = line.trim().split(' ') as [string, string]
  const blob = Buffer.from(base64, 'base64')
  return {
    type,
    blob,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  }
}

/** The key as read signs, and its public half (from the .pub file) verifies: the private parts are right. */
function signsFor(privateKey: string, passphrase: string | undefined, publicLine: string) {
  const priv = ssh2.utils.parseKey(privateKey, passphrase)
  const pub = ssh2.utils.parseKey(publicLine)
  if (priv instanceof Error || pub instanceof Error) throw new Error('unparsable')
  const data = Buffer.from('M17 fixture check')
  return pub.verify(data, priv.sign(data))
}

const errorOf = (fn: () => unknown): SshKeyErrorCode | undefined => {
  try {
    fn()
  } catch (err) {
    return (err as { code?: SshKeyErrorCode }).code
  }
  return undefined
}

/** M17 step 1a: private keys for SSH tunnels, in every format an admin might have. */
describe('readPrivateKey', () => {
  const cases: [file: string, pub: string, format: 'openssh' | 'pem' | 'ppk', encrypted: boolean][] = [
    ['openssh-ed25519', 'openssh-ed25519.pub', 'openssh', false],
    ['openssh-rsa', 'openssh-rsa.pub', 'openssh', false],
    ['openssh-rsa-encrypted', 'openssh-rsa-encrypted.pub', 'openssh', true],
    ['openssh-ecdsa256', 'openssh-ecdsa256.pub', 'openssh', false],
    ['openssh-ecdsa384', 'openssh-ecdsa384.pub', 'openssh', false],
    ['pem-rsa', 'pem-rsa.pub', 'pem', false],
    ['pem-ecdsa', 'pem-ecdsa.pub', 'pem', false],
    ['ppk2-rsa.ppk', 'openssh-rsa.pub', 'ppk', false],
    ['ppk2-rsa-encrypted.ppk', 'openssh-rsa.pub', 'ppk', true],
    ['ppk2-ed25519.ppk', 'openssh-ed25519.pub', 'ppk', false],
    ['ppk3-ed25519.ppk', 'openssh-ed25519.pub', 'ppk', false],
    ['ppk3-ed25519-encrypted.ppk', 'openssh-ed25519.pub', 'ppk', true],
    ['ppk3-ecdsa256.ppk', 'openssh-ecdsa256.pub', 'ppk', false],
    ['ppk3-ecdsa384-encrypted.ppk', 'openssh-ecdsa384.pub', 'ppk', true],
    ['ppk3-rsa-encrypted.ppk', 'openssh-rsa.pub', 'ppk', true],
  ]
  for (const [file, pubFile, format, encrypted] of cases) {
    it(`reads ${file}`, () => {
      const expected = publicOf(fixture(pubFile))
      const key = readPrivateKey(fixture(file), encrypted ? PASS : undefined)
      expect(key.format).toBe(format)
      expect(key.type).toBe(expected.type)
      expect(key.fingerprint).toBe(expected.fingerprint)
      expect(publicOf(key.publicKey).blob.equals(expected.blob)).toBe(true)
      expect(signsFor(key.privateKey, key.passphrase, fixture(pubFile))).toBe(true)
      // Only an OpenSSH key goes to ssh2 still encrypted; the others are opened here.
      expect(key.passphrase).toBe(format === 'openssh' && encrypted ? PASS : undefined)
    })
  }

  it("checks a key against its own public half only (the check above isn't vacuous)", () => {
    const other = readPrivateKey(fixture('ppk3-rsa-encrypted.ppk'), PASS)
    expect(signsFor(other.privateKey, undefined, fixture('pem-rsa.pub'))).toBe(false)
  })

  it('keeps the comment in the public half', () => {
    expect(readPrivateKey(fixture('ppk3-ed25519.ppk')).publicKey).toMatch(/ fixture-ed25519$/)
    expect(readPrivateKey(fixture('openssh-rsa')).publicKey).toMatch(/ fixture-rsa-plain$/)
  })

  it('reads keys pasted with Windows line ends', () => {
    for (const file of ['ppk3-ed25519-encrypted.ppk', 'openssh-ed25519', 'pem-rsa']) {
      const key = readPrivateKey(fixture(file).replace(/\n/g, '\r\n'), PASS)
      expect(key.type).toBeTruthy()
    }
  })

  it('reads PKCS#8 keys (RSA, EC, Ed25519), encrypted ones too', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-521' })
    const ed = generateKeyPairSync('ed25519')
    for (const [pair, type] of [
      [rsa, 'ssh-rsa'],
      [ec, 'ecdsa-sha2-nistp521'],
      [ed, 'ssh-ed25519'],
    ] as const) {
      const plain = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
      const encrypted = pair.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: PASS,
      }) as string
      for (const [text, pass] of [
        [plain, undefined],
        [encrypted, PASS],
      ] as const) {
        const key = readPrivateKey(text, pass)
        expect(key.type).toBe(type)
        expect(key.format).toBe('pem')
        expect(signsFor(key.privateKey, undefined, key.publicKey)).toBe(true)
      }
      expect(errorOf(() => readPrivateKey(encrypted))).toBe('passphrase_needed')
      expect(errorOf(() => readPrivateKey(encrypted, 'nope'))).toBe('wrong_passphrase')
    }
  })

  it('says when an encrypted key needs its passphrase, or got the wrong one', () => {
    for (const file of ['openssh-rsa-encrypted', 'ppk2-rsa-encrypted.ppk', 'ppk3-ed25519-encrypted.ppk']) {
      expect(errorOf(() => readPrivateKey(fixture(file)))).toBe('passphrase_needed')
      expect(errorOf(() => readPrivateKey(fixture(file), 'not it'))).toBe('wrong_passphrase')
    }
  })

  it('refuses what is not a private key it can use, saying why', () => {
    expect(() => readPrivateKey(fixture('openssh-ed25519.pub'))).toThrow(/public key/)
    expect(errorOf(() => readPrivateKey('hello'))).toBe('unreadable')
    // A damaged .ppk: its MAC no longer matches.
    const damaged = fixture('ppk3-ed25519.ppk').replace(
      /Private-MAC: (.)/,
      (_, c) => `Private-MAC: ${c === 'a' ? 'b' : 'a'}`,
    )
    expect(() => readPrivateKey(damaged)).toThrow(/damaged/)
    const dsa = generateKeyPairSync('dsa', { modulusLength: 2048, divisorLength: 256 })
    expect(
      errorOf(() => readPrivateKey(dsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)),
    ).toBe('unsupported')
    expect(errorOf(() => readPrivateKey(fixture('ppk2-rsa.ppk').replace('File-2', 'File-4')))).toBe(
      'unsupported',
    )
  })
})
