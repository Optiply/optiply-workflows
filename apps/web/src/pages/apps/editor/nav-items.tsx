import { type JsonValue, NAV_ICONS, setProp } from '@ow/app-definition'
import { ChevronDown, ChevronRight, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Input, Select } from '@/components/ui'
import { useAppEditor } from './store'

type Item = { [key: string]: JsonValue }

const asItem = (v: JsonValue): Item | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const kindOf = (item: Item) =>
  Array.isArray(item.items)
    ? 'group'
    : typeof item.url === 'string'
      ? 'url'
      : typeof item.page !== 'string' && typeof item.key === 'string'
        ? 'action'
        : 'page'

/**
 * A Navigation's links as a list (M24): each a page, an outside link, an action (M36: a key its click handlers check)
 * or a group of links, with its label, icon and a
 * condition hiding it; groups hold one level of links. "Edit as JSON" covers the rest (a page's URL params).
 */
export function NavItemsEditor({ name, items }: { name: string; items: JsonValue[] }) {
  const update = useAppEditor((s) => s.update)
  const readOnly = useAppEditor((s) => s.readOnly)
  const pages = useAppEditor((s) => s.definition.pages) ?? []
  const set = (next: JsonValue[]) =>
    update((def) => setProp(def, name, 'items', next.length ? next : undefined))
  return (
    <div data-testid={`nav-items-${name}`}>
      {items.length === 0 && <p className="mb-1 text-xs text-muted">Every page, by its title.</p>}
      <ItemList items={items} pages={pages} readOnly={readOnly} depth={0} onChange={set} />
    </div>
  )
}

function ItemList({
  items,
  pages,
  readOnly,
  depth,
  onChange,
}: {
  items: JsonValue[]
  pages: { name: string; title?: string }[]
  readOnly: boolean
  depth: number
  onChange: (items: JsonValue[]) => void
}) {
  const [open, setOpen] = useState<number | null>(null)
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    onChange(next)
  }
  const firstPage = pages[0]?.name
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {items.map((raw, i) => {
          const item = asItem(raw)
          if (!item) return null
          const kind = kindOf(item)
          const change = (patch: Item, drop: string[] = []) => {
            const next: Item = { ...item, ...patch }
            for (const key of drop) delete next[key]
            // An action's key stays while it's being typed (without one it would be a page).
            for (const [key, value] of Object.entries(patch))
              if (value === '' && key !== 'key') delete next[key]
            onChange(items.map((v, j) => (j === i ? next : v)))
          }
          const expanded = open === i
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: links are edited in place; a label can be blank or repeated while typed
              key={i}
              className="rounded-md border border-border bg-surface"
              data-testid={`nav-item-${depth}-${i}`}
            >
              <div className="flex items-center gap-1 p-1">
                <button
                  type="button"
                  aria-label={expanded ? 'Fewer settings' : 'More settings'}
                  aria-expanded={expanded}
                  className="rounded p-0.5 text-muted hover:text-ink"
                  onClick={() => setOpen(expanded ? null : i)}
                >
                  {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
                <Select
                  aria-label="Link to"
                  value={kind}
                  disabled={readOnly}
                  onChange={(e) =>
                    e.target.value === 'group'
                      ? change({ items: [] }, ['page', 'params', 'url', 'key'])
                      : e.target.value === 'url'
                        ? change({ url: 'https://' }, ['page', 'params', 'items', 'key'])
                        : e.target.value === 'action'
                          ? change({ key: `item${i + 1}` }, ['page', 'params', 'url', 'items'])
                          : change({ page: firstPage ?? '' }, ['url', 'items', 'key'])
                  }
                  className="h-7 w-20 shrink-0 text-xs"
                >
                  <option value="page">Page</option>
                  <option value="url">Link</option>
                  <option value="action">Action</option>
                  {depth === 0 && <option value="group">Group</option>}
                </Select>
                {kind === 'page' ? (
                  <Select
                    aria-label="Page"
                    value={typeof item.page === 'string' ? item.page : ''}
                    disabled={readOnly}
                    onChange={(e) => change({ page: e.target.value })}
                    className="h-7 min-w-0 flex-1 text-xs"
                  >
                    {pages.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.title || p.name}
                      </option>
                    ))}
                  </Select>
                ) : kind === 'action' ? (
                  <Input
                    aria-label="Key"
                    title="Clicking sets clickedItem to this key and fires click"
                    value={typeof item.key === 'string' ? item.key : ''}
                    disabled={readOnly}
                    onChange={(e) => change({ key: e.target.value })}
                    className="h-7 min-w-0 flex-1 text-xs"
                  />
                ) : kind === 'url' ? (
                  <Input
                    aria-label="Address"
                    value={typeof item.url === 'string' ? item.url : ''}
                    disabled={readOnly}
                    onChange={(e) => change({ url: e.target.value })}
                    className="h-7 min-w-0 flex-1 text-xs"
                  />
                ) : (
                  <span className="min-w-0 flex-1 px-1 text-xs text-muted">
                    {Array.isArray(item.items) ? item.items.length : 0} links
                  </span>
                )}
                {!readOnly && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Remove link"
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
              <div className="flex gap-1 px-1 pb-1">
                <Input
                  aria-label="Label"
                  placeholder={
                    kind === 'page'
                      ? 'The page’s title'
                      : kind === 'url'
                        ? 'The address'
                        : kind === 'action'
                          ? 'The key'
                          : 'Menu'
                  }
                  value={typeof item.label === 'string' ? item.label : ''}
                  disabled={readOnly}
                  onChange={(e) => change({ label: e.target.value })}
                  className="h-7 min-w-0 flex-1 text-xs"
                />
                <Select
                  aria-label="Icon"
                  value={typeof item.icon === 'string' ? item.icon : ''}
                  disabled={readOnly}
                  onChange={(e) => change({ icon: e.target.value })}
                  className="h-7 w-28 shrink-0 text-xs"
                >
                  <option value="">No icon</option>
                  {NAV_ICONS.map((icon) => (
                    <option key={icon} value={icon}>
                      {icon}
                    </option>
                  ))}
                </Select>
              </div>
              {expanded && (
                <div className="flex flex-col gap-1 border-t border-border p-1.5 text-xs">
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is a component inside the label */}
                  <label className="flex flex-col gap-1">
                    Hidden when
                    <Input
                      aria-label="Hidden when"
                      placeholder="{{ !current_user.email.endsWith('@optiply.nl') }}"
                      value={
                        typeof item.hidden === 'string' ? item.hidden : item.hidden === true ? 'true' : ''
                      }
                      disabled={readOnly}
                      onChange={(e) => change({ hidden: e.target.value })}
                      className="h-7 font-mono text-xs"
                    />
                  </label>
                  {!readOnly && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => move(i, i - 1)}>
                        <ChevronUp className="size-3.5" /> Up
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => move(i, i + 1)}>
                        <ChevronDown className="size-3.5" /> Down
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {kind === 'group' && (
                <div className="border-t border-border p-1.5 pl-4">
                  <ItemList
                    items={Array.isArray(item.items) ? item.items : []}
                    pages={pages}
                    readOnly={readOnly}
                    depth={depth + 1}
                    onChange={(sub) => change({ items: sub })}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => onChange([...items, firstPage ? { page: firstPage } : { url: 'https://' }])}
        >
          <Plus className="size-3.5" /> {depth === 0 ? 'Add link' : 'Add link to the group'}
        </Button>
      )}
    </div>
  )
}
