import Editor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '@/lib/theme'
import { monaco, optiplyTheme, setScope } from './monaco'
import { showCursors } from './remote-cursors'
import { bindText, type TextBinding } from './text-binding'

export interface FieldProblem {
  start?: number
  end?: number
  message: string
  severity: 'error' | 'warning'
}

export interface CodeFieldProps {
  /** Unique per block and field, so each keeps its own model and undo history. */
  path: string
  language: 'javascript' | 'typescript' | 'css' | 'python' | 'sql' | 'json' | 'plaintext'
  value: string
  onChange: (value: string) => void
  /** Pixel height; one-line fields use about 34. */
  height: number
  singleLine?: boolean
  problems?: FieldProblem[]
  readOnly?: boolean
  /**
   * The field's text in the shared document (M16): typing goes into it and others' typing comes out of it, and ⌘Z
   * undoes through the editor's shared undo. `onChange` isn't called while it's bound.
   */
  binding?: TextBinding | null
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
  binding,
  scope,
}: CodeFieldProps & { scope?: CodeScope }) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [mounted, setMounted] = useState(false)
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  const { theme } = useTheme()
  const themeName = useMemo(() => optiplyTheme(theme), [theme])
  // Without a scope, the page installs one itself (the app editor keeps a single scope for all its fields).
  useEffect(() => {
    if (scope) setScope(scope.dts, scope.sample)
  }, [scope])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    setMounted(true)
    // Bound to the shared document, undo is the editor's (one's own edits, everywhere); otherwise Monaco's own.
    const undoRedo = (redo: boolean) => () => {
      const bound = bindingRef.current
      if (bound) redo ? bound.redo() : bound.undo()
      else editor.trigger('keyboard', redo ? 'redo' : 'undo', null)
    }
    editor.addAction({
      id: 'ow.undo',
      label: 'Undo',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ],
      run: undoRedo(false),
    })
    editor.addAction({
      id: 'ow.redo',
      label: 'Redo',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY,
      ],
      run: undoRedo(true),
    })
    if (singleLine) {
      // Enter would add a second line to a one-line expression. With the suggestion list open, Enter still accepts
      // the suggestion (this command only applies while it's closed).
      editor.addCommand(monaco.KeyCode.Enter, () => {}, '!suggestWidgetVisible')
    }
  }

  // The model (one per path) follows the bound text while both last.
  const text = binding?.text
  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` switches the editor's model
  useEffect(() => {
    const model = editorRef.current?.getModel()
    const bound = bindingRef.current
    if (!mounted || !model || !text || !bound) return
    const disposable = bindText(model, {
      text,
      write: (change) => bindingRef.current?.write(change),
      undo: () => bindingRef.current?.undo(),
      redo: () => bindingRef.current?.redo(),
    })
    return () => disposable.dispose()
  }, [mounted, text, path])

  // Others' cursors in this text, and ours shared (after the binding: their positions read the model it keeps).
  const awareness = binding?.awareness
  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` switches the editor's model
  useEffect(() => {
    const editor = editorRef.current
    if (!mounted || !editor || !text || !awareness) return
    const disposable = showCursors(editor, text, awareness)
    return () => disposable.dispose()
  }, [mounted, text, awareness, path])

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
        onChange={(next) => {
          if (!bindingRef.current?.text) onChange(next ?? '')
        }}
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
