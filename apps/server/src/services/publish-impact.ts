import { type AppDefinition, instanceRelease } from '@ow/app-definition'
import { appReleases, type Db, moduleReleases, workflowReleases } from '@ow/db'
import { allBlocks, libraryCall, type WorkflowDefinition } from '@ow/definition'
import { inArray } from 'drizzle-orm'
import { canSeeDependent, type Dependent } from './dependents'
import type { Access } from './permissions'

/** An app, module or workflow following a library query or module on `latest` that passes a name being dropped. */
export interface DroppedUse {
  kind: Dependent['kind']
  id: string
  slug: string
  name: string
  /** The dropped names it passes. */
  passes: string[]
}

/**
 * What publishing a library query's or module's draft would drop for those following it on `latest` (M21): the
 * parameters (or inputs) its live release declares and the draft doesn't, and the apps, modules and workflows
 * passing any of them (in their draft or live release), those the caller can see named, the others counted. A
 * warning for the publish dialog, not a refusal.
 */
export async function droppedUses(
  db: Db,
  access: Access,
  target: { kind: 'library' | 'module'; slug: string; live: string[] | null; draft: string[] },
  users: Dependent[],
): Promise<{ dropped: string[]; uses: DroppedUse[]; hidden: number }> {
  const dropped = (target.live ?? []).filter((name) => !target.draft.includes(name))
  if (!dropped.length || !users.length) return { dropped, uses: [], hidden: 0 }

  // The live releases of those using it live (their drafts are on the rows already).
  const liveIds = (kind: Dependent['kind']) =>
    users.flatMap((u) =>
      u.kind === kind && u.where.includes('live') && u.object.liveReleaseId ? [u.object.liveReleaseId] : [],
    )
  const [appLive, moduleLive, workflowLive] = await Promise.all([
    liveIds('app').length
      ? db
          .select()
          .from(appReleases)
          .where(inArray(appReleases.id, liveIds('app')))
      : [],
    liveIds('module').length
      ? db
          .select()
          .from(moduleReleases)
          .where(inArray(moduleReleases.id, liveIds('module')))
      : [],
    liveIds('workflow').length
      ? db
          .select()
          .from(workflowReleases)
          .where(inArray(workflowReleases.id, liveIds('workflow')))
      : [],
  ])
  const releases = new Map<string, unknown>(
    [...appLive, ...moduleLive, ...workflowLive].map((r) => [r.id, r.definition]),
  )

  const passed = (definition: unknown, kind: Dependent['kind']): string[] => {
    const names = new Set<string>()
    const add = (params: Record<string, unknown> | undefined) => {
      for (const name of Object.keys(params ?? {})) if (dropped.includes(name)) names.add(name)
    }
    if (kind === 'workflow') {
      if (target.kind !== 'library') return []
      for (const block of allBlocks(definition as WorkflowDefinition)) {
        const use = libraryCall(block)
        if (use && use.call.library === target.slug && use.call.version === 'latest') add(use.call.params)
      }
    } else if (target.kind === 'library') {
      for (const q of (definition as AppDefinition).queries) {
        if (q.kind === 'library' && q.library === target.slug && q.version === 'latest') add(q.params)
      }
    } else {
      for (const c of (definition as AppDefinition).components) {
        const ref = c.type === 'module' ? instanceRelease(c) : null
        if (ref?.slug === target.slug && ref.version === 'latest') add(c.props)
      }
    }
    return [...names]
  }

  const affected: Dependent[] = []
  const uses: DroppedUse[] = []
  for (const user of users) {
    const definitions = [
      ...(user.where.includes('draft') ? [user.object.draftDefinition] : []),
      ...(user.object.liveReleaseId && releases.has(user.object.liveReleaseId)
        ? [releases.get(user.object.liveReleaseId)]
        : []),
    ]
    const passes = [...new Set(definitions.flatMap((d) => passed(d, user.kind)))].sort()
    if (!passes.length) continue
    affected.push(user)
    if (canSeeDependent(access, user)) {
      const { id, slug, name } = user.object
      uses.push({ kind: user.kind, id, slug, name, passes })
    }
  }
  return { dropped, uses, hidden: affected.length - uses.length }
}
