import { MAX_JS_PACKAGE_LENGTH, MAX_JS_PACKAGES } from '@ow/definition'
import { z } from 'zod'
import { jsBundleConfig, jsBundleState, stateOf } from '../../services/js-bundles'
import { buildAudited } from '../../services/js-modules'
import { requireLevel } from '../../services/permissions'
import { authedProcedure, type Context, router } from '../init'
import { visibleApp } from './apps'
import { visibleWorkflow } from './workflows'

/**
 * A workflow's or app's JavaScript packages for the editor (docs/architecture.md, JS packages): their bundle's
 * state (installed: versions, size, Node built-ins some package reaches for; failed: npm's or esbuild's reason; or
 * not yet), and installing them now so the next run or preview doesn't wait. The editor sends what its field holds,
 * saved or not. For people who can edit the workflow or app.
 */

const targetInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow'), id: z.string().uuid() }),
  z.object({ kind: z.literal('app'), id: z.string().uuid() }),
])
const input = z.object({
  target: targetInput,
  packages: z.array(z.string().max(MAX_JS_PACKAGE_LENGTH)).max(MAX_JS_PACKAGES),
})
const installInput = input.extend({ retry: z.boolean().optional() })

type AuthedContext = Context & { user: NonNullable<Context['user']> }

/** The workflow or app, which the caller must be able to edit: its type and id for the audit. */
async function editable(ctx: AuthedContext, target: z.infer<typeof targetInput>) {
  if (target.kind === 'workflow') {
    const { access, workflow } = await visibleWorkflow(ctx, target.id)
    requireLevel(access.workflowLevel(workflow), 'edit', 'this workflow')
    return { objectType: 'workflow' as const, objectId: workflow.id }
  }
  const { access, app } = await visibleApp(ctx, { id: target.id })
  requireLevel(access.appLevel(app), 'edit', 'this app')
  return { objectType: 'app' as const, objectId: app.id }
}

export const jsPackagesRouter = router({
  state: authedProcedure.input(input).query(async ({ ctx, input }) => {
    await editable(ctx, input.target)
    return jsBundleState(ctx.db, jsBundleConfig(ctx.config), input.packages)
  }),

  /**
   * Installs and bundles the packages now; the answer is the new state (`bundleHash` when ready: the app editor's
   * preview loads `/api/js-bundles/<hash>.js`). A new bundle is audited. A mutation, as it may run npm: `retry: false`
   * (the app editor asking on its own) answers a failure from a moment ago instead of trying again.
   */
  install: authedProcedure.input(installInput).mutation(async ({ ctx, input }) => {
    const object = await editable(ctx, input.target)
    const who = { ...object, actorUserId: ctx.user.id }
    const retry = input.retry ?? true
    return stateOf(await buildAudited(ctx.db, input.packages, who, null, jsBundleConfig(ctx.config), retry))
  }),
})
