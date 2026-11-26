import { describe, expect, it } from 'vitest'
import { sqlTableLabel, sqlTableName } from './sql-schema'

describe('how a table is written and labelled', () => {
  it('writes a table with its schema only when there are several and it isn’t the usual one', () => {
    expect(sqlTableName({ schema: 'public', name: 'orders' }, true)).toBe('orders')
    expect(sqlTableName({ schema: 'shop', name: 'orders' }, true)).toBe('shop.orders')
    expect(sqlTableName({ schema: 'shop', name: 'orders' }, false)).toBe('orders')
    expect(sqlTableLabel({ schema: 'shop', name: 'orders' }, true)).toBe('shop.orders')
  })

  it('inserts a table function’s call, labelled by its name', () => {
    const fn = {
      schema: 'optiply-data-platform.agent_api',
      name: 'webshop_product',
      insert: "`optiply-data-platform.agent_api.webshop_product`('<shop>')",
    }
    expect(sqlTableName(fn, false)).toBe(fn.insert)
    expect(sqlTableName(fn, true)).toBe(fn.insert)
    expect(sqlTableLabel(fn, true)).toBe('webshop_product')
  })
})
