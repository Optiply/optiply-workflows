import { type AppTheme, setCustomCss, setTheme } from '@ow/app-definition'
import { RotateCcw } from 'lucide-react'
import { JsPackagesField } from '@/components/js-packages'
import { Button, Input, Select, sectionLabelClass } from '@/components/ui'
import { AppCodeField, EditorField, problemsAt } from './fields'
import { useAppEditor } from './store'

/*
 * The Settings panel (session 41, after Retool's App settings): the app's theme, its custom CSS and its JavaScript
 * packages (which its JS queries, transformers and scripts import). Both apply inside
 * the app only (see `ThemedApp`), in the editor and where the app is used.
 */

const COLORS: { key: keyof AppTheme; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Buttons, links, selection' },
  { key: 'background', label: 'Background', hint: 'Behind the components' },
  { key: 'text', label: 'Text', hint: 'The main text' },
  { key: 'danger', label: 'Danger', hint: 'Errors, destructive buttons' },
  { key: 'success', label: 'Success', hint: 'Positive states' },
  { key: 'warning', label: 'Warning', hint: 'Cautions' },
]

const HEX = /^#[0-9a-fA-F]{6}$/

export function AppSettingsPanel() {
  const theme = useAppEditor((s) => s.definition.theme) ?? {}
  const css = useAppEditor((s) => s.definition.css) ?? ''
  const readOnly = useAppEditor((s) => s.readOnly)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const update = useAppEditor((s) => s.update)
  const kind = useAppEditor((s) => s.kind)
  const appId = useAppEditor((s) => s.appId)
  const packages = useAppEditor((s) => s.definition.javascript?.packages)
  const set = (part: Partial<AppTheme>) => update((def) => setTheme(def, { ...def.theme, ...part }))
  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-5" data-testid="app-settings">
      <section aria-label="Theme" className="flex flex-col gap-2.5">
        <div className="flex items-center">
          <h3 className={`flex-1 ${sectionLabelClass}`}>Theme</h3>
          {Object.keys(theme).length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => update((def) => setTheme(def, {}))}>
              <RotateCcw className="size-3.5" /> Optiply's
            </Button>
          )}
        </div>
        {COLORS.map(({ key, label, hint }) => (
          <ColorField
            key={key}
            label={label}
            hint={hint}
            value={theme[key] as string | undefined}
            onChange={(value) => set({ [key]: value })}
          />
        ))}
        <EditorField label="Corner radius (px)">
          <Input
            type="number"
            aria-label="Corner radius (px)"
            min={0}
            max={24}
            placeholder="Optiply's"
            className="h-8"
            value={theme.radius ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value)
              set({ radius: e.target.value === '' ? undefined : Math.max(0, Math.min(24, Math.round(n))) })
            }}
          />
        </EditorField>
        <EditorField label="Font">
          <Select
            aria-label="Font"
            value={theme.font ?? ''}
            onChange={(e) => set({ font: (e.target.value || undefined) as AppTheme['font'] })}
          >
            <option value="">Optiply's (Inter)</option>
            <option value="system">The system's</option>
            <option value="serif">Serif</option>
            <option value="mono">Monospace</option>
          </Select>
        </EditorField>
      </section>
      <section aria-label="Custom CSS" className="flex flex-col gap-2">
        <h3 className={sectionLabelClass}>Custom CSS</h3>
        <p className="text-[11px] text-muted">
          Applies inside the app only. Components have <code>data-component="name"</code>; <code>url()</code>{' '}
          and <code>@import</code> are dropped. Class names inside components may change.
        </p>
        <AppCodeField
          path={['css']}
          bind={false}
          language="css"
          height={220}
          value={css}
          problems={problemsAt(diagnostics, ['css'])}
          onChange={(next) => update((def) => setCustomCss(def, next))}
        />
      </section>
      {kind === 'app' && appId && (
        <JsPackagesField
          target={{ kind: 'app', id: appId }}
          packages={packages}
          problems={diagnostics
            .filter((d) => d.code === 'invalid_js_package')
            .map((d) => ({
              ...(typeof d.path[2] === 'number' && { index: d.path[2] }),
              message: d.message,
            }))}
          canEdit={!readOnly}
          hasEdit
          onChange={(lines) =>
            update((def) => {
              const { javascript: _old, ...rest } = def
              return lines.length ? { ...rest, javascript: { packages: lines } } : rest
            })
          }
        />
      )}
    </fieldset>
  )
}

/** A colour: the browser's picker and its hex, or unset (Optiply's). */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string | undefined
  onChange: (value: string | undefined) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${label} colour`}
        value={value ?? '#000000'}
        onChange={(e) => onChange(e.target.value)}
        // Unset: faded, since the picker can't show "Optiply's".
        className={`size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5 ${value ? '' : 'opacity-25'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{label}</div>
        <div className="truncate text-[11px] text-muted">{value ?? `${hint} · Optiply's`}</div>
      </div>
      <Input
        aria-label={`${label} hex`}
        placeholder="#rrggbb"
        className="h-7 w-20 font-mono text-xs"
        defaultValue={value ?? ''}
        key={value ?? ''}
        onBlur={(e) => {
          const next = e.target.value.trim()
          if (!next) onChange(undefined)
          else if (HEX.test(next)) onChange(next.toLowerCase())
          else e.target.value = value ?? ''
        }}
      />
    </div>
  )
}
