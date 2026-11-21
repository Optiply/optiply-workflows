import { Plus, X } from 'lucide-react'
import { Button, Input, Select } from '@/components/ui'

/** One part of a REST query's multipart body (`@ow/connectors`' `multipart` body type, M15). */
export type MultipartPart =
  | { kind: 'text'; key: string; value: string }
  | { kind: 'file'; key: string; file: string; filename: string; contentType: string }

const TEXT_PART = { kind: 'text', key: '', value: '' } as const
const FILE_PART = { kind: 'file', key: '', file: '', filename: '', contentType: '' } as const

/**
 * The parts of a multipart body: text fields, and files whose value is base64 text or a webhook's uploaded file
 * (`{{ startTrigger.data.invoice }}` forwards it as received). A file's name and type default to the file object's.
 */
export function MultipartParts({
  parts,
  onChange,
  compact,
  disabled = false,
}: {
  parts: MultipartPart[]
  onChange: (parts: MultipartPart[]) => void
  /** Smaller inputs, for the workflow inspector. */
  compact?: boolean
  /** Read only (people who may only view the settings). */
  disabled?: boolean
}) {
  const input = compact ? 'h-8 font-mono' : 'font-mono'
  const set = (i: number, part: MultipartPart) => onChange(parts.map((p, j) => (j === i ? part : p)))
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity besides their position
        <div key={i} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <div className="flex gap-1.5">
            <Select
              aria-label="Part type"
              className={compact ? 'h-8 w-24' : 'w-28'}
              value={part.kind}
              disabled={disabled}
              onChange={(e) =>
                set(
                  i,
                  e.target.value === 'file'
                    ? { ...FILE_PART, key: part.key }
                    : { ...TEXT_PART, key: part.key },
                )
              }
            >
              <option value="text">Text</option>
              <option value="file">File</option>
            </Select>
            <Input
              aria-label="Part name"
              className={input}
              placeholder="name"
              value={part.key}
              disabled={disabled}
              onChange={(e) => set(i, { ...part, key: e.target.value })}
            />
            {!disabled && (
              <Button
                size="icon"
                variant="ghost"
                title="Remove"
                onClick={() => onChange(parts.filter((_, j) => j !== i))}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          {part.kind === 'text' ? (
            <Input
              aria-label="Part value"
              className={input}
              placeholder="value or {{ }}"
              value={part.value}
              disabled={disabled}
              onChange={(e) => set(i, { ...part, value: e.target.value })}
            />
          ) : (
            <>
              <Input
                aria-label="File"
                className={input}
                placeholder="{{ startTrigger.data.invoice }} or base64"
                value={part.file}
                disabled={disabled}
                onChange={(e) => set(i, { ...part, file: e.target.value })}
              />
              <div className="flex gap-1.5">
                <Input
                  aria-label="File name"
                  className={input}
                  placeholder="file name"
                  title="Optional: defaults to the uploaded file's name, else the part's name"
                  value={part.filename}
                  disabled={disabled}
                  onChange={(e) => set(i, { ...part, filename: e.target.value })}
                />
                <Input
                  aria-label="Content type"
                  className={input}
                  placeholder="content type"
                  title="Optional: defaults to the uploaded file's type, else application/octet-stream"
                  value={part.contentType}
                  disabled={disabled}
                  onChange={(e) => set(i, { ...part, contentType: e.target.value })}
                />
              </div>
            </>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => onChange([...parts, { ...TEXT_PART }])}>
            <Plus className="size-3.5" /> Text
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange([...parts, { ...FILE_PART }])}>
            <Plus className="size-3.5" /> File
          </Button>
        </div>
      )}
    </div>
  )
}
