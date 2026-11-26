import { sqlTableLabel, sqlTableName } from '@/lib/sql-schema'
import { monaco } from './monaco'
import { type EditorSqlSchema, lower, referencedTables, tablesInSchema } from './sql-references'

// SQL completions from a database resource's tables and columns (session 57), per model: table names (with their
// schema where it isn't the usual one), a table's or alias's columns after `name.`, a schema's tables after
// `schema.`, and the columns of the tables the query already names. Inside `{{ }}` the template completions answer.

export type { EditorSqlSchema } from './sql-references'

const schemas = new Map<string, EditorSqlSchema>()

let registered = false

function register(): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const schema = schemas.get(model.uri.toString())
      if (!schema) return { suggestions: [] }
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      // Inside a `{{ }}`: the template's completions. Inside a string or a comment: none.
      if (before.lastIndexOf('{{') > before.lastIndexOf('}}')) return { suggestions: [] }
      const line = before.slice(before.lastIndexOf('\n') + 1)
      if ((line.split("'").length - 1) % 2 === 1 || line.replace(/'[^']*'/g, '').includes('--')) {
        return { suggestions: [] }
      }
      if (before.lastIndexOf('/*') > before.lastIndexOf('*/')) return { suggestions: [] }
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
        // A table function's call replaces the whole qualified name typed so far (`agent_api.` alone would name
        // the billing project's dataset): filtered by what was typed, inserted as the full call.
        const typed = /[`"\w.-]+$/.exec(line)?.[0] ?? ''
        const whole = new monaco.Range(
          position.lineNumber,
          position.column - typed.length,
          position.lineNumber,
          position.column,
        )
        const prefix = typed.slice(0, typed.length - word.word.length)
        return {
          suggestions: tablesInSchema(schema, qualifier).map((t) =>
            t.insert
              ? {
                  label: t.name,
                  kind: monaco.languages.CompletionItemKind.Function,
                  insertText: t.insert,
                  filterText: `${prefix}${t.name}`,
                  detail: `function · ${t.columns.length} columns`,
                  range: whole,
                }
              : {
                  label: t.name,
                  kind: monaco.languages.CompletionItemKind.Struct,
                  insertText: t.name,
                  detail: `${t.columns.length} columns`,
                  range,
                },
          ),
        }
      }
      const several = new Set(schema.tables.map((t) => t.schema)).size > 1
      const tables = schema.tables.map((t) => {
        const qualified = sqlTableName(t, several)
        const label = sqlTableLabel(t, several)
        return {
          label,
          kind: monaco.languages.CompletionItemKind.Struct,
          insertText: qualified,
          detail: t.insert ? `function · ${t.columns.length} columns` : `table · ${t.columns.length} columns`,
          sortText: `1${label}`,
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
