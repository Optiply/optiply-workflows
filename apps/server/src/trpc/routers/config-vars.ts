import { configVars, configVarValues, environments } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { encryptForRow } from '../../services/secrets'
import { uniqueOr } from '../errors'
import { adminProcedure, authedProcedure, router } from '../init'

const Id = z.string().uuid()
/** Referenced as `{{ configVars.NAME }}`, so it must be a JS identifier. */
const Name = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Use letters, digits and underscores, not starting with a digit')
const Description = z.string().trim().max(500).nullish()

export const configVarsRouter = router({
  /** Every var with its value per environment. Secret values come back only as `{ set: true }`. */
  list: authedProcedure.query(async ({ ctx }) => {
    const [vars, values] = await Promise.all([
      ctx.db.select().from(configVars).orderBy(asc(configVars.name)),
      ctx.db.select().from(configVarValues),
    ])
    return vars.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      isSecret: v.isSecret,
      values: Object.fromEntries(
        values
          .filter((x) => x.configVarId === v.id)
          .map((x) => [x.environmentId, v.isSecret ? { set: true as const } : { value: x.value ?? '' }]),
      ) as Record<string, { set: true } | { value: string }>,
    }))
  }),

  /** Whether a var is secret is fixed at creation: flipping it would expose or strand stored values. */
  create: adminProcedure
    .input(z.object({ name: Name, description: Description, isSecret: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const [created] = await uniqueOr('A config var with that name already exists', () =>
        ctx.db
          .insert(configVars)
          .values({ name: input.name, description: input.description ?? null, isSecret: input.isSecret })
          .returning(),
      )
      await ctx.audit({
        action: 'config_var.created',
        objectType: 'config_var',
        objectId: created!.id,
        metadata: { name: input.name, isSecret: input.isSecret },
      })
      return created!
    }),

  update: adminProcedure
    .input(z.object({ id: Id, description: Description }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(configVars)
        .set({ description: input.description ?? null })
        .where(eq(configVars.id, input.id))
    }),

  delete: adminProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const [deleted] = await ctx.db.delete(configVars).where(eq(configVars.id, input.id)).returning()
    if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Config var not found' })
    await ctx.audit({
      action: 'config_var.deleted',
      objectType: 'config_var',
      objectId: input.id,
      metadata: { name: deleted.name },
    })
  }),

  /** Sets one environment's value, or removes it with `value: null`. Secret values are encrypted. */
  setValue: adminProcedure
    .input(z.object({ configVarId: Id, environmentId: Id, value: z.string().max(10_000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const [variable] = await ctx.db.select().from(configVars).where(eq(configVars.id, input.configVarId))
      if (!variable) throw new TRPCError({ code: 'NOT_FOUND', message: 'Config var not found' })
      const [env] = await ctx.db
        .select({ slug: environments.slug })
        .from(environments)
        .where(eq(environments.id, input.environmentId))
      if (!env) throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' })

      const where = and(
        eq(configVarValues.configVarId, variable.id),
        eq(configVarValues.environmentId, input.environmentId),
      )
      const [existing] = await ctx.db.select({ id: configVarValues.id }).from(configVarValues).where(where)
      if (input.value === null) {
        await ctx.db.delete(configVarValues).where(where)
      } else {
        const row = { id: existing?.id ?? uuidv7(), environmentId: input.environmentId }
        const values = variable.isSecret
          ? {
              value: null,
              valueEncrypted: encryptForRow(ctx.config.keyring, 'config_var_values', row, input.value),
            }
          : { value: input.value, valueEncrypted: null }
        if (existing) {
          await ctx.db
            .update(configVarValues)
            .set({ ...values, updatedBy: ctx.user.id })
            .where(eq(configVarValues.id, existing.id))
        } else {
          await ctx.db
            .insert(configVarValues)
            .values({ ...row, configVarId: variable.id, ...values, updatedBy: ctx.user.id })
        }
      }
      await ctx.audit({
        action: input.value === null ? 'config_var.value_removed' : 'config_var.value_set',
        objectType: 'config_var',
        objectId: variable.id,
        environmentId: input.environmentId,
        metadata: { name: variable.name, environment: env.slug },
      })
    }),
})
