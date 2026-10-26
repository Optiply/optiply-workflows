import { getConnector } from '@ow/connectors'
import { configVars, configVarValues, type Db, environments, resourceConfigs, resources } from '@ow/db'
import { canonicalJson } from '@ow/definition'
import {
  type ConfigVarObject,
  type ResourceObject,
  SETTINGS_LABELS,
  type SettingsKind,
  settingsDir,
} from '@ow/git-format'
import { and, eq } from 'drizzle-orm'
import { recordAudit } from '../../audit'
import { authFingerprint, deleteTokens } from '../oauth-tokens'
import { applyOverrides, serverIdentityTarget } from '../resources'
import type { ObjectOutcome } from './deploy'

/**
 * Deploying resources and config vars (M22): they have no releases, so a deploy writes what Git holds of them
 * straight into the instance's settings, leaving what's the instance's own (secrets, overrides, local values).
 */

export interface SettingsItem<V> {
  slug: string
  treeSha: string | null
  value: V
}

function problemOf(kind: SettingsKind, item: SettingsItem<unknown>, objectId: string | null = null) {
  return (code: string, message: string): ObjectOutcome => ({
    kind,
    slug: item.slug,
    outcome: 'problem',
    objectId,
    treeSha: item.treeSha,
    problems: [{ path: settingsDir(kind, item.slug), code, message }],
  })
}

/**
 * A config var from Git: created protected when the instance has none by that name; its description and non-secret
 * values per environment written, except local ones (an environment Git has no value for loses its non-local one).
 * Whether it's secret can't change: that would expose or strand stored values.
 */
export async function deployConfigVar(
  db: Db,
  item: SettingsItem<ConfigVarObject>,
  git: { commit: string },
): Promise<ObjectOutcome> {
  const label = SETTINGS_LABELS.config_var
  let problem = problemOf('config_var', item)
  const { value } = item
  let [variable] = await db.select().from(configVars).where(eq(configVars.name, item.slug))
  let created = false
  if (!variable) {
    const [inserted] = await db
      .insert(configVars)
      .values({ name: item.slug, description: value.description, isSecret: value.secret, gitProtected: true })
      .onConflictDoNothing()
      .returning()
    if (!inserted) return problem('slug_taken', `A ${label} "${item.slug}" was just created on the instance`)
    variable = inserted
    created = true
    await recordAudit(db, {
      actorUserId: null,
      action: 'config_var.created',
      objectType: 'config_var',
      objectId: variable.id,
      metadata: { name: item.slug, source: 'git', commit: git.commit },
    })
  } else {
    problem = problemOf('config_var', item, variable.id)
    if (!variable.gitProtected) {
      return problem(
        'not_protected',
        `A ${label} "${item.slug}" exists on the instance and isn't protected: protect it there to deploy it from Git`,
      )
    }
    if (variable.isSecret !== value.secret) {
      return problem(
        'invalid_definition',
        `${label} "${item.slug}" is ${variable.isSecret ? '' : 'not '}secret on the instance, and that can't change: make a new one`,
      )
    }
  }

  let changed = false
  if (!created && (variable.description ?? null) !== value.description) {
    await db.update(configVars).set({ description: value.description }).where(eq(configVars.id, variable.id))
    changed = true
  }
  if (!value.secret) {
    const envs = await db.select({ id: environments.id, slug: environments.slug }).from(environments)
    const rows = await db.select().from(configVarValues).where(eq(configVarValues.configVarId, variable.id))
    for (const env of envs) {
      const row = rows.find((r) => r.environmentId === env.id)
      if (row?.local) continue
      const next = value.values[env.slug]
      if (next === undefined) {
        if (row) {
          await db.delete(configVarValues).where(eq(configVarValues.id, row.id))
          changed = true
        }
      } else if (!row) {
        await db.insert(configVarValues).values({
          configVarId: variable.id,
          environmentId: env.id,
          value: next,
          valueEncrypted: null,
        })
        changed = true
      } else if (row.value !== next) {
        await db
          .update(configVarValues)
          .set({ value: next, updatedBy: null, updatedAt: new Date() })
          .where(and(eq(configVarValues.id, row.id)))
        changed = true
      }
    }
  }
  if (changed && !created) {
    await recordAudit(db, {
      actorUserId: null,
      action: 'config_var.updated',
      objectType: 'config_var',
      objectId: variable.id,
      metadata: { name: item.slug, source: 'git', commit: git.commit },
    })
  }
  return {
    kind: 'config_var',
    slug: item.slug,
    outcome: created ? 'created' : changed ? 'updated' : 'unchanged',
    objectId: variable.id,
    treeSha: item.treeSha,
  }
}

/**
 * A resource from Git: created protected (no owner: admins grant access) when the instance has none by that slug,
 * or its name, description and each environment's config written. Secrets, OAuth accounts (dropped when the sign-in
 * settings change, as when saving) and overrides stay. Everything is checked before anything is written: the type,
 * each config by the connector, the overrides still fitting, and the server's own Google identity being allowed.
 * An environment Git doesn't configure loses its config here.
 */
export async function deployResource(
  db: Db,
  item: SettingsItem<ResourceObject>,
  git: { commit: string },
  opts: { serverIdentity: boolean },
): Promise<ObjectOutcome> {
  const label = SETTINGS_LABELS.resource
  const { value } = item
  let problem = problemOf('resource', item)
  const connector = getConnector(value.type)
  if (!connector) return problem('invalid_definition', `Unknown resource type "${value.type}"`)
  let [resource] = await db.select().from(resources).where(eq(resources.slug, item.slug))
  if (resource) {
    problem = problemOf('resource', item, resource.id)
    if (!resource.gitProtected || resource.systemKind) {
      return problem(
        'not_protected',
        `A ${label} "${item.slug}" exists on the instance and isn't protected: protect it there to deploy it from Git`,
      )
    }
    if (resource.type !== value.type) {
      return problem(
        'invalid_definition',
        `${label} "${item.slug}" is a ${resource.type} resource on the instance, and its type can't change: make a new one`,
      )
    }
  }

  const envs = await db.select({ id: environments.id, slug: environments.slug }).from(environments)
  const rows = resource
    ? await db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, resource.id))
    : []
  const next = new Map<string, Record<string, unknown>>()
  for (const env of envs) {
    const config = value.environments[env.slug]?.config
    if (config === undefined) continue
    const parsed = connector.configSchema.safeParse(config)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
        .join('; ')
      return problem('invalid_definition', `${env.slug}: ${issues}`)
    }
    const row = rows.find((r) => r.environmentId === env.id)
    const effective = connector.configSchema.safeParse(
      applyOverrides(parsed.data as Record<string, unknown>, row?.overrides ?? {}),
    )
    if (!effective.success) {
      return problem(
        'override_conflict',
        `${env.slug}: this instance's overrides (${Object.keys(row!.overrides).join(', ')}) don't fit the new settings: change them here first`,
      )
    }
    if (!opts.serverIdentity && serverIdentityTarget(effective.data, value.type)) {
      return problem(
        'server_identity',
        `${env.slug}: uses this server's own Google identity, which this instance doesn't allow (GOOGLE_SERVER_IDENTITY)`,
      )
    }
    next.set(env.id, parsed.data as Record<string, unknown>)
  }

  let created = false
  let changed = false
  await db.transaction(async (tx) => {
    if (!resource) {
      const [inserted] = await tx
        .insert(resources)
        .values({
          slug: item.slug,
          name: value.name,
          description: value.description,
          type: value.type,
          gitProtected: true,
        })
        .onConflictDoNothing()
        .returning()
      if (!inserted) return
      resource = inserted
      created = true
    } else if (resource.name !== value.name || (resource.description ?? null) !== value.description) {
      await tx
        .update(resources)
        .set({ name: value.name, description: value.description, updatedAt: new Date() })
        .where(eq(resources.id, resource.id))
      changed = true
    }
    for (const env of envs) {
      const row = rows.find((r) => r.environmentId === env.id)
      const config = next.get(env.id)
      if (!config) {
        if (row) {
          await tx.delete(resourceConfigs).where(eq(resourceConfigs.id, row.id))
          changed = true
        }
      } else if (!row) {
        await tx.insert(resourceConfigs).values({ resourceId: resource.id, environmentId: env.id, config })
        changed = true
      } else if (canonicalJson(row.config) !== canonicalJson(config)) {
        const before = authFingerprint(applyOverrides(row.config, row.overrides))
        if (before !== null && before !== authFingerprint(applyOverrides(config, row.overrides))) {
          await deleteTokens(tx, row.id)
        }
        await tx
          .update(resourceConfigs)
          .set({ config, updatedBy: null, updatedAt: new Date() })
          .where(eq(resourceConfigs.id, row.id))
        changed = true
      }
    }
  })
  if (!resource) return problem('slug_taken', `A ${label} "${item.slug}" was just created on the instance`)
  if (created || changed) {
    await recordAudit(db, {
      actorUserId: null,
      action: created ? 'resource.created' : 'resource.updated',
      objectType: 'resource',
      objectId: resource.id,
      metadata: { slug: item.slug, source: 'git', commit: git.commit },
    })
  }
  return {
    kind: 'resource',
    slug: item.slug,
    outcome: created ? 'created' : changed ? 'updated' : 'unchanged',
    objectId: resource.id,
    treeSha: item.treeSha,
  }
}
