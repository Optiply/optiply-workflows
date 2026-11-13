import { generateAccessToken } from '@ow/crypto'
import { ACCESS_TOKEN_SCOPES, personalAccessTokens, users } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { authedProcedure, router } from '../init'

/**
 * Personal access tokens (M33, docs/architecture.md §2.36): a user makes their own for the components CLI; each acts
 * as them, within its scopes. A token is shown once; only its sha256 is kept. Admins see and revoke everyone's.
 * Tokens can't manage tokens (outside every scope).
 */
const Id = z.string().uuid()

export const accessTokensRouter = router({
  /** The caller's tokens; with `everyone` (admins), every user's, with whose they are. */
  list: authedProcedure
    .input(z.object({ everyone: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const everyone = !!input?.everyone
      if (everyone && !ctx.user.isAdmin) throw new TRPCError({ code: 'FORBIDDEN', message: 'Admins only' })
      const rows = await ctx.db
        .select({
          id: personalAccessTokens.id,
          name: personalAccessTokens.name,
          prefix: personalAccessTokens.prefix,
          scopes: personalAccessTokens.scopes,
          expiresAt: personalAccessTokens.expiresAt,
          revokedAt: personalAccessTokens.revokedAt,
          lastUsedAt: personalAccessTokens.lastUsedAt,
          createdAt: personalAccessTokens.createdAt,
          userId: personalAccessTokens.userId,
          userEmail: users.email,
        })
        .from(personalAccessTokens)
        .innerJoin(users, eq(users.id, personalAccessTokens.userId))
        .where(everyone ? undefined : eq(personalAccessTokens.userId, ctx.user.id))
        .orderBy(desc(personalAccessTokens.createdAt))
      return rows
    }),

  /** A new token for the caller: its value comes back this once. */
  create: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(ACCESS_TOKEN_SCOPES)).min(1),
        expiresAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.expiresAt && input.expiresAt <= new Date()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The expiry must be in the future' })
      }
      const { key, prefix, hash } = generateAccessToken()
      const [created] = await ctx.db
        .insert(personalAccessTokens)
        .values({
          userId: ctx.user.id,
          name: input.name,
          prefix,
          hash,
          scopes: [...new Set(input.scopes)],
          expiresAt: input.expiresAt,
        })
        .returning({ id: personalAccessTokens.id })
      await ctx.audit({
        action: 'access_token.created',
        objectType: 'access_token',
        objectId: created!.id,
        metadata: {
          name: input.name,
          prefix,
          scopes: input.scopes,
          expiresAt: input.expiresAt?.toISOString() ?? null,
        },
      })
      return { id: created!.id, name: input.name, token: key }
    }),

  /** Revokes one of the caller's tokens (an admin's: anyone's). Calls with it answer 401 at once. */
  revoke: authedProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, input.id))
    if (!row || (row.userId !== ctx.user.id && !ctx.user.isAdmin)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such access token' })
    }
    await ctx.db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(personalAccessTokens.id, input.id), isNull(personalAccessTokens.revokedAt)))
    await ctx.audit({
      action: 'access_token.revoked',
      objectType: 'access_token',
      objectId: input.id,
      metadata: {
        name: row.name,
        prefix: row.prefix,
        ...(row.userId !== ctx.user.id && { ownerId: row.userId }),
      },
    })
    return { ok: true }
  }),
})
