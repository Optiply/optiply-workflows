import {
  argon2Sync,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import ssh2 from 'ssh2'

/**
 * A private key for an SSH tunnel (M17), read from what an admin pasted or uploaded: OpenSSH (`BEGIN OPENSSH PRIVATE
 * KEY`, encrypted too), PEM or PKCS#8 (RSA, EC, Ed25519), or PuTTY's `.ppk` versions 2 and 3. `ssh2` reads OpenSSH keys
 * itself; everything else is turned into an unencrypted OpenSSH key here, in memory, since `ssh2` 1.17 reads neither
 * PKCS#8, an EC PEM key, nor a `.ppk` other than version 2 with RSA or DSA.
 */
export interface SshKey {
  /** What `ssh2` is given (with `passphrase`, for an encrypted OpenSSH key). */
  privateKey: string
  passphrase?: string
  /** `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`… */
  type: string
  /** `SHA256:` and the public key's hash, as `ssh-keygen -l` shows it. */
  fingerprint: string
  /** The public half as an `authorized_keys` line (not secret). */
  publicKey: string
  format: 'openssh' | 'pem' | 'ppk'
}

/** The most a `.ppk` file may ask Argon2 for: it runs in the server, on every read of the key. */
const ARGON2_MAX_MEMORY_KIB = 256 * 1024
const ARGON2_MAX_PASSES = 256

export type SshKeyErrorCode = 'passphrase_needed' | 'wrong_passphrase' | 'unreadable' | 'unsupported'

export class SshKeyError extends Error {
  override name = 'SshKeyError'
  constructor(
    readonly code: SshKeyErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Reads a private key; throws `SshKeyError` saying why it can't (a passphrase needed or wrong, not a key). */
export function readPrivateKey(text: string, passphrase?: string | null): SshKey {
  const key = text.replace(/\r\n?/g, '\n').trim()
  const pass = passphrase || undefined
  if (key.startsWith('PuTTY-User-Key-File-')) return fromParts(readPpk(key, pass), 'ppk')
  if (key.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) return readOpenSsh(`${key}\n`, pass)
  if (/-----BEGIN (RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(key))
    return fromParts(readPem(key, pass), 'pem')
  if (/^(ssh-|ecdsa-)\S+ [A-Za-z0-9+/=]+/.test(key))
    throw new SshKeyError('unreadable', 'This is a public key: paste the private key (the file without .pub)')
  throw new SshKeyError(
    'unreadable',
    "This isn't a private key in a format we read (OpenSSH, PEM or PuTTY .ppk)",
  )
}

function readOpenSsh(key: string, passphrase: string | undefined): SshKey {
  const parsed = ssh2.utils.parseKey(key, passphrase)
  if (parsed instanceof Error) {
    if (/no passphrase given/.test(parsed.message)) throw needed()
    if (/bad passphrase/.test(parsed.message)) throw wrong()
    throw new SshKeyError('unreadable', `The key couldn't be read: ${parsed.message}`)
  }
  return describe(parsed, key, passphrase, 'openssh')
}

/** A key's parts, enough to write it as an OpenSSH key. */
type KeyParts =
  | { type: 'ssh-rsa'; n: Buffer; e: Buffer; d: Buffer; p: Buffer; q: Buffer; iqmp: Buffer; comment: string }
  | { type: 'ssh-ed25519'; pub: Buffer; seed: Buffer; comment: string }
  | { type: `ecdsa-sha2-${Curve}`; curve: Curve; q: Buffer; d: Buffer; comment: string }

type Curve = 'nistp256' | 'nistp384' | 'nistp521'
const CURVES: Record<string, Curve> = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }

function fromParts(parts: KeyParts, format: SshKey['format']): SshKey {
  const key = openSshKey(parts)
  const parsed = ssh2.utils.parseKey(key)
  if (parsed instanceof Error)
    throw new SshKeyError('unreadable', `The key couldn't be read: ${parsed.message}`)
  return describe(parsed, key, undefined, format)
}

function describe(
  parsed: ssh2.ParsedKey,
  privateKey: string,
  passphrase: string | undefined,
  format: SshKey['format'],
): SshKey {
  const blob = parsed.getPublicSSH()
  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
  const publicKey = [parsed.type, blob.toString('base64'), parsed.comment].filter(Boolean).join(' ')
  return {
    privateKey,
    ...(passphrase ? { passphrase } : {}),
    type: parsed.type,
    fingerprint,
    publicKey,
    format,
  }
}

// PEM and PKCS#8, through node:crypto.

function readPem(key: string, passphrase: string | undefined): KeyParts {
  if (key.includes('BEGIN DSA PRIVATE KEY'))
    throw unsupported("DSA keys aren't supported (OpenSSH dropped them)")
  const encrypted = key.includes('BEGIN ENCRYPTED PRIVATE KEY') || /Proc-Type: 4,ENCRYPTED/.test(key)
  if (encrypted && !passphrase) throw needed()
  let jwk: Record<string, string | undefined>
  let kind: string | undefined
  try {
    const object = createPrivateKey({ key, format: 'pem', ...(passphrase ? { passphrase } : {}) })
    kind = object.asymmetricKeyType
    if (kind !== 'rsa' && kind !== 'ec' && kind !== 'ed25519')
      throw unsupported(`${kind ?? 'These'} keys aren't supported`)
    jwk = object.export({ format: 'jwk' }) as Record<string, string | undefined>
  } catch (err) {
    if (err instanceof SshKeyError) throw err
    if (encrypted) throw wrong()
    throw new SshKeyError('unreadable', `The key couldn't be read: ${(err as Error).message}`)
  }
  const b = (v: string | undefined) => Buffer.from(v ?? '', 'base64url')
  if (kind === 'rsa') {
    return {
      type: 'ssh-rsa',
      n: b(jwk.n),
      e: b(jwk.e),
      d: b(jwk.d),
      p: b(jwk.p),
      q: b(jwk.q),
      iqmp: b(jwk.qi),
      comment: '',
    }
  }
  if (kind === 'ed25519') return { type: 'ssh-ed25519', pub: b(jwk.x), seed: b(jwk.d), comment: '' }
  const curve = CURVES[jwk.crv ?? '']
  if (!curve) throw unsupported(`The ${jwk.crv} curve isn't supported`)
  return {
    type: `ecdsa-sha2-${curve}`,
    curve,
    q: Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]),
    d: b(jwk.d),
    comment: '',
  }
}

// PuTTY's .ppk, versions 2 and 3 (https://the.earth.li/~sgtatham/putty/0.78/htmldoc/AppendixC.html).

function readPpk(key: string, passphrase: string | undefined): KeyParts {
  const lines = key.split('\n')
  const header = /^PuTTY-User-Key-File-(\d+): (\S+)$/.exec(lines[0] ?? '')
  if (!header) throw new SshKeyError('unreadable', "This .ppk file's first line isn't PuTTY's")
  const version = Number(header[1])
  const algorithm = header[2]!
  if (version !== 2 && version !== 3)
    throw unsupported(`PuTTY key files of version ${version} aren't supported`)
  const fields = new Map<string, string>()
  const blocks = new Map<string, Buffer>()
  for (let i = 1; i < lines.length; i++) {
    const field = /^([A-Za-z0-9-]+): ?(.*)$/.exec(lines[i]!)
    if (!field) throw new SshKeyError('unreadable', `This .ppk file is damaged (line ${i + 1})`)
    const [, name, value] = field as unknown as [string, string, string]
    if (name === 'Public-Lines' || name === 'Private-Lines') {
      const count = Number(value)
      blocks.set(name, Buffer.from(lines.slice(i + 1, i + 1 + count).join(''), 'base64'))
      i += count
    } else fields.set(name, value)
  }
  const publicBlob = blocks.get('Public-Lines')
  let privateBlob = blocks.get('Private-Lines')
  const encryption = fields.get('Encryption')
  const comment = fields.get('Comment') ?? ''
  const mac = fields.get('Private-MAC')
  if (!publicBlob || !privateBlob || !encryption || !mac)
    throw new SshKeyError('unreadable', 'This .ppk file is missing parts of the key')
  if (encryption !== 'none' && encryption !== 'aes256-cbc')
    throw unsupported(`This .ppk file's ${encryption} encryption isn't supported`)
  const encrypted = encryption === 'aes256-cbc'
  if (encrypted && !passphrase) throw needed()
  const pass = Buffer.from(encrypted ? (passphrase ?? '') : '', 'utf8')

  let macKey: Buffer
  let macAlgorithm: 'sha1' | 'sha256'
  if (version === 2) {
    macAlgorithm = 'sha1'
    macKey = createHash('sha1').update('putty-private-key-file-mac-key').update(pass).digest()
    if (encrypted) {
      const cipherKey = Buffer.concat([
        createHash('sha1')
          .update(Buffer.from([0, 0, 0, 0]))
          .update(pass)
          .digest(),
        createHash('sha1')
          .update(Buffer.from([0, 0, 0, 1]))
          .update(pass)
          .digest(),
      ]).subarray(0, 32)
      privateBlob = decrypt(privateBlob, cipherKey, Buffer.alloc(16))
    }
  } else {
    macAlgorithm = 'sha256'
    macKey = Buffer.alloc(0)
    if (encrypted) {
      const derivation = fields.get('Key-Derivation')
      const variant = { Argon2id: 'argon2id', Argon2i: 'argon2i', Argon2d: 'argon2d' }[derivation ?? ''] as
        | 'argon2id'
        | 'argon2i'
        | 'argon2d'
        | undefined
      if (!variant) throw unsupported(`This .ppk file's ${derivation} key derivation isn't supported`)
      // The file sets Argon2's cost: within limits, since it runs here (PuTTY's own are 8 MiB and passes for ~0.1 s).
      const memory = Number(fields.get('Argon2-Memory'))
      const passes = Number(fields.get('Argon2-Passes'))
      const parallelism = Number(fields.get('Argon2-Parallelism'))
      const within = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max
      if (
        !within(memory, ARGON2_MAX_MEMORY_KIB) ||
        !within(passes, ARGON2_MAX_PASSES) ||
        !within(parallelism, 16)
      )
        throw unsupported(
          `This .ppk file's Argon2 settings are missing or too costly (memory up to ${ARGON2_MAX_MEMORY_KIB / 1024} MiB, up to ${ARGON2_MAX_PASSES} passes)`,
        )
      let derived: Buffer
      try {
        derived = argon2Sync(variant, {
          message: pass,
          nonce: Buffer.from(fields.get('Argon2-Salt') ?? '', 'hex'),
          memory,
          passes,
          parallelism,
          tagLength: 80,
        })
      } catch (err) {
        throw new SshKeyError(
          'unreadable',
          `This .ppk file's key derivation failed: ${(err as Error).message}`,
        )
      }
      macKey = derived.subarray(48, 80)
      privateBlob = decrypt(privateBlob, derived.subarray(0, 32), derived.subarray(32, 48))
    }
  }
  const expected = createHmac(macAlgorithm, macKey)
    .update(
      Buffer.concat([
        sshString(algorithm),
        sshString(encryption),
        sshString(comment),
        sshString(publicBlob),
        sshString(privateBlob),
      ]),
    )
    .digest()
  const given = Buffer.from(mac, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    if (encrypted) throw wrong()
    throw new SshKeyError('unreadable', 'This .ppk file is damaged: its check (Private-MAC) fails')
  }

  const pub = new Reader(publicBlob)
  const priv = new Reader(privateBlob)
  if (pub.string().toString() !== algorithm) throw new SshKeyError('unreadable', 'This .ppk file is damaged')
  if (algorithm === 'ssh-rsa') {
    const e = pub.string()
    const n = pub.string()
    return {
      type: 'ssh-rsa',
      n,
      e,
      d: priv.string(),
      p: priv.string(),
      q: priv.string(),
      iqmp: priv.string(),
      comment,
    }
  }
  if (algorithm === 'ssh-ed25519')
    return { type: 'ssh-ed25519', pub: pub.string(), seed: priv.string(), comment }
  const ecdsa = /^ecdsa-sha2-(nistp256|nistp384|nistp521)$/.exec(algorithm)
  if (ecdsa) {
    const curve = ecdsa[1] as Curve
    pub.string()
    return { type: `ecdsa-sha2-${curve}`, curve, q: pub.string(), d: priv.string(), comment }
  }
  if (algorithm === 'ssh-dss') throw unsupported("DSA keys aren't supported (OpenSSH dropped them)")
  throw unsupported(`${algorithm} keys aren't supported`)
}

function decrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (data.length % 16) throw new SshKeyError('unreadable', 'This .ppk file is damaged')
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

// The OpenSSH private key format (PROTOCOL.key in OpenSSH's sources), unencrypted.

function openSshKey(parts: KeyParts): string {
  let publicBlob: Buffer
  let privateFields: Buffer[]
  if (parts.type === 'ssh-rsa') {
    publicBlob = Buffer.concat([sshString(parts.type), mpint(parts.e), mpint(parts.n)])
    privateFields = [parts.n, parts.e, parts.d, parts.iqmp, parts.p, parts.q].map(mpint)
  } else if (parts.type === 'ssh-ed25519') {
    publicBlob = Buffer.concat([sshString(parts.type), sshString(parts.pub)])
    privateFields = [sshString(parts.pub), sshString(Buffer.concat([parts.seed, parts.pub]))]
  } else {
    publicBlob = Buffer.concat([sshString(parts.type), sshString(parts.curve), sshString(parts.q)])
    privateFields = [sshString(parts.curve), sshString(parts.q), mpint(parts.d)]
  }
  const check = randomBytes(4)
  let section = Buffer.concat([
    check,
    check,
    sshString(parts.type),
    ...privateFields,
    sshString(parts.comment),
  ])
  const padding = (8 - (section.length % 8)) % 8
  section = Buffer.concat([section, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(publicBlob),
    sshString(section),
  ])
  const base64 = body.toString('base64').replace(/.{1,70}/g, '$&\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}-----END OPENSSH PRIVATE KEY-----\n`
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function sshString(value: string | Buffer): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([uint32(b.length), b])
}

/** An unsigned big-endian integer as an SSH mpint: no leading zeros, but one when the high bit is set. */
function mpint(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start++
  let b = value.subarray(start)
  if (b.length && (b[0]! & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b])
  return sshString(b)
}

/** Reads SSH strings (and mpints, which are strings) one after another. */
class Reader {
  private at = 0
  constructor(private data: Buffer) {}
  string(): Buffer {
    if (this.at + 4 > this.data.length) throw new SshKeyError('unreadable', 'This key is damaged')
    const length = this.data.readUInt32BE(this.at)
    const end = this.at + 4 + length
    if (end > this.data.length) throw new SshKeyError('unreadable', 'This key is damaged')
    const value = this.data.subarray(this.at + 4, end)
    this.at = end
    return value
  }
}

const needed = () => new SshKeyError('passphrase_needed', 'This key is encrypted: enter its passphrase')
const wrong = () => new SshKeyError('wrong_passphrase', "The passphrase doesn't open this key")
const unsupported = (message: string) => new SshKeyError('unsupported', message)
