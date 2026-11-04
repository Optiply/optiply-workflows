import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseServiceAccountKey, serverIdentity, serviceAccountTokens } from '../src/google-auth'
import { ConnectorError } from '../src/types'
import { FakeGoogle } from './google-fake'

const fake = new FakeGoogle()
const scope = 'https://www.googleapis.com/auth/cloud-platform'
const signal = new AbortController().signal
const dir = mkdtempSync(join(tmpdir(), 'ow-google-auth-'))
const file = (name: string, text: string) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

beforeAll(() => fake.start())
afterAll(() => fake.stop())

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ConnectorError)
  return err as ConnectorError
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  await new Promise((r) => server.close(r))
  return port
}

describe('serviceAccountTokens', () => {
  it('caches the token and fetches a new one when forced', async () => {
    const key = parseServiceAccountKey(fake.keyJson, 'iapKey')
    const tokens = serviceAccountTokens(key, { scope, field: 'iapKey', tokenUrl: fake.tokenUrl })
    const before = fake.issued.jwt
    const first = await tokens.token(signal)
    expect(await tokens.token(signal)).toBe(first)
    expect(await tokens.token(signal, true)).not.toBe(first)
    expect(fake.issued.jwt).toBe(before + 2)
  })

  it('names the field, never the key, when the key is wrong', () => {
    const err = (() => {
      try {
        parseServiceAccountKey('{"type":"service_account","private_key":"secret-bits"}', 'ssh.a.iapKey')
      } catch (e) {
        return e as ConnectorError
      }
    })()
    expect(err?.code).toBe('invalid_config')
    expect(JSON.stringify(err?.details)).toContain('ssh.a.iapKey.client_email')
    expect(`${err?.message}${JSON.stringify(err?.details)}`).not.toContain('secret-bits')
  })
})

describe('serverIdentity', () => {
  it('uses the service account key GOOGLE_APPLICATION_CREDENTIALS names', async () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: file('sa.json', fake.keyJson) }
    const id = serverIdentity({ scope, env, tokenUrl: fake.tokenUrl })
    expect(await id.token(signal)).toMatch(/^sa-/)
    expect(await id.describe(signal)).toBe('tunnel@fake-project.iam.gserviceaccount.com')
  })

  it("uses an authorized_user file with Google's token endpoint, not the file's", async () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: file('user.json', fake.userJson) }
    const id = serverIdentity({ scope, env, tokenUrl: fake.tokenUrl })
    expect(await id.token(signal)).toMatch(/^user-/)
    expect(await id.describe(signal)).toContain('gcloud application-default')
    const wrong = { ...JSON.parse(fake.userJson), refresh_token: 'revoked' }
    const revoked = serverIdentity({
      scope,
      env: { GOOGLE_APPLICATION_CREDENTIALS: file('revoked.json', JSON.stringify(wrong)) },
      tokenUrl: fake.tokenUrl,
    })
    const err = await failure(revoked.token(signal))
    expect(err.code).toBe('connection')
    expect(err.message).toBe("Google refused the server's user credentials: Bad Request")
  })

  it("finds gcloud's application-default file under HOME", async () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true })
    writeFileSync(join(home, '.config', 'gcloud', 'application_default_credentials.json'), fake.userJson)
    const id = serverIdentity({ scope, env: { HOME: home }, tokenUrl: fake.tokenUrl })
    expect(await id.token(signal)).toMatch(/^user-/)
  })

  it('asks the metadata server otherwise, with its header and the scope', async () => {
    const id = serverIdentity({ scope, env: { GCE_METADATA_HOST: fake.metadataHost } })
    const token = await id.token(signal)
    expect(token).toMatch(/^md-/)
    expect(await id.token(signal)).toBe(token)
    expect(fake.metadataScopes.at(-1)).toBe(scope)
    expect(await id.describe(signal)).toBe('vm@fake-project.iam.gserviceaccount.com')
  })

  it('says there is no identity, and looks again on the next call', async () => {
    const env: Record<string, string | undefined> = { GCE_METADATA_HOST: `127.0.0.1:${await closedPort()}` }
    const id = serverIdentity({ scope, env, tokenUrl: fake.tokenUrl })
    const err = await failure(id.token(signal))
    expect(err.code).toBe('connection')
    expect(err.message).toContain('The server has no Google identity')
    env.GOOGLE_APPLICATION_CREDENTIALS = file('later.json', fake.keyJson)
    expect(await id.token(signal)).toMatch(/^sa-/)
  })

  it("refuses a file it can't read or doesn't know, without quoting it", async () => {
    const missing = serverIdentity({ scope, env: { GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'nope.json') } })
    expect((await failure(missing.token(signal))).message).toContain('ENOENT')
    const odd = serverIdentity({
      scope,
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: file('odd.json', '{"type":"external_account","secret":"x1y2"}'),
      },
    })
    const err = await failure(odd.token(signal))
    expect(err.code).toBe('invalid_config')
    expect(err.message).toContain("isn't a service account key or an authorized_user file")
    expect(err.message).not.toContain('x1y2')
  })
})
