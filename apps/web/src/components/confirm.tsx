import { create } from 'zustand'
import { Button, Dialog } from '@/components/ui'

/**
 * Asking before something that can't be taken back (M24): the platform's dialog instead of the browser's `confirm()`
 * (which blocks the page, can't be styled and can be turned off by the browser). `confirmDialog` resolves true when
 * the person confirms; `ConfirmHost`, mounted once, shows the questions one at a time.
 */

interface Question {
  id: number
  message: string
  title: string
  confirm: string
  danger: boolean
  answer: (ok: boolean) => void
}

const useQuestions = create<{ queue: Question[] }>(() => ({ queue: [] }))
let nextId = 1

/** Asks `message`; true when confirmed, false when cancelled (the Cancel button, Escape, a click outside). */
export function confirmDialog(
  message: string,
  opts: { title?: string; confirm?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((answer) => {
    const question: Question = {
      id: nextId++,
      message,
      title: opts.title ?? 'Are you sure?',
      confirm: opts.confirm ?? (opts.danger ? 'Delete' : 'Continue'),
      danger: opts.danger ?? false,
      answer,
    }
    useQuestions.setState((s) => ({ queue: [...s.queue, question] }))
  })
}

/** Shows the first question asked; mounted once, at the root of the page. */
export function ConfirmHost() {
  const current = useQuestions((s) => s.queue[0])
  if (!current) return null
  const answer = (ok: boolean) => {
    current.answer(ok)
    useQuestions.setState((s) => ({ queue: s.queue.filter((q) => q.id !== current.id) }))
  }
  return (
    <Dialog
      key={current.id}
      title={current.title}
      onClose={() => answer(false)}
      footer={
        <>
          <Button data-testid="confirm-cancel" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button
            variant={current.danger ? 'danger' : 'primary'}
            // Enter confirms, as it did in the browser's dialog.
            autoFocus
            data-testid="confirm-ok"
            onClick={() => answer(true)}
          >
            {current.confirm}
          </Button>
        </>
      }
    >
      <p className="text-sm whitespace-pre-wrap">{current.message}</p>
    </Dialog>
  )
}
