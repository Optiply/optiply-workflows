import { monaco } from './monaco'

// SQL completions from a database resource's tables and columns (session 57), per model: table names (with their
// schema where it isn't the usual one), a table's or alias's columns after `name.`, a schema's tables after
// `schema.`, and the columns of the tables the query already names. Inside `{{ }}` the template completions answer.

export interface EditorSqlSchema {
  tables: { schema: string; name: string; columns: { name: string; type: string; nullable: boolean }[] }[]
}

const schemas = new Map<string, EditorSqlSchema>()
/** Schemas tables are usually in, written without it. */
const USUAL = new Set(['public', 'dbo', 'main'])

let registered = false

const lower = (s: string) => s.toLowerCase()

/** The query's `from` / `join` tables, by name and by alias: `orders o`, `public.orders AS o`. */
function referencedTables(text: string, schema: EditorSqlSchema) {
  const byName = new Map<string, EditorSqlSchema['tables'][number]>()
  for (const t of schema.tables) {
    byName.set(lower(t.name), t)
    byName.set(lower(`${t.schema}.${t.name}`), t)
  }
  const aliases = new Map<string, EditorSqlSchema['tables'][number]>()
  const referenced = new Set<EditorSqlSchema['tables'][number]>()
  const re = /\b(?:from|join|update|into)\s+([`"[\]\w.-]+)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi
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

function register(): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const schema = schemas.get(model.uri.toString())
      if (!schema) return { suggestions: [] }
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      // Inside a `{{ }}`: the template's completions.
      if (before.lastIndexOf('{{') > before.lastIndexOf('}}')) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )
      const { byName, aliases, referenced } = referencedTables(model.getValue(), schema)
      const column = (c: EditorSqlSchema['tables'][number]['columns'][number], table: string) => ({
        label: c.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: c.name,
        detail: `${c.type}${c.nullable ? '' : ' not null'} · ${table}`,
        range,
      })
      const qualifier = /([`"\w-]+)\.\w*$/.exec(before.slice(0, before.length))?.[1]?.replace(/[`"]/g, '')
      if (qualifier) {
        const q = lower(qualifier)
        const table = aliases.get(q) ?? byName.get(q)
        if (table) return { suggestions: table.columns.map((c) => column(c, table.name)) }
        const inSchema = schema.tables.filter((t) => lower(t.schema) === q)
        return {
          suggestions: inSchema.map((t) => ({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: t.name,
            detail: `${t.columns.length} columns`,
            range,
          })),
        }
      }
      const schemasUsed = new Set(schema.tables.map((t) => t.schema))
      const tables = schema.tables.map((t) => {
        const qualified =
          schemasUsed.size > 1 && !USUAL.has(lower(t.schema)) ? `${t.schema}.${t.name}` : t.name
        return {
          label: qualified,
          kind: monaco.languages.CompletionItemKind.Struct,
          insertText: qualified,
          detail: `table · ${t.columns.length} columns`,
          sortText: `1${qualified}`,
          range,
        }
      })
      const columns = [...referenced].flatMap((t) =>
        t.columns.map((c) => ({ ...column(c, t.name), sortText: `0${c.name}` })),
      )
      return { suggestions: [...columns, ...tables] }
    },
  })
}

/** Gives the model's SQL completions this schema until the returned function is called. */
export function attachSqlSchema(model: monaco.editor.ITextModel, schema: EditorSqlSchema): () => void {
  register()
  const key = model.uri.toString()
  schemas.set(key, schema)
  return () => {
    if (schemas.get(key) === schema) schemas.delete(key)
  }
}

/** Types `text` at the cursor of the editor showing `path`'s model (a name clicked in the tables panel). */
export function insertIntoEditor(path: string, text: string): boolean {
  const uri = monaco.Uri.parse(path).toString()
  const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri)
  if (!editor) return false
  const selection = editor.getSelection()
  if (!selection) return false
  editor.executeEdits('sql-schema', [{ range: selection, text, forceMoveMarkers: true }])
  editor.focus()
  return true
}
