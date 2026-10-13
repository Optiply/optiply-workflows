import { History } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/ui'

const SECTIONS = {
  runs: {
    title: 'Runs',
    description: 'History of every workflow run, with per-block data and logs.',
    icon: <History className="size-6" />,
    empty: 'Run history arrives later in M3. Meanwhile, runs are listed per workflow through the runs API.',
  },
} as const

export function ComingSoon({ section }: { section: keyof typeof SECTIONS }) {
  const s = SECTIONS[section]
  return (
    <>
      <PageHeader title={s.title} description={s.description} />
      <EmptyState icon={s.icon} title="Not built yet">
        {s.empty}
      </EmptyState>
    </>
  )
}
