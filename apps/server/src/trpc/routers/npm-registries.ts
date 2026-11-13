import { configVars, type Db, npmRegistries } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { defaultEnvSecret } from '../../services/default-env-secrets'
import { uniqueOr } from '../errors'
import { adminProcedure, authedProcedure, router } from '../init'

/**
 * npm registries for component libraries' builds (M33, docs/architecture.md §2.36): admins define one per scope
 * (`@acme`) or one for every other package (instead of NPM_REGISTRY_URL). The token is a secret config var's name,
 * read in the default environment by the build; it never comes back here.
 */
const Id = z.string().uuid()
/** npm's scope syntax: `@` and a lowercase name. */
const Scope = z
  .string()
  .trim()
  .regex(/^@[a-z0-9][a-z0-9._~-]{0,213}$/, 'A scope is @ and a lowercase name, e.g. @acme')
  .nullable()
const Fields = z.object({
  scope: Scope,
  url: z.string().trim().max(2048),
  tokenConfigVar: z.string().trim().max(200).nullish(),
})
type FieldsInput = z.infer<typeof Fields>

async function checked(db: Db, insecureOk: boolean, input: FieldsInput) {
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'The registry URL isn’t a URL' })
  }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && insecureOk)
  if (!allowed || url.username || url.password || url.search || url.hash) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `An https URL without credentials, query or fragment${insecureOk ? ' (http allowed here)' : ''}`,
    })
  }
  const tokenConfigVar = input.tokenConfigVar || null
  if (tokenConfigVar) {
    const [row] = await db
      .select({ isSecret: configVars.isSecret })
      .from(configVars)
      .where(eq(configVars.name, tokenConfigVar))
    if (!row?.isSecret) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `The token must be a secret config var: ${tokenConfigVar} isn't one`,
      })
    }
  }
  // Always ending in /: npm's auth key and `new URL('-/whoami', url)` keep the registry's whole path then.
  return { scope: input.scope, url: url.toString().replace(/\/*$/, '/'), tokenConfigVar }
}

export const npmRegistriesRouter = router({
  /** Every registry (a library's editors see which scopes have one); the token's var for admins only. */
  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(npmRegistries).orderBy(asc(npmRegistries.scope))
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      url: r.url,
      withToken: !!r.tokenConfigVar,
      ...(ctx.user.isAdmin && { tokenConfigVar: r.tokenConfigVar }),
    }))
  }),

  create: adminProcedure.input(Fields).mutation(async ({ ctx, input }) => {
    const fields = await checked(ctx.db, ctx.config.NPM_ALLOW_INSECURE_REGISTRIES, input)
    const [created] = await uniqueOr(
      fields.scope
        ? `There's a registry for ${fields.scope} already`
        : "There's a registry for all packages already",
      () => ctx.db.insert(npmRegistries).values(fields).returning({ id: npmRegistries.id }),
    )
    await ctx.audit({
      action: 'npm_registry.created',
      objectType: 'npm_registry',
      objectId: created!.id,
      metadata: { scope: fields.scope, url: fields.url, withToken: !!fields.tokenConfigVar },
    })
    return { id: created!.id }
  }),

  update: adminProcedure.input(Fields.extend({ id: Id })).mutation(async ({ ctx, input }) => {
    const fields = await checked(ctx.db, ctx.config.NPM_ALLOW_INSECURE_REGISTRIES, input)
    const [updated] = await uniqueOr(
      fields.scope
        ? `There's a registry for ${fields.scope} already`
        : "There's a registry for all packages already",
      () =>
        ctx.db
          .update(npmRegistries)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(npmRegistries.id, input.id))
          .returning({ id: npmRegistries.id }),
    )
    if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such npm registry' })
    await ctx.audit({
      action: 'npm_registry.updated',
      objectType: 'npm_registry',
      objectId: input.id,
      metadata: { scope: fields.scope, url: fields.url, withToken: !!fields.tokenConfigVar },
    })
    return { ok: true }
  }),

  delete: adminProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const [deleted] = await ctx.db
      .delete(npmRegistries)
      .where(eq(npmRegistries.id, input.id))
      .returning({ scope: npmRegistries.scope })
    if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such npm registry' })
    await ctx.audit({
      action: 'npm_registry.deleted',
      objectType: 'npm_registry',
      objectId: input.id,
      metadata: { scope: deleted.scope },
    })
    return { ok: true }
  }),

  /** Asks the registry who the token is (`/-/whoami`), for fields saved or not. */
  test: adminProcedure.input(Fields).mutation(async ({ ctx, input }) => {
    const fields = await checked(ctx.db, ctx.config.NPM_ALLOW_INSECURE_REGISTRIES, input)
    let token: string | null = null
    if (fields.tokenConfigVar) {
      token = await defaultEnvSecret(ctx.db, ctx.config.keyring, fields.tokenConfigVar)
      if (!token) {
        return {
          ok: false as const,
          message: `${fields.tokenConfigVar} has no value in the default environment`,
        }
      }
    }
    let res: Response
    try {
      res = await fetch(new URL('-/whoami', fields.url), {
        headers: { accept: 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      return { ok: false as const, message: `Couldn't reach the registry: ${(err as Error).message}` }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false as const,
        message: token ? 'The registry refused the token' : 'The registry wants a token',
      }
    }
    if (!res.ok) return { ok: false as const, message: `The registry answered ${res.status} to /-/whoami` }
    const body = (await res.json().catch(() => ({}))) as { username?: string }
    return { ok: true as const, username: body.username ?? null }
  }),
})
