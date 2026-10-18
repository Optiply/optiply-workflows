import Editor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useMemo, useRef } from 'react'
import { useTheme } from '@/lib/theme'
import { monaco, optiplyTheme, setScope } from './monaco'

export interface FieldProblem {
  start?: number
  end?: number
  message: string
  severity: 'error' | 'warning'
}

export interface CodeFieldProps {
  /** Unique per block and field, so each keeps its own model and undo history. */
  path: string
  language: 'javascript' | 'python' | 'sql' | 'json' | 'plaintext'
  value: string
  onChange: (value: string) => void
  /** Pixel height; one-line fields use about 34. */
  height: number
  singleLine?: boolean
  problems?: FieldProblem[]
  readOnly?: boolean
}

/** What completions know: declarations for the JavaScript service, sample values for `{{ }}` in SQL and text. */
export interface CodeScope {
  dts: string
  sample: Record<string, unknown>
}

/**
 * A Monaco editor for one field. Problems from the validator show as squiggles at their offsets; `scope` drives
 * completions (one scope is installed at a time: the open editor's, or the one the page installs).
 */
export default function CodeField({
  path,
  language,
  value,
  onChange,
  height,
  singleLine,
  problems = [],
  readOnly,
  scope,
}: CodeFieldProps & { scope?: CodeScope }) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { theme } = useTheme()
  const themeName = useMemo(() => optiplyTheme(theme), [theme])
  // Without a scope, the page installs one itself (the app editor keeps a single scope for all its fields).
  useEffect(() => {
    if (scope) setScope(scope.dts, scope.sample)
  }, [scope])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    if (singleLine) {
      // Enter would add a second line to a one-line expression. With the suggestion list open, Enter still accepts
      // the suggestion (this command only applies while it's closed).
      editor.addCommand(monaco.KeyCode.Enter, () => {}, '!suggestWidgetVisible')
    }
  }

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    monaco.editor.setModelMarkers(
      model,
      'ow',
      problems.map((p) => {
        const from = model.getPositionAt(p.start ?? 0)
        const to = model.getPositionAt(p.end ?? model.getValueLength())
        return {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: Math.max(to.column, from.column + 1),
          message: p.message,
          severity: p.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        }
      }),
    )
  })

  return (
    <div
      className="overflow-hidden rounded-md border border-border bg-field transition-shadow focus-within:border-transparent focus-within:shadow-focus"
      data-testid={`code-${path}`}
    >
      <Editor
        theme={themeName}
        path={path}
        language={language}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        onMount={onMount}
        height={height}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 12.5,
          fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace',
          lineNumbers: singleLine ? 'off' : 'on',
          glyphMargin: false,
          folding: !singleLine,
          lineDecorationsWidth: singleLine ? 6 : 8,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          wordWrap: singleLine ? 'off' : 'on',
          renderLineHighlight: singleLine ? 'none' : 'line',
          overviewRulerLanes: 0,
          scrollbar: singleLine ? { vertical: 'hidden', horizontal: 'hidden' } : { verticalScrollbarSize: 8 },
          tabSize: 2,
          automaticLayout: true,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  )
}
