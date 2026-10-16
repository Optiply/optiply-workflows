import { apps, workflows } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { gitDeployStatus, requestGitDeploy } from '../../services/git/deploy'
import { GitHubError, openGitHub } from '../../services/git/github'
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
  saveGitSettings,
  testGitConnection,
} from '../../services/git/settings'
import { loadAccess, requireLevel } from '../../services/permissions'
import { adminProcedure, authedProcedure, type Context, router } from '../init'

const Id = z.string().uuid()
const Kind = z.enum(['workflow', 'app'])

/** The workflow or app and the caller's level on it; ones they can't see are NOT_FOUND. */
async function gitObject(
  ctx: Context & { user: NonNullable<Context['user']> },
  kind: 'workflow' | 'app',
  id: string,
) {
  const access = await loadAccess(ctx.db, ctx.user)
  if (kind === 'workflow') {
    const [object] = await ctx.db.select().from(workflows).where(eq(workflows.id, id))
    const level = object ? access.workflowLevel(object) : null
    if (!object || !level) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found' })
    return { object, level }
  }
  const [object] = await ctx.db.select().from(apps).where(eq(apps.id, id))
  const level = object ? access.appLevel(object) : null
  if (!object || !level) throw new TRPCError({ code: 'NOT_FOUND', message: 'App not found' })
  return { object, level }
}

/** A GitHub token or webhook secret: a string sets it, null clears it, missing keeps it. */
const Secret = z.string().trim().min(1).max(1000).nullish()

export const gitRouter = router({
  /** The repo settings; the token and webhook secret only as `{ set }`. */
  settings: adminProcedure.query(({ ctx }) => gitSettingsView(ctx.db, ctx.config.keyring)),

  saveSettings: adminProcedure
    .input(
      z.object({
        repoUrl: z.string().trim().min(1).max(500),
        branch: branchNameSchema.default('main'),
        token: Secret,
        webhookSecret: Secret,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const changed = await saveGitSettings(ctx.db, ctx.config, ctx.user, {
        repoUrl: input.repoUrl,
        branch: input.branch,
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
          changed: [
            ...(changed.tokenChanged ? ['token'] : []),
            ...(changed.webhookSecretChanged ? ['webhook'] : []),
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

  /** The repo's branches, the deploy branch first. */
  branches: authedProcedure.query(async ({ ctx }) => {
    const { repo, branch } = await requireGitRepo(ctx.db, ctx.config)
    try {
      const heads = await repo.listBranches()
      return [...heads]
        .map(([name, commit]) => ({ name, commit, deploy: name === branch }))
        .sort(
          (a, b) => Number(b.deploy) - Number(a.deploy) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        )
    } catch (err) {
      throw gitTrpcError(err)
    }
  }),

  /** The branch's pull request into the deploy branch (open ones first), or null. */
  pullRequest: authedProcedure.input(z.object({ branch: branchNameSchema })).query(async ({ ctx, input }) => {
    const opened = await openGitHub(ctx.db, ctx.config)
    if ('error' in opened) return { pullRequest: null, error: opened.error }
    try {
      return { pullRequest: await opened.github.findPullRequest(input.branch, opened.branch), error: null }
    } catch (err) {
      if (err instanceof GitHubError) return { pullRequest: null, error: err.message }
      throw err
    }
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
