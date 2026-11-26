import { describe, expect, it } from 'vitest'
import { type EditorSqlSchema, referencedTables, tablesInSchema } from './sql-references'

const table = (schema: string, name: string, insert?: string): EditorSqlSchema['tables'][number] => ({
  schema,
  name,
  columns: [{ name: 'id', type: 'INT64', nullable: false }],
  ...(insert && { insert }),
})

describe('the tables a query names', () => {
  const orders = table('public', 'orders')
  const product = table(
    'optiply-data-platform.agent_api',
    'webshop_product',
    "`optiply-data-platform.agent_api.webshop_product`('<shop>')",
  )
  const schema: EditorSqlSchema = { tables: [orders, product] }

  it('finds tables and their aliases, as before', () => {
    const { aliases, referenced } = referencedTables(
      'select * from orders o join public.orders AS p on true',
      schema,
    )
    expect([...referenced]).toEqual([orders])
    expect(aliases.get('o')).toBe(orders)
    expect(aliases.get('p')).toBe(orders)
    expect(referencedTables('select * from orders where id = 1', schema).aliases.size).toBe(0)
  })

  it('finds a table function’s call and the alias after its arguments', () => {
    for (const sql of [
      "SELECT p.id FROM `optiply-data-platform.agent_api.webshop_product`('123') p",
      "SELECT p.id FROM `optiply-data-platform.agent_api.webshop_product` ('123') AS p",
      'SELECT p.id FROM `optiply-data-platform.agent_api.webshop_product`({{ shop }}) p',
      "SELECT p.id FROM `optiply-data-platform.agent_api.webshop_product`(CAST('1' AS STRING)) p",
    ]) {
      const { aliases, referenced } = referencedTables(sql, schema)
      expect([...referenced], sql).toEqual([product])
      expect(aliases.get('p'), sql).toBe(product)
    }
    const bare = referencedTables(
      "SELECT * FROM `optiply-data-platform.agent_api.webshop_product`('1') WHERE x",
      schema,
    )
    expect([...bare.referenced]).toEqual([product])
    expect(bare.aliases.size).toBe(0)
  })
})

describe('the tables after a qualifier', () => {
  const product = table('optiply-data-platform.agent_api', 'webshop_product', '`…`(…)')
  const orders = table('shop', 'orders')
  const schema: EditorSqlSchema = { tables: [product, orders] }

  it('matches a schema whole or by its last part, never a part in the middle', () => {
    expect(tablesInSchema(schema, 'shop')).toEqual([orders])
    expect(tablesInSchema(schema, 'agent_api')).toEqual([product])
    expect(tablesInSchema(schema, 'Agent_API')).toEqual([product])
    expect(tablesInSchema(schema, 'optiply-data-platform.agent_api')).toEqual([product])
    expect(tablesInSchema(schema, 'optiply-data-platform')).toEqual([])
    expect(tablesInSchema(schema, 'api')).toEqual([])
  })
})
