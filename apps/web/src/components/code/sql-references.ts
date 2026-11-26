import { isUsualSchema } from '@/lib/sql-schema'

// Which of a resource's tables a SQL query names, and by which aliases: the editor's completions use it to offer a
// table's (or alias's) columns. Pure, so it's tested without Monaco.

export interface EditorSqlSchema {
  tables: {
    schema: string
    name: string
    columns: { name: string; type: string; nullable: boolean }[]
    /** A table function's call, inserted instead of its name. */
    insert?: string
  }[]
}

export const lower = (s: string) => s.toLowerCase()

/**
 * The query's `from` / `join` tables, by name and by alias: `orders o`, `public.orders AS o`, and a table function's
 * call `` `project.dataset.fn`('…') p ``.
 */
/**
 * The tables after `qualifier.`: a schema's, matched whole or by its last part (`agent_api.` for the data platform's
 * `optiply-data-platform.agent_api`).
 */
export function tablesInSchema(schema: EditorSqlSchema, qualifier: string): EditorSqlSchema['tables'] {
  const q = lower(qualifier)
  return schema.tables.filter((t) => {
    const s = lower(t.schema)
    return s === q || s.endsWith(`.${q}`)
  })
}

export function referencedTables(text: string, schema: EditorSqlSchema) {
  const byName = new Map<string, EditorSqlSchema['tables'][number]>()
  for (const t of schema.tables) {
    byName.set(lower(`${t.schema}.${t.name}`), t)
    // An unqualified name means the usual schema's table (search_path, dbo) when two schemas have one.
    const bare = byName.get(lower(t.name))
    if (!bare || (!isUsualSchema(bare.schema) && isUsualSchema(t.schema))) byName.set(lower(t.name), t)
  }
  const aliases = new Map<string, EditorSqlSchema['tables'][number]>()
  const referenced = new Set<EditorSqlSchema['tables'][number]>()
  // A table function's call (`fn`('…')), its arguments up to one level of nested parentheses, may sit between the
  // name and the alias.
  const re =
    /\b(?:from|join|update|into)\s+([`"[\]\w.-]+)(?:\s*\((?:[^()]|\([^()]*\))*\))?(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi
  for (const m of text.matchAll(re)) {
    const name = lower(m[1]!.replace(/[`"[\]]/g, ''))
    const table = byName.get(name)
    if (!table) continue
    referenced.add(table)
    const alias =
      m[2] && !/^(where|join|on|left|right|inner|outer|full|cross|group|order|limit|set|values)$/i.test(m[2])
        ? m[2]
        : null
    if (alias) aliases.set(lower(alias), table)
  }
  return { byName, aliases, referenced }
}
