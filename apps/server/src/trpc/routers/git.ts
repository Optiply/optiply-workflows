import { z } from 'zod'
import { gitDeployStatus, requestGitDeploy } from '../../services/git/deploy'
import { branchNameSchema } from '../../services/git/repo'
import {
  clearGitSettings,
  gitSettingsView,
  saveGitSettings,
  testGitConnection,
} from '../../services/git/settings'
import { adminProcedure, router } from '../init'

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
})
