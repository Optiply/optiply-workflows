import { generateApiKey } from '@ow/crypto'
import { type ApiKey, apiKeys, environments, users, workflows } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { adminProcedure, router } from '../init'

const Id = z.string().uuid()

const view = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  workflowIds: k.workflowIds,
  environmentIds: k.environmentIds,
  expiresAt: k.expiresAt,
  revokedAt: k.revokedAt,
  lastUsedAt: k.lastUsedAt,
  createdBy: k.createdBy,
  createdAt: k.createdAt,
})

/**
 * API keys for calling webhooks from other systems. Admins only. A key is shown once, when it's created; after that
 * only its prefix is. Keys are revoked rather than deleted, so runs keep pointing at the key that started them.
 */
export const apiKeysRouter = router({
  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ key: apiKeys, author: { name: users.name, email: users.email } })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.createdBy))
      .orderBy(desc(apiKeys.createdAt))
    return rows.map(({ key, author }) => ({ ...view(key), author }))
  }),

  /** `workflowIds` / `environmentIds` limit the key; leave them out (or null) for all. */
  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        workflowIds: z.array(Id).min(1).max(500).nullish(),
        environmentIds: z.array(Id).min(1).max(50).nullish(),
        expiresAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.expiresAt && input.expiresAt <= new Date()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The expiry date must be in the future' })
      }
      if (input.workflowIds) {
        const found = await ctx.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(inArray(workflows.id, input.workflowIds))
        if (found.length !== new Set(input.workflowIds).size) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Some of those workflows don’t exist' })
        }
      }
      if (input.environmentIds) {
        const found = await ctx.db
          .select({ id: environments.id })
          .from(environments)
          .where(inArray(environments.id, input.environmentIds))
        if (found.length !== new Set(input.environmentIds).size) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Some of those environments don’t exist' })
        }
      }
      const generated = generateApiKey()
      const [row] = await ctx.db
        .insert(apiKeys)
        .values({
          name: input.name,
          prefix: generated.prefix,
          hash: generated.hash,
          workflowIds: input.workflowIds ?? null,
          environmentIds: input.environmentIds ?? null,
          expiresAt: input.expiresAt ?? null,
          createdBy: ctx.user.id,
        })
        .returning()
      await ctx.audit({
        action: 'api_key.created',
        objectType: 'api_key',
        objectId: row!.id,
        metadata: { name: row!.name, prefix: row!.prefix },
      })
      return { ...view(row!), key: generated.key }
    }),

  revoke: adminProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, input.id))
      .returning()
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'API key not found' })
    await ctx.audit({
      action: 'api_key.revoked',
      objectType: 'api_key',
      objectId: row.id,
      metadata: { name: row.name, prefix: row.prefix },
    })
    return view(row)
  }),
})
