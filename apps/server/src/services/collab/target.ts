import { appDefinitionSchema, componentLibraryDefinitionSchema } from '@ow/app-definition'
import {
  appSpec,
  type CollabSpec,
  componentLibrarySpec,
  libraryQuerySpec,
  parseCollabKey,
  workflowSpec,
} from '@ow/collab'
import type { Db } from '@ow/db'
import { libraryQueryDefinitionSchema, workflowDefinitionSchema } from '@ow/definition'
import type { ObjectKind } from '@ow/git-format'
import type { SessionUser } from '../../auth/sessions'
import { loadBranchDraft } from '../git/branch-drafts'
import { gitObjectLevel, loadGitObject } from '../git/kinds'
import { atLeast, loadAccess } from '../permissions'

/** Which row of `collab_documents` a document belongs to. */
export type CollabOwner =
  | { workflowId: string }
  | { appId: string }
  | { moduleId: string }
  | { libraryQueryId: string }
  | { componentLibraryId: string }
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
 * The draft a key names, if `user` may see it: a workflow's, app's, module's or library query's (M21) main draft (Use
 * to watch, Edit to write, read-only for everyone when protected), or a Git branch draft of one (Edit, as for the
 * branch drafts API).
 * Null when there's no such draft or the user can't see it: the same answer, so keys reveal nothing.
 */
export async function resolveTarget(db: Db, user: SessionUser, key: string): Promise<CollabTarget | null> {
  const parsed = parseCollabKey(key)
  if (!parsed) return null
  const access = await loadAccess(db, user)
  if (parsed.kind === 'branch') {
    const loaded = await loadBranchDraft(db, parsed.id).catch(() => null)
    if (!loaded) return null
    const level = gitObjectLevel(access, loaded.target.kind, loaded.target.object)
    if (!atLeast(level, 'edit')) return null
    const { draft } = loaded
    return {
      key,
      ...rules(loaded.target.kind),
      owner: { branchDraftId: draft.id },
      readOnly: false,
      draft: { definition: draft.definition, revision: draft.revision },
    }
  }
  const kind: ObjectKind =
    parsed.kind === 'library'
      ? 'library_query'
      : parsed.kind === 'components'
        ? 'component_library'
        : parsed.kind
  const object = await loadGitObject(db, kind, { id: parsed.id })
  const level = object && gitObjectLevel(access, kind, object)
  if (!object || !level) return null
  return {
    key,
    ...rules(kind),
    owner:
      kind === 'workflow'
        ? { workflowId: object.id }
        : kind === 'app'
          ? { appId: object.id }
          : kind === 'module'
            ? { moduleId: object.id }
            : kind === 'component_library'
              ? { componentLibraryId: object.id }
              : { libraryQueryId: object.id },
    readOnly: !atLeast(level, 'edit') || object.gitProtected,
    draft: { definition: object.draftDefinition, revision: object.draftRevision },
  }
}

/** A kind's mapping and schema: a workflow's, a library query's (M21) or an app's (a module's definition is an app's). */
function rules(kind: ObjectKind): Pick<CollabTarget, 'spec' | 'check'> {
  const [spec, schema] =
    kind === 'workflow'
      ? [workflowSpec, workflowDefinitionSchema]
      : kind === 'library_query'
        ? [libraryQuerySpec, libraryQueryDefinitionSchema]
        : kind === 'component_library'
          ? [componentLibrarySpec, componentLibraryDefinitionSchema]
          : [appSpec, appDefinitionSchema]
  return {
    spec,
    check: (definition) => {
      const parsed = schema.safeParse(definition)
      if (parsed.success) return null
      const issue = parsed.error.issues[0]
      return issue ? `${issue.path.join('.') || 'definition'}: ${issue.message}` : 'Invalid definition'
    },
  }
}
