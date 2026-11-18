import { environments, GIT_HOSTS, GIT_OBJECT_KINDS, GIT_SETTINGS_KINDS } from '@ow/db'
import { folderPathSchema } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { gitDeployStatus, requestGitDeploy } from '../../services/git/deploy'
import { gitHealth } from '../../services/git/health'
import { GitHostError, openGitHost } from '../../services/git/hosts'
import { gitObjectLevel, kindTitle, loadGitObject } from '../../services/git/kinds'
import { objectBranches } from '../../services/git/object-branches'
import { openPromotion } from '../../services/git/promotion'
import {
  gitTrpcError,
  openPullRequestFor,
  protectObject,
  requireGitRepo,
  unprotectObject,
} from '../../services/git/protection'
import { branchNameSchema } from '../../services/git/repo'
import {
  clearGitSettings,
  gitSettingsView,
  loadGitSettings,
  repoWebUrl,
  saveGitSettings,
  setNotifyWorkflow,
  testGitConnection,
} from '../../services/git/settings'
import {
  commitSettings,
  loadSettingsRow,
  protectSettings,
  type SettingsRow,
  settingsChanges,
  unprotectSettings,
} from '../../services/git/settings-objects'
import { loadAccess, requireLevel, requireNoAdminOnlySettings } from '../../services/permissions'
import { adminProcedure, authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
const Kind = z.enum(GIT_OBJECT_KINDS)
const SettingsKind = z.enum(GIT_SETTINGS_KINDS)
/** The form's edits for Save to branch (`SettingsEdit`): resources' fields and configs, config vars' values. */
const SettingsEditInput = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullish(),
  folder: folderPathSchema.nullish(),
  configs: z.record(Id, z.unknown()).optional(),
  values: z.record(Id, z.string().max(10_000).nullable()).optional(),
})

/**
 * A resource or config var to protect or unprotect: a resource needs Own in every environment (its settings are
 * every environment's), a config var an admin (config vars have no grants).
 */
async function settingsRow(
  ctx: Context & { user: NonNullable<Context['user']> },
  kind: (typeof GIT_SETTINGS_KINDS)[number],
  id: string,
  action: string,
  required: 'own' | 'edit' = 'own',
): Promise<SettingsRow> {
  const row = await loadSettingsRow(ctx.db, kind, id)
  const what = kind === 'resource' ? 'Resource' : 'Config var'
  if (kind === 'config_var') {
    if (!ctx.user.isAdmin)
      throw new TRPCError({ code: 'FORBIDDEN', message: `Only admins can ${action} config vars` })
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `${what} not found` })
    return row
  }
  const access = await loadAccess(ctx.db, ctx.user)
  const envIds = (await ctx.db.select({ id: environments.id }).from(environments)).map((e) => e.id)
  const resource = row as Parameters<typeof access.levelEverywhere>[0] | null
  // Seen in any environment, it exists for them; its settings are every environment's, so it takes Own in all.
  if (!resource || !envIds.some((e) => access.level(resource, e))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `${what} not found` })
  }
  requireLevel(
    access.levelEverywhere(resource, envIds),
    required,
    `this resource in every environment to ${action} it`,
  )
  await requireNoAdminOnlySettings(ctx.db, access, resource.id, action)
  return resource as SettingsRow
}

/** The workflow, app, library query or module and the caller's level on it; ones they can't see are NOT_FOUND. */
async function gitObject(
  ctx: Context & { user: NonNullable<Context['user']> },
  kind: (typeof GIT_OBJECT_KINDS)[number],
  id: string,
) {
  const access = await loadAccess(ctx.db, ctx.user)
  const object = await loadGitObject(ctx.db, kind, { id })
  const level = object ? gitObjectLevel(access, kind, object) : null
  if (!object || !level) throw new TRPCError({ code: 'NOT_FOUND', message: `${kindTitle(kind)} not found` })
  return { object, level }
}

/** A GitHub token or webhook secret: a string sets it, null clears it, missing keeps it. */
const Secret = z.string().trim().min(1).max(1000).nullish()

export const gitRouter = router({
  /**
   * For everyone: whether Git sync is set up, its deploy branch, the repo's web address for links, and its host (M31:
   * the UI says "merge request" for GitLab).
   */
  info: authedProcedure.query(async ({ ctx }) => {
    const loaded = await loadGitSettings(ctx.db, ctx.config.keyring)
    return loaded
      ? {
          configured: true,
          branch: loaded.row.branch,
          webUrl: repoWebUrl(loaded.row.repoUrl),
          host: loaded.row.host,
        }
      : { configured: false, branch: null, webUrl: null, host: 'github' as const }
  }),

  /** The repo settings; the token and webhook secret only as `{ set }`. */
  settings: adminProcedure.query(({ ctx }) => gitSettingsView(ctx.db, ctx.config.keyring)),

  saveSettings: adminProcedure
    .input(
      z.object({
        repoUrl: z.string().trim().min(1).max(500),
        branch: branchNameSchema.default('main'),
        /** M31: undefined detects it from the URL. */
        host: z.enum(GIT_HOSTS).optional(),
        apiUrl: z.string().trim().max(500).nullish(),
        githubAuth: z.enum(['token', 'app']).optional(),
        githubAppId: z.string().trim().max(20).nullish(),
        appPrivateKey: z.string().max(10_000).nullish(),
        token: Secret,
        webhookSecret: Secret,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const changed = await saveGitSettings(ctx.db, ctx.config, ctx.user, {
        repoUrl: input.repoUrl,
        branch: input.branch,
        host: input.host,
        apiUrl: input.apiUrl,
        githubAuth: input.githubAuth,
        githubAppId: input.githubAppId,
        appPrivateKey: input.appPrivateKey,
        // `nullish` gives undefined (keep) or null (clear); zod keeps the difference.
        token: input.token,
        webhookSecret: input.webhookSecret,
      })
      const view = await gitSettingsView(ctx.db, ctx.config.keyring)
      await ctx.audit({
        action: 'git.settings_updated',
        objectType: 'git_settings',
        // Key names with "token" or "secret" are redacted in audit metadata, so the changes are listed as values.
        metadata: {
          repoUrl: view.repoUrl,
          branch: view.branch,
          host: view.host,
          githubAuth: view.githubAuth,
          changed: [
            ...(changed.tokenChanged ? ['token'] : []),
            ...(changed.webhookSecretChanged ? ['webhook'] : []),
            ...(changed.appKeyChanged ? ['app key'] : []),
          ],
        },
      })
      return view
    }),

  clearSettings: adminProcedure.mutation(async ({ ctx }) => {
    if (await clearGitSettings(ctx.db)) {
      await ctx.audit({ action: 'git.settings_cleared', objectType: 'git_settings' })
    }
    return gitSettingsView(ctx.db, ctx.config.keyring)
  }),

  /** Signs in to the repo and reads the deploy branch; changes nothing. */
  testConnection: adminProcedure.mutation(({ ctx }) => testGitConnection(ctx.db, ctx.config)),

  /** What the last deploys did, and each workflow and app directory's state. */
  status: adminProcedure.query(({ ctx }) => gitDeployStatus(ctx.db)),

  /** The problems keeping objects from deploying, for the admin banner (M22). */
  health: adminProcedure.query(({ ctx }) => gitHealth(ctx.db)),

  /** The workflow run when a deploy's problems change (M22); null for none. */
  setNotifyWorkflow: adminProcedure
    .input(z.object({ workflowId: Id.nullable() }))
    .mutation(async ({ ctx, input }) => {
      await setNotifyWorkflow(ctx.db, input.workflowId)
      await ctx.audit({
        action: 'git.notify_workflow_set',
        objectType: 'git_settings',
        metadata: { workflowId: input.workflowId },
      })
      return gitSettingsView(ctx.db, ctx.config.keyring)
    }),

  /**
   * Deploys the branch now, re-checking every directory (after creating a resource a deploy was missing, say).
   * When another process is deploying, it goes again right after (`busy`).
   */
  deployNow: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.audit({ action: 'git.deploy_requested', objectType: 'git_settings' })
    return requestGitDeploy(ctx.db, ctx.config, { trigger: 'manual', force: true })
  }),

  /**
   * Protects a workflow or app (Own): from now on it's edited on Git branches and deployed from the repo. Its live
   * release (or draft) goes onto a branch (`protect/<kind>-<slug>` by default) and a pull request adds it; without
   * one (not GitHub, no token) the branch is there to open one by hand.
   */
  protect: authedProcedure
    .input(z.object({ kind: Kind, id: Id, branch: branchNameSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const { object, level } = await gitObject(ctx, input.kind, input.id)
      requireLevel(level, 'own', `this ${input.kind} to protect it`)
      const result = await protectObject(ctx.db, ctx.config, ctx.user, {
        kind: input.kind,
        object,
        branch: input.branch,
      })
      await ctx.audit({
        action: `${input.kind}.protected`,
        objectType: input.kind,
        objectId: object.id,
        metadata: {
          branch: result.branch,
          commit: result.commit,
          pullRequest: result.pullRequest?.number ?? null,
        },
      })
      return result
    }),

  /** Lets an object be edited on the instance again (Own). Its directory stays in the repo and stops deploying. */
  unprotect: authedProcedure.input(z.object({ kind: Kind, id: Id })).mutation(async ({ ctx, input }) => {
    const { object, level } = await gitObject(ctx, input.kind, input.id)
    requireLevel(level, 'own', `this ${input.kind} to unprotect it`)
    await unprotectObject(ctx.db, input.kind, object)
    await ctx.audit({ action: `${input.kind}.unprotected`, objectType: input.kind, objectId: object.id })
    return { ok: true }
  }),

  /**
   * Protects a resource or config var (M22): its settings (never secrets) go onto a branch and a pull request adds
   * them; from then on they change through Git, while secrets, overrides and local values stay the instance's.
   */
  protectSettings: authedProcedure
    .input(z.object({ kind: SettingsKind, id: Id, branch: branchNameSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const row = await settingsRow(ctx, input.kind, input.id, 'protect')
      const result = await protectSettings(ctx.db, ctx.config, ctx.user, {
        kind: input.kind,
        row,
        branch: input.branch,
      })
      await ctx.audit({
        action: `${input.kind}.protected`,
        objectType: input.kind,
        objectId: row.id,
        metadata: {
          branch: result.branch,
          commit: result.commit,
          pullRequest: result.pullRequest?.number ?? null,
        },
      })
      return result
    }),

  /** Lets a resource or config var change on the instance again. Its directory stays in the repo. */
  unprotectSettings: authedProcedure
    .input(z.object({ kind: SettingsKind, id: Id }))
    .mutation(async ({ ctx, input }) => {
      const row = await settingsRow(ctx, input.kind, input.id, 'unprotect')
      await unprotectSettings(ctx.db, input.kind, row)
      await ctx.audit({ action: `${input.kind}.unprotected`, objectType: input.kind, objectId: row.id })
      return { ok: true }
    }),

  /**
   * Save to branch (M22), first step: what committing a protected resource's or config var's edited settings onto
   * the branch would change, and the commit that's against (`base`, passed back to `commitSettings`).
   */
  settingsChanges: authedProcedure
    .input(z.object({ kind: SettingsKind, id: Id, branch: branchNameSchema, edit: SettingsEditInput }))
    .query(async ({ ctx, input }) => {
      const row = await settingsRow(ctx, input.kind, input.id, 'change', 'edit')
      return settingsChanges(ctx.db, ctx.config, {
        kind: input.kind,
        row,
        branch: input.branch,
        edit: input.edit,
      })
    }),

  /**
   * Save to branch: commits the edited settings onto the branch (made from the deploy branch when new) as the person.
   * CONFLICT when the branch changed them since `base`; opening the pull request is `openPullRequest`.
   */
  commitSettings: authedProcedure
    .input(
      z.object({
        kind: SettingsKind,
        id: Id,
        branch: branchNameSchema,
        base: z.string().regex(/^[0-9a-f]{40}$/),
        edit: SettingsEditInput,
        message: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await settingsRow(ctx, input.kind, input.id, 'change', 'edit')
      const result = await commitSettings(ctx.db, ctx.config, ctx.user, { ...input, row })
      await ctx.audit({
        action: `${input.kind}.committed`,
        objectType: input.kind,
        objectId: row.id,
        metadata: { branch: result.branch, commit: result.commit },
      })
      return result
    }),

  /**
   * The repo's branches, the deploy branch first. For an object (M22), the branches that change it or hold its draft
   * here come next, marked (`changes`, `draft`).
   */
  branches: authedProcedure
    .input(z.object({ kind: Kind, id: Id }).optional())
    .query(async ({ ctx, input }) => {
      if (input) {
        const { object } = await gitObject(ctx, input.kind, input.id)
        return objectBranches(ctx.db, ctx.config, { kind: input.kind, object })
      }
      const { repo, branch } = await requireGitRepo(ctx.db, ctx.config)
      try {
        const heads = await repo.listBranches()
        return [...heads]
          .map(([name, commit]) => ({ name, commit, deploy: name === branch, changes: false, draft: false }))
          .sort(
            (a, b) => Number(b.deploy) - Number(a.deploy) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          )
      } catch (err) {
        throw gitTrpcError(err)
      }
    }),

  /** The branch's pull request into the deploy branch (open ones first), or null. */
  pullRequest: authedProcedure.input(z.object({ branch: branchNameSchema })).query(async ({ ctx, input }) => {
    const opened = await openGitHost(ctx.db, ctx.config)
    if ('error' in opened) return { pullRequest: null, error: opened.error }
    try {
      return { pullRequest: await opened.host.findChangeRequest(input.branch, opened.branch), error: null }
    } catch (err) {
      if (err instanceof GitHostError) return { pullRequest: null, error: err.message }
      throw err
    }
  }),

  /**
   * Promote (M22): a pull request from this instance's deploy branch into another branch, or the one already open;
   * `up_to_date` when that branch already has everything.
   */
  openPromotion: adminProcedure
    .input(
      z.object({
        target: branchNameSchema,
        title: z.string().trim().min(1).max(250).optional(),
        body: z.string().max(10_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await openPromotion(ctx.db, ctx.config, input)
      if (result.status === 'opened' && result.pullRequest) {
        await ctx.audit({
          action: 'git.promotion_opened',
          objectType: 'git_settings',
          metadata: { target: input.target, number: result.pullRequest.number },
        })
      }
      return result
    }),

  /** Opens a pull request from the branch into the deploy branch, or returns the one already open. */
  openPullRequest: authedProcedure
    .input(
      z.object({
        branch: branchNameSchema,
        title: z.string().trim().min(1).max(250),
        body: z.string().max(10_000).default(''),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireGitRepo(ctx.db, ctx.config)
      const result = await openPullRequestFor(ctx.db, ctx.config, input)
      if (result.pullRequest) {
        await ctx.audit({
          action: 'git.pull_request_opened',
          objectType: 'git_settings',
          metadata: { branch: input.branch, number: result.pullRequest.number },
        })
      }
      return result
    }),
})
