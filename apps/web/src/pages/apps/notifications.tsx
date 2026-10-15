import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { Button, Dialog } from '@/components/ui'
import { cn } from '@/lib/utils'

export type Tone = 'info' | 'success' | 'error'

interface Notice {
  id: number
  message: string
  tone: Tone
}

/** Notifications an app shows (`utils.notify`, a failed save); errors stay until closed, others for 4 s. */
export function useNotifications() {
  const [notices, setNotices] = useState<Notice[]>([])
  const nextId = useRef(1)
  const dismiss = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), [])
  const notify = useCallback(
    (message: string, tone: Tone) => {
      const id = nextId.current++
      setNotices((all) => [...all.slice(-4), { id, message, tone }])
      if (tone !== 'error') setTimeout(() => dismiss(id), 4000)
    },
    [dismiss],
  )
  return { notices, notify, dismiss }
}

const ICONS = {
  info: <Info className="size-4 text-accent" />,
  success: <CheckCircle2 className="size-4 text-success" />,
  error: <XCircle className="size-4 text-danger" />,
}

export function Notifications({ notices, dismiss }: { notices: Notice[]; dismiss: (id: number) => void }) {
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2"
      aria-live="polite"
    >
      {notices.map((n) => (
        <div
          key={n.id}
          role={n.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-sm shadow-lg',
            n.tone === 'error' ? 'border-danger/40' : 'border-border',
          )}
        >
          <span className="mt-0.5">{ICONS[n.tone]}</span>
          <span className="min-w-0 flex-1 break-words">{n.message}</span>
          <button
            type="button"
            title="Dismiss"
            onClick={() => dismiss(n.id)}
            className="text-muted hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

interface Question {
  id: number
  message: string
  answer: (ok: boolean) => void
}

/**
 * Confirmations a running app asks for (queries with "ask to confirm"). Questions queue: two handlers asking at
 * once each get their own answer, one after the other.
 */
export function useConfirmations(): { confirm: (message: string) => Promise<boolean>; dialog: ReactNode } {
  const [queue, setQueue] = useState<Question[]>([])
  const nextId = useRef(1)
  const confirm = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        setQueue((q) => [...q, { id: nextId.current++, message, answer: resolve }])
      }),
    [],
  )
  const current = queue[0]
  const answer = (ok: boolean) => {
    if (!current) return
    current.answer(ok)
    setQueue((q) => q.filter((item) => item.id !== current.id))
  }
  const dialog = current ? (
    <Dialog
      key={current.id}
      title="Are you sure?"
      onClose={() => answer(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Continue
          </Button>
        </>
      }
    >
      <p className="text-sm">{current.message}</p>
    </Dialog>
  ) : null
  return { confirm, dialog }
}
