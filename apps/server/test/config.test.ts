import { generateKey } from '@ow/crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { configurePython, pythonConfigWarning } from '../src/services/python'

const base = {
  DATABASE_URL: 'postgres://ow:ow@127.0.0.1:5432/ow',
  SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
  ENCRYPTION_KEYS: `v1:${generateKey()},v2:${generateKey()}`,
}

describe('loadConfig', () => {
  it('treats empty variables as unset, since docker-compose passes unset ones as empty strings', () => {
    const config = loadConfig({
      ...base,
      ENCRYPTION_KEY_CURRENT: '',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
      LOG_LEVEL: '',
      LOCAL_LOGIN_ENABLED: '',
      GIT_ALLOW_INSECURE_URLS: '',
      GITHUB_API_URL: '',
      GIT_POLL_SECONDS: '',
    })
    expect(config.keyring.current).toBe('v2')
    expect(config.oidcEnabled).toBe(false)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.LOCAL_LOGIN_ENABLED).toBe(false)
    expect(config.GIT_ALLOW_INSECURE_URLS).toBe(false)
    expect(config.GITHUB_API_URL).toBeUndefined()
    expect(config.GIT_POLL_SECONDS).toBe(60)
  })

  it('signs in with Google only with its secret, and with Auth0 as a public client (session 58)', () => {
    expect(loadConfig({ ...base, OIDC_CLIENT_ID: 'g' }).oidcEnabled).toBe(false)
    expect(loadConfig({ ...base, OIDC_CLIENT_ID: 'g', OIDC_CLIENT_SECRET: 's' }).oidcEnabled).toBe(true)
    const auth0 = loadConfig({
      ...base,
      OIDC_ISSUER: 'https://optiply.eu.auth0.com/',
      OIDC_CLIENT_ID: 'AGivjzIbhX2X7XDJWyxxPUZ4eDNbhAQT',
      OIDC_PROVIDER_NAME: 'Optiply',
    })
    expect(auth0).toMatchObject({ oidcEnabled: true, OIDC_PROVIDER_NAME: 'Optiply', OIDC_ALLOW_HTTP: false })
  })

  it('turns Python off, with a warning, when the URL comes without its token', () => {
    const config = loadConfig({ ...base, PYTHON_EXECUTOR_URL: 'http://code-executor:8080' })
    expect(configurePython(config)).toBeNull()
    expect(pythonConfigWarning(config)).toBe(
      'PYTHON_EXECUTOR_URL is set without PYTHON_EXECUTOR_TOKEN: Python code blocks are off',
    )
    expect(() =>
      loadConfig({
        ...base,
        PYTHON_EXECUTOR_URL: 'http://code-executor:8080',
        PYTHON_EXECUTOR_TOKEN: 'short',
      }),
    ).toThrow(/PYTHON_EXECUTOR_TOKEN/)
    const both = loadConfig({
      ...base,
      PYTHON_EXECUTOR_URL: 'http://code-executor:8080',
      PYTHON_EXECUTOR_TOKEN: 'a-token-of-16-chars',
    })
    expect(configurePython(both)).not.toBeNull()
    expect(pythonConfigWarning(both)).toBeNull()
    configurePython({})
  })

  it('still reports an unknown current key version', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY_CURRENT: 'v9' })).toThrow(/ENCRYPTION_KEY_CURRENT/)
  })
})
