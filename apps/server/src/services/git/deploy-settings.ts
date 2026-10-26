import { configVars, configVarValues, type Db, environments } from '@ow/db'
import { type ConfigVarObject, SETTINGS_LABELS, type SettingsKind, settingsDir } from '@ow/git-format'
import { and, eq } from 'drizzle-orm'
import { recordAudit } from '../../audit'
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
