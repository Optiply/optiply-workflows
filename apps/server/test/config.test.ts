import { generateKey } from '@ow/crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

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

  it('needs the Python executor token with its URL', () => {
    expect(() => loadConfig({ ...base, PYTHON_EXECUTOR_URL: 'http://code-executor:8080' })).toThrow(
      /PYTHON_EXECUTOR_TOKEN: Required with PYTHON_EXECUTOR_URL/,
    )
    expect(() =>
      loadConfig({
        ...base,
        PYTHON_EXECUTOR_URL: 'http://code-executor:8080',
        PYTHON_EXECUTOR_TOKEN: 'short',
      }),
    ).toThrow(/PYTHON_EXECUTOR_TOKEN/)
    const config = loadConfig({
      ...base,
      PYTHON_EXECUTOR_URL: 'http://code-executor:8080',
      PYTHON_EXECUTOR_TOKEN: 'a-token-of-16-chars',
    })
    expect(config.PYTHON_EXECUTOR_URL).toBe('http://code-executor:8080')
    expect(
      loadConfig({ ...base, PYTHON_EXECUTOR_URL: '', PYTHON_EXECUTOR_TOKEN: '' }).PYTHON_EXECUTOR_URL,
    ).toBeUndefined()
  })

  it('still reports an unknown current key version', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY_CURRENT: 'v9' })).toThrow(/ENCRYPTION_KEY_CURRENT/)
  })
})
