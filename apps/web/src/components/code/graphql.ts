import { buildClientSchema, type GraphQLSchema, type IntrospectionQuery } from 'graphql'
import {
  CompletionItemKind,
  getAutocompleteSuggestions,
  getDiagnostics,
  getHoverInformation,
  Position,
} from 'graphql-language-service'
import { monaco } from './monaco'

// GraphQL in Monaco (M27): completions, hover and checks from a resource's schema (its introspection), per model. Built
// on graphql-language-service rather than monaco-graphql, which wants an older Monaco than ours.

const schemas = new Map<string, GraphQLSchema>()
const built = new WeakMap<IntrospectionQuery, GraphQLSchema | null>()

function schemaOf(introspection: IntrospectionQuery): GraphQLSchema | null {
  if (!built.has(introspection)) {
    try {
      built.set(introspection, buildClientSchema(introspection))
    } catch {
      built.set(introspection, null)
    }
  }
  return built.get(introspection) ?? null
}

const KINDS: Partial<Record<number, monaco.languages.CompletionItemKind>> = {
  [CompletionItemKind.Field]: monaco.languages.CompletionItemKind.Field,
  [CompletionItemKind.Function]: monaco.languages.CompletionItemKind.Function,
  [CompletionItemKind.Variable]: monaco.languages.CompletionItemKind.Variable,
  [CompletionItemKind.Class]: monaco.languages.CompletionItemKind.Class,
  [CompletionItemKind.Interface]: monaco.languages.CompletionItemKind.Interface,
  [CompletionItemKind.Enum]: monaco.languages.CompletionItemKind.Enum,
  [CompletionItemKind.EnumMember]: monaco.languages.CompletionItemKind.EnumMember,
  [CompletionItemKind.Keyword]: monaco.languages.CompletionItemKind.Keyword,
  [CompletionItemKind.Struct]: monaco.languages.CompletionItemKind.Struct,
}

let registered = false

function register(): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('graphql', {
    triggerCharacters: ['{', '(', ':', '$', '@', ' ', '\n'],
    provideCompletionItems(model, position) {
      const schema = schemas.get(model.uri.toString())
      if (!schema) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )
      const items = getAutocompleteSuggestions(
        schema,
        model.getValue(),
        new Position(position.lineNumber - 1, position.column - 1),
      )
      return {
        suggestions: items.map((item) => ({
          label: item.label,
          kind: KINDS[item.kind ?? -1] ?? monaco.languages.CompletionItemKind.Text,
          insertText: item.insertText ?? item.label,
          ...(item.insertTextFormat === 2 && {
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          }),
          ...(item.detail && { detail: item.detail }),
          ...(item.documentation && { documentation: String(item.documentation) }),
          range,
        })),
      }
    },
  })
  monaco.languages.registerHoverProvider('graphql', {
    provideHover(model, position) {
      const schema = schemas.get(model.uri.toString())
      if (!schema) return null
      const info = getHoverInformation(
        schema,
        model.getValue(),
        new Position(position.lineNumber - 1, position.column - 1),
      )
      const text = markupText(info)
      return text ? { contents: [{ value: text }] } : null
    },
  })
}

/** LSP text in any of its shapes (a string, markup, marked strings) as plain markdown. */
function markupText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(markupText).join('\n\n')
  if (value && typeof value === 'object' && 'value' in value)
    return String((value as { value: unknown }).value)
  return ''
}

/** Marks what the schema rejects (unknown fields, wrong arguments) and syntax errors in the model. */
function check(model: monaco.editor.ITextModel, schema: GraphQLSchema): void {
  const text = model.getValue()
  monaco.editor.setModelMarkers(
    model,
    'graphql',
    // `{{ }}` isn't GraphQL: the connector refuses it with its own message, so the schema check stays quiet then.
    text.includes('{{')
      ? []
      : getDiagnostics(text, schema).map((d) => ({
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: Math.max(d.range.end.character + 1, d.range.start.character + 2),
          message: markupText(d.message),
          severity: d.severity === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })),
  )
}

/** Gives a model its schema: completions and hover from it, and checks as it changes. Returns the undo. */
export function attachGraphqlSchema(
  model: monaco.editor.ITextModel,
  introspection: IntrospectionQuery,
): () => void {
  const schema = schemaOf(introspection)
  if (!schema) return () => {}
  register()
  const key = model.uri.toString()
  schemas.set(key, schema)
  check(model, schema)
  let timer: ReturnType<typeof setTimeout> | undefined
  const listener = model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(() => !model.isDisposed() && check(model, schema), 250)
  })
  return () => {
    clearTimeout(timer)
    listener.dispose()
    if (schemas.get(key) === schema) schemas.delete(key)
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'graphql', [])
  }
}
