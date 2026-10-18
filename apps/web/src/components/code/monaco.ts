/**
 * Monaco, bundled locally (no CDN). This module is only imported by the lazily loaded code fields, so Monaco never
 * weighs on the rest of the app.
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { token } from '@/lib/tokens'

// Monaco asks for its workers through MonacoEnvironment; Vite bundles each `?worker` import as its own file.
self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    if (label === 'json') return new JsonWorker()
    return new EditorWorker()
  },
}

loader.config({ monaco })

/**
 * Defines `optiply-<theme>`, Optiply's colours for code, from the tokens of the theme in effect (styles.css): the
 * input fill, ink, a blue selection, syntax from Optiply's scales. Returns the theme's name.
 */
export function optiplyTheme(theme: 'light' | 'dark'): string {
  const hex = (name: string) => token(name).slice(1)
  monaco.editor.defineTheme(`optiply-${theme}`, {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: hex('--ink-3'), fontStyle: 'italic' },
      { token: 'keyword', foreground: hex('--purple-3') },
      { token: 'string', foreground: hex('--green-3') },
      { token: 'number', foreground: hex('--orange-4') },
      { token: 'regexp', foreground: hex('--red-3') },
      { token: 'type', foreground: hex('--blue-3') },
      { token: 'delimiter', foreground: hex('--ink-2') },
    ],
    colors: {
      'editor.background': token('--shade-2'),
      'editor.foreground': token('--ink-1'),
      'editorLineNumber.foreground': token('--ink-3'),
      'editorLineNumber.activeForeground': token('--ink-2'),
      // A line lighter than the field in dark mode, darker in light mode.
      'editor.lineHighlightBackground': token(theme === 'dark' ? '--shade-1' : '--shade-4'),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': token('--blue-1h'),
      'editor.inactiveSelectionBackground': token('--shade-6'),
      'editorCursor.foreground': token('--blue-3'),
      'editorIndentGuide.background1': token('--shade-6'),
      'editorWidget.background': token('--shade-1'),
      'editorWidget.border': token('--shade-7'),
      'editorSuggestWidget.background': token('--shade-1'),
      'editorSuggestWidget.border': token('--shade-7'),
      'editorSuggestWidget.selectedBackground': token('--blue-1'),
      'editorHoverWidget.background': token('--shade-1'),
      'editorHoverWidget.border': token('--shade-7'),
      'scrollbarSlider.background': `${token('--shade-8')}99`,
      'scrollbarSlider.hoverBackground': `${token('--ink-3')}99`,
    },
  })
  return `optiply-${theme}`
}

// Monaco measures its font when an editor is created; if JetBrains Mono (a web font) arrives later, measure again.
document.fonts?.addEventListener('loadingdone', () => monaco.editor.remeasureFonts())

const js = monaco.typescript.javascriptDefaults
js.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
  allowJs: true,
  checkJs: false,
  noLib: false,
  lib: ['es2023'],
})
js.setDiagnosticsOptions({
  // Our own validator reports problems (as markers); the type checker would only add noise.
  noSemanticValidation: true,
  noSyntaxValidation: false,
  // Code blocks are function bodies: top-level `return` and `await` are fine.
  diagnosticCodesToIgnore: [1108, 1375, 1378],
})
js.setEagerModelSync(true)

/** Sample values per name, for `{{ }}` completions in SQL and text fields (the JS service uses the `.d.ts`). */
let sampleScope: Record<string, unknown> = {}

let installed = ''

/** Installs the generated declarations of the blocks' results and globals (no-op when unchanged). */
export function setScope(dts: string, sample: Record<string, unknown>) {
  sampleScope = sample
  if (dts === installed) return
  installed = dts
  js.setExtraLibs([{ content: dts, filePath: 'file:///ow-scope.d.ts' }])
}

const IDENT = /[A-Za-z_$][\w$]*/

/** Completes `{{ query1.data[0].| }}` from sample values, in languages without a JS service. */
function templateCompletions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
  const before = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  })
  const open = before.lastIndexOf('{{')
  if (open === -1 || before.lastIndexOf('}}') > open) return { suggestions: [] }
  return sampleCompletions(before.slice(open + 2), model, position)
}

/** Names the JavaScript sandbox has and Python code doesn't. */
const JS_ONLY = new Set(['_', 'dayjs', 'sql'])

/** Completes `query1.data[0].|` in Python code from sample values (the line before the cursor). */
function pythonCompletions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
  const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
  if (line.trimStart().startsWith('#')) return { suggestions: [] }
  return sampleCompletions(line, model, position, JS_ONLY)
}

/** Completions for the name path ending `expression`: blocks and globals, or a sample value's keys. */
function sampleCompletions(
  expression: string,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  exclude: ReadonlySet<string> = new Set(),
): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
  const match = /([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)(\.?)([\w$]*)$/.exec(expression)
  const word = model.getWordUntilPosition(position)
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  }
  const items = (keys: string[], kind: monaco.languages.CompletionItemKind) => ({
    suggestions: keys.map((label) => ({ label, kind, insertText: label, range })),
  })

  if (!match || (!match[3] && !match[2])) {
    // A bare (partial) name: blocks and globals.
    return items(
      Object.keys(sampleScope).filter((k) => !exclude.has(k)),
      monaco.languages.CompletionItemKind.Variable,
    )
  }
  if (!match[3]) return { suggestions: [] }
  let value: unknown = sampleScope[match[1]!]
  for (const step of match[2]!.match(/\.[\w$]+|\[\d+\]/g) ?? []) {
    if (value === null || typeof value !== 'object') return { suggestions: [] }
    value = step.startsWith('[')
      ? (value as unknown[])[Number(step.slice(1, -1))]
      : (value as Record<string, unknown>)[step.slice(1)]
  }
  if (Array.isArray(value))
    value = value[0] !== undefined ? { length: 0, ...(value[0] as object) } : { length: 0 }
  if (value === null || typeof value !== 'object') return { suggestions: [] }
  return items(
    Object.keys(value).filter((k) => IDENT.test(k)),
    monaco.languages.CompletionItemKind.Field,
  )
}

for (const language of ['sql', 'plaintext']) {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['.', '{'],
    provideCompletionItems: templateCompletions,
  })
}
monaco.languages.registerCompletionItemProvider('python', {
  triggerCharacters: ['.'],
  provideCompletionItems: pythonCompletions,
})

export { monaco }
