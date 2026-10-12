import { History, Plug, Workflow } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/ui'

const SECTIONS = {
  workflows: {
    title: 'Workflows',
    description: 'Automate backend processes with blocks, triggers and schedules.',
    icon: <Workflow className="size-6" />,
    empty: 'The workflow editor arrives in milestone M3. The execution engine comes first, in M2.',
  },
  resources: {
    title: 'Resources',
    description: 'Connections to databases and APIs, configured per environment.',
    icon: <Plug className="size-6" />,
    empty: 'Postgres and REST resources, with encrypted credentials per environment, arrive in milestone M1.',
  },
  runs: {
    title: 'Runs',
    description: 'History of every workflow run, with per-block data and logs.',
    icon: <History className="size-6" />,
    empty: 'Run history appears here once the workflow engine is in place (M2–M3).',
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
