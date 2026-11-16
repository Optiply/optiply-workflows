import { describe, expect, it } from 'vitest'
import { appsOnlyMayOpen } from './apps-only'

describe('appsOnlyMayOpen', () => {
  it('their apps page and an app in use, on any of its pages', () => {
    for (const path of [
      '/my-apps',
      '/my-apps/',
      '/apps/stock-report',
      '/apps/stock-report/',
      '/apps/crm/orders',
    ])
      expect(appsOnlyMayOpen(path), path).toBe(true)
  })

  it('never the platform, nor an app’s editor or the apps list', () => {
    for (const path of [
      '/',
      '/apps',
      '/apps/',
      '/apps/crm/edit',
      '/apps/crm/orders/more',
      '/workflows',
      '/settings/users',
      '/start',
      '/my-apps/else',
      '/runs',
    ])
      expect(appsOnlyMayOpen(path), path).toBe(false)
  })
})
