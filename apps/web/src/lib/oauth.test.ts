import { describe, expect, it } from 'vitest'
import { authRequired } from './oauth'

describe('authRequired', () => {
  const details = { reason: 'not_connected', account: 'user', resourceId: 'r', environmentId: 'e' }

  it('reads what a query needs', () => {
    expect(authRequired({ code: 'auth_required', details })).toEqual({
      reason: 'not_connected',
      account: 'user',
      resourceId: 'r',
      environmentId: 'e',
    })
    expect(authRequired({ code: 'http', details })).toBeNull()
  })

  it('keeps the publisher whose account a live run needs (only they can connect it)', () => {
    expect(
      authRequired({ code: 'auth_required', details: { ...details, publisher: true, publisherId: 'u1' } }),
    ).toMatchObject({ publisherId: 'u1' })
  })
})
