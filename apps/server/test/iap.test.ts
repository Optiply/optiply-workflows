import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeGoogle } from '../../../packages/connectors/test/google-fake'
import { loadConfig } from '../src/config'
import { configureGoogle } from '../src/services/google'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
  ENCRYPTION_KEYS: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
}

describe('GOOGLE_SERVER_IDENTITY (M18)', () => {
  it('is off unless set to allow', () => {
    expect(loadConfig(base).GOOGLE_SERVER_IDENTITY).toBe('deny')
    expect(loadConfig({ ...base, GOOGLE_SERVER_IDENTITY: 'allow' }).GOOGLE_SERVER_IDENTITY).toBe('allow')
    expect(() => loadConfig({ ...base, GOOGLE_SERVER_IDENTITY: 'yes' })).toThrow(/GOOGLE_SERVER_IDENTITY/)
  })
})

describe('resources.serverIdentity (M18)', () => {
  let env: TestEnv
  let admin: ReturnType<typeof trpc>
  let editor: ReturnType<typeof trpc>
  const google = new FakeGoogle()
  const dir = mkdtempSync(join(tmpdir(), 'ow-iap-'))
  const keyFile = join(dir, 'key.json')
  const allow = { GOOGLE_SERVER_IDENTITY: 'allow' as const }
  // biome-ignore lint/suspicious/noExplicitAny: the view's fields, as the browser gets them
  const view = async (as: ReturnType<typeof trpc>): Promise<any> =>
    (await as.query('resources.serverIdentity')).body.result?.data

  beforeAll(async () => {
    await google.start()
    writeFileSync(keyFile, google.keyJson)
    env = await startTestApp()
    await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
    await createLocalUser(env.db, 'editor@optiply.nl')
    admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
    editor = trpc(env.app, await login(env.app, 'editor@optiply.nl'))
  })

  afterAll(async () => {
    configureGoogle({ GOOGLE_SERVER_IDENTITY: 'deny' })
    await env?.stop()
    await google.stop()
  })

  it("isn't offered by default", async () => {
    expect(await view(admin)).toEqual({ allowed: false })
  })

  it("names the server's service account, and lets only admins choose it", async () => {
    configureGoogle(allow, { GOOGLE_APPLICATION_CREDENTIALS: keyFile })
    const shown = { allowed: true, identity: 'tunnel@fake-project.iam.gserviceaccount.com', error: null }
    expect(await view(admin)).toEqual({ ...shown, canChoose: true })
    expect(await view(editor)).toEqual({ ...shown, canChoose: false })
  })

  it("names the VM's service account on Google Cloud", async () => {
    configureGoogle(allow, { HOME: dir, GCE_METADATA_HOST: google.metadataHost })
    const body = await view(admin)
    expect(body).toMatchObject({ allowed: true, error: null })
    expect(body.identity).toMatch(/@/)
  })

  it('says why when the server has no Google credentials', async () => {
    configureGoogle(allow, { HOME: dir, GCE_METADATA_HOST: '127.0.0.1:1' })
    const body = await view(admin)
    expect(body).toMatchObject({ allowed: true, canChoose: true, identity: null })
    expect(body.error).toMatch(/no Google identity/)
  })
})
