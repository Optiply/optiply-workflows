import { appDefinitionSchema } from '@ow/app-definition'
import { appSpec, type CollabSpec, parseCollabKey, workflowSpec } from '@ow/collab'
import type { Db } from '@ow/db'
import { workflowDefinitionSchema } from '@ow/definition'
import type { SessionUser } from '../../auth/sessions'
import { loadBranchDraft } from '../git/branch-drafts'
import { gitObjectLevel, loadGitObject } from '../git/kinds'
import { atLeast, loadAccess } from '../permissions'

/** Which row of `collab_documents` a document belongs to. */
export type CollabOwner =
  | { workflowId: string }
  | { appId: string }
  | { moduleId: string }
  | { branchDraftId: string }

/** A draft someone opened for editing together, as they may use it. */
export interface CollabTarget {
  key: string
  spec: CollabSpec
  /** Why a definition can't be saved as this draft (the schema's first complaint), or null when it can. */
  check(definition: unknown): string | null
  owner: CollabOwner
  /** Watching only: Use on the object, or its main draft is protected by Git (edited on branches, M11). */
  readOnly: boolean
  /** The draft as stored now. */
  draft: { definition: unknown; revision: number }
}

/**
 * The draft a key names, if `user` may see it: a workflow's, app's or module's main draft (Use to watch, Edit to
 * write, read-only for everyone when protected), or a Git branch draft of one (Edit, as for the branch drafts API).
 * Null when there's no such draft or the user can't see it: the same answer, so keys reveal nothing.
 */
export async function resolveTarget(db: Db, user: SessionUser, key: string): Promise<CollabTarget | null> {
  const parsed = parseCollabKey(key)
  if (!parsed) return null
  const access = await loadAccess(db, user)
  if (parsed.kind === 'branch') {
    const loaded = await loadBranchDraft(db, parsed.id).catch(() => null)
    if (!loaded || loaded.target.kind === 'library_query') return null
    const level = gitObjectLevel(access, loaded.target.kind, loaded.target.object)
    if (!atLeast(level, 'edit')) return null
    const { draft } = loaded
    return {
      key,
      ...rules(loaded.target.kind === 'workflow'),
      owner: { branchDraftId: draft.id },
      readOnly: false,
      draft: { definition: draft.definition, revision: draft.revision },
    }
  }
  const object = await loadGitObject(db, parsed.kind, { id: parsed.id })
  const level = object && gitObjectLevel(access, parsed.kind, object)
  if (!object || !level) return null
  return {
    key,
    ...rules(parsed.kind === 'workflow'),
    owner:
      parsed.kind === 'workflow'
        ? { workflowId: object.id }
        : parsed.kind === 'app'
          ? { appId: object.id }
          : { moduleId: object.id },
    readOnly: !atLeast(level, 'edit') || object.gitProtected,
    draft: { definition: object.draftDefinition, revision: object.draftRevision },
  }
}

/** A workflow's mapping and schema, or an app's (a module's definition is an app's). */
function rules(workflow: boolean): Pick<CollabTarget, 'spec' | 'check'> {
  const schema = workflow ? workflowDefinitionSchema : appDefinitionSchema
  return {
    spec: workflow ? workflowSpec : appSpec,
    check: (definition) => {
      const parsed = schema.safeParse(definition)
      if (parsed.success) return null
      const issue = parsed.error.issues[0]
      return issue ? `${issue.path.join('.') || 'definition'}: ${issue.message}` : 'Invalid definition'
    },
  }
}
