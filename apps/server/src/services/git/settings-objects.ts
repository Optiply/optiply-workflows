import { getConnector } from '@ow/connectors'
import {
  type ConfigVar,
  configVars,
  configVarValues,
  type Db,
  environments,
  type Resource,
  resourceConfigs,
  resources,
} from '@ow/db'
import {
  decodeSettings,
  encodeSettingsDir,
  SETTINGS_LABELS,
  type SettingsKind,
  type SettingsObject,
  settingsDir,
} from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { invalidInput } from '../../trpc/errors'
import { commitToBranch } from './commit'
import { gitFolderPath } from './folders'
import {
  commitProtect,
  gitTrpcError,
  manifestIfMissing,
  type ProtectResult,
  requireGitRepo,
  requireNotDeployBranch,
} from './protection'
import type { GitRepo } from './repo'

/**
 * Resources and config vars in Git (M22): no drafts or releases, so the repo holds their current settings. On a
 * protected one, what the repo holds changes through Git only; secrets, overrides and local values stay the
 * instance's.
 */
export type SettingsRow = Resource | ConfigVar

/** A resource's slug or a config var's name: what its directory is called. */
export function settingsSlug(kind: SettingsKind, row: SettingsRow): string {
  return kind === 'resource' ? (row as Resource).slug : (row as ConfigVar).name
}

export async function loadSettingsRow(db: Db, kind: SettingsKind, id: string): Promise<SettingsRow | null> {
  const table = kind === 'resource' ? resources : configVars
  const [row] = await db.select().from(table).where(eq(table.id, id))
  return row ?? null
}

/**
 * What the repo holds of a resource or config var on this instance: a resource's non-secret config per environment
 * (overrides left out: they're this instance's), a config var's values per environment (local and secret ones left
 * out).
 */
export async function settingsObject(db: Db, kind: SettingsKind, row: SettingsRow): Promise<SettingsObject> {
  if (kind === 'resource') {
    const resource = row as Resource
    const configs = await db
      .select({ env: environments.slug, config: resourceConfigs.config })
      .from(resourceConfigs)
      .innerJoin(environments, eq(environments.id, resourceConfigs.environmentId))
      .where(eq(resourceConfigs.resourceId, resource.id))
    const folder = await gitFolderPath(db, resource.folderId)
    return {
      kind,
      slug: resource.slug,
      value: {
        name: resource.name,
        description: resource.description,
        folder,
        type: resource.type,
        environments: Object.fromEntries(configs.map((c) => [c.env, { config: c.config }])),
      },
    }
  }
  const variable = row as ConfigVar
  const values = variable.isSecret
    ? []
    : await db
        .select({ env: environments.slug, value: configVarValues.value })
        .from(configVarValues)
        .innerJoin(environments, eq(environments.id, configVarValues.environmentId))
        .where(and(eq(configVarValues.configVarId, variable.id), eq(configVarValues.local, false)))
  return {
    kind,
    slug: variable.name,
    value: {
      description: variable.description,
      secret: variable.isSecret,
      values: Object.fromEntries(values.flatMap((v) => (v.value === null ? [] : [[v.env, v.value]]))),
    },
  }
}

export async function setSettingsProtected(
  db: Db,
  kind: SettingsKind,
  id: string,
  value: boolean,
  opts: { from?: boolean } = {},
): Promise<boolean> {
  const table = kind === 'resource' ? resources : configVars
  const where =
    opts.from === undefined ? eq(table.id, id) : and(eq(table.id, id), eq(table.gitProtected, opts.from))
  const updated = await db.update(table).set({ gitProtected: value }).where(where).returning({ id: table.id })
  return updated.length > 0
}

/** Refuses changing what Git holds of a protected resource or config var on the instance. */
export function requireSettingsUnprotected(
  row: { gitProtected: boolean },
  kind: SettingsKind,
  action: string,
) {
  if (row.gitProtected) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `This ${SETTINGS_LABELS[kind]} is protected: ${action} through Git (Save to branch, then merge)`,
    })
  }
}

/**
 * Protects a resource or config var: its settings go onto a branch as its directory, a pull request adds it to the
 * deploy branch, and from now on its settings change through Git.
 */
export async function protectSettings(
  db: Db,
  config: Parameters<typeof commitProtect>[1],
  user: { id: string; name: string; email: string },
  opts: { kind: SettingsKind; row: SettingsRow; branch?: string },
): Promise<ProtectResult> {
  const { kind, row } = opts
  const label = SETTINGS_LABELS[kind]
  if (row.gitProtected)
    throw new TRPCError({ code: 'CONFLICT', message: `This ${label} is already protected` })
  if (kind === 'resource' && (row as Resource).systemKind) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Built-in resources stay on each instance' })
  }
  const slug = settingsSlug(kind, row)
  const { dir, files, warnings } = encodeSettingsDir(await settingsObject(db, kind, row))
  return commitProtect(db, config, user, {
    kind: kind === 'config_var' ? 'config-var' : kind,
    label,
    slug,
    name: kind === 'resource' ? (row as Resource).name : slug,
    dir,
    files,
    warnings,
    branch: opts.branch,
    what: kind === 'resource' ? 'settings (secrets stay on each instance)' : 'values',
    afterBase: 'changed through Git and deployed',
    setProtected: () => setSettingsProtected(db, kind, row.id, true, { from: false }),
  })
}

/** Lets a resource or config var be changed on the instance again. Its directory stays in the repo. */
export async function unprotectSettings(db: Db, kind: SettingsKind, row: SettingsRow): Promise<void> {
  if (!row.gitProtected) {
    throw new TRPCError({ code: 'CONFLICT', message: `This ${SETTINGS_LABELS[kind]} isn't protected` })
  }
  await setSettingsProtected(db, kind, row.id, false)
}

/**
 * What the form sends to Save to branch (M22): a resource's name, description, folder and config per environment id;
 * a config var's description and non-secret values per environment id (null removes one). Environments this
 * instance doesn't have keep what the repo holds for them.
 */
export interface SettingsEdit {
  name?: string
  description?: string | null
  folder?: string | null
  configs?: Record<string, unknown>
  values?: Record<string, string | null>
}

/** The directory as the branch (or, before it exists, the deploy branch) holds it, decoded; null when it can't be. */
async function settingsAt(repo: GitRepo, commit: string, kind: SettingsKind, slug: string) {
  const dir = settingsDir(kind, slug)
  const all = await repo.readFiles(commit, [`${dir}/`])
  const files = Object.fromEntries(
    Object.entries(all).map(([path, content]) => [path.slice(dir.length + 1), content]),
  )
  const decoded = decodeSettings({ kind, slug, files })
  return { files, value: decoded.ok ? decoded.value : null }
}

/** The object Save to branch writes: what the repo holds, with the form's edits on top. */
async function editedSettings(
  db: Db,
  kind: SettingsKind,
  row: SettingsRow,
  there: SettingsObject | null,
  edit: SettingsEdit,
): Promise<SettingsObject> {
  const here = await settingsObject(db, kind, row)
  const start = there ?? here
  const envs = await db.select({ id: environments.id, slug: environments.slug }).from(environments)
  const slugOf = (id: string) => {
    const env = envs.find((e) => e.id === id)
    if (!env) throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' })
    return env.slug
  }
  if (start.kind === 'resource') {
    const resource = row as Resource
    const connector = getConnector(resource.type)
    if (!connector)
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown resource type "${resource.type}"` })
    const environmentsOut = { ...start.value.environments }
    for (const [envId, config] of Object.entries(edit.configs ?? {})) {
      const parsed = connector.configSchema.safeParse(config)
      if (!parsed.success) throw invalidInput('configuration', parsed.error.issues)
      environmentsOut[slugOf(envId)] = { config: parsed.data as Record<string, unknown> }
    }
    const folder = edit.folder === undefined ? start.value.folder : edit.folder || null
    const { folder: _f, ...rest } = start.value
    return {
      kind: 'resource',
      slug: start.slug,
      value: {
        ...rest,
        name: edit.name ?? start.value.name,
        description: edit.description === undefined ? start.value.description : edit.description || null,
        ...(folder ? { folder } : {}),
        type: resource.type,
        environments: environmentsOut,
      },
    }
  }
  const variable = row as ConfigVar
  const values = { ...(start.kind === 'config_var' ? start.value.values : {}) }
  if (variable.isSecret && Object.keys(edit.values ?? {}).length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "A secret config var's values stay on each instance",
    })
  }
  for (const [envId, value] of Object.entries(edit.values ?? {})) {
    if (value === null) delete values[slugOf(envId)]
    else values[slugOf(envId)] = value
  }
  const description =
    edit.description === undefined
      ? start.kind === 'config_var'
        ? start.value.description
        : variable.description
      : edit.description || null
  return {
    kind: 'config_var',
    slug: variable.name,
    value: { description, secret: variable.isSecret, values: variable.isSecret ? {} : values },
  }
}

/**
 * What Save to branch would change on the branch: the files against the branch's tip (or the deploy branch, when the
 * branch doesn't exist yet), and that commit as `base`, which the commit is made from.
 */
export async function settingsChanges(
  db: Db,
  config: Parameters<typeof commitProtect>[1],
  opts: { kind: SettingsKind; row: SettingsRow; branch: string; edit: SettingsEdit },
) {
  const { repo, branch: deployBranch } = await requireGitRepo(db, config)
  requireNotDeployBranch(opts.branch, deployBranch)
  requireProtected(opts.kind, opts.row)
  try {
    const tip = await repo.fetchBranch(opts.branch)
    const base = tip ?? (await repo.fetchBranch(deployBranch))
    if (!base)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${deployBranch} doesn't exist yet` })
    const slug = settingsSlug(opts.kind, opts.row)
    const there = await settingsAt(repo, base, opts.kind, slug)
    const object = await editedSettings(db, opts.kind, opts.row, there.value, opts.edit)
    const { dir, files: now } = encodeSettingsDir(object)
    const paths = [...new Set([...Object.keys(now), ...Object.keys(there.files)])].sort()
    const files = paths.flatMap((path) => {
      const before = there.files[path]
      const after = now[path]
      if (before === after) return []
      return [
        {
          path: `${dir}/${path}`,
          status: (before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified') as
            | 'added'
            | 'modified'
            | 'deleted',
          before: before ?? null,
          after: after ?? null,
        },
      ]
    })
    return { base, branchExists: tip !== null, files }
  } catch (err) {
    throw gitTrpcError(err)
  }
}

/**
 * Save to branch: the edited settings committed onto the branch (made from the deploy branch when new) from `base`,
 * the commit Changes showed; CONFLICT when the branch changed the directory since.
 */
export async function commitSettings(
  db: Db,
  config: Parameters<typeof commitProtect>[1],
  user: { name: string; email: string },
  opts: {
    kind: SettingsKind
    row: SettingsRow
    branch: string
    base: string
    edit: SettingsEdit
    message: string
  },
) {
  const { repo, branch: deployBranch } = await requireGitRepo(db, config)
  requireNotDeployBranch(opts.branch, deployBranch)
  requireProtected(opts.kind, opts.row)
  try {
    if (!(await repo.ensureCommit(opts.base))) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The branch moved: look at the changes again' })
    }
    const slug = settingsSlug(opts.kind, opts.row)
    const there = await settingsAt(repo, opts.base, opts.kind, slug)
    const { dir, files } = encodeSettingsDir(
      await editedSettings(db, opts.kind, opts.row, there.value, opts.edit),
    )
    const result = await commitToBranch(repo, {
      branch: opts.branch,
      base: opts.base,
      createFrom: opts.base,
      directories: { [dir]: files },
      files: await manifestIfMissing(repo, opts.base),
      message: opts.message,
      author: { name: user.name, email: user.email },
    })
    return { branch: opts.branch, commit: result.commit, changed: result.changed }
  } catch (err) {
    throw gitTrpcError(err)
  }
}

function requireProtected(kind: SettingsKind, row: SettingsRow) {
  if (!row.gitProtected) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `This ${SETTINGS_LABELS[kind]} isn't kept in Git: change it here, or protect it first`,
    })
  }
}
