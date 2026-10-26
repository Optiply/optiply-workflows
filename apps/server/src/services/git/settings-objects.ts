import {
  type ConfigVar,
  configVars,
  configVarValues,
  type Db,
  environments,
  folders,
  type Resource,
  resourceConfigs,
  resources,
} from '@ow/db'
import { encodeSettingsDir, SETTINGS_LABELS, type SettingsKind, type SettingsObject } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { commitProtect, type ProtectResult } from './protection'

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

/** The folder's path from the top, `Finance/Reports`; undefined at the top level. */
export async function folderPathOf(db: Db, folderId: string | null): Promise<string | undefined> {
  if (!folderId) return undefined
  const names: string[] = []
  const seen = new Set<string>()
  let id: string | null = folderId
  while (id && !seen.has(id)) {
    seen.add(id)
    const [folder]: Array<{ name: string; parentId: string | null }> = await db
      .select({ name: folders.name, parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, id))
    if (!folder) break
    names.unshift(folder.name)
    id = folder.parentId
  }
  return names.length > 0 ? names.join('/') : undefined
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
    const folder = await folderPathOf(db, resource.folderId)
    return {
      kind,
      slug: resource.slug,
      value: {
        name: resource.name,
        description: resource.description,
        ...(folder ? { folder } : {}),
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
