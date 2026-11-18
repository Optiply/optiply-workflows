import { configVars, type Db, pythonEnvs, pythonIndexes, workflowReleases, workflows } from '@ow/db'
import { PACKAGE_NAME, PYTHON_INDEX_SLUG } from '@ow/definition'
import { BlockFailure } from '@ow/engine'
import { TRPCError } from '@trpc/server'
import { asc, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { builderIndex, pythonBuilder } from '../../services/python-envs'
import { uniqueOr } from '../errors'
import { adminProcedure, authedProcedure, router } from '../init'

/**
 * Package indexes (M32, docs/architecture.md §2.35): an admin defines them (Settings → Python), a workflow picks
 * one by its slug (`settings.python.index`). The password is a secret config var's name, read in the default
 * environment when the builder needs it: it never comes back here.
 */
const Id = z.string().uuid()
const Url = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }, 'An http(s) URL of a simple index (PEP 503), without credentials, query or fragment (e.g. https://pypi.example.com/simple)')
/**
 * A package Test looks for instead of the index's root page, saved with the index: some indexes, Google's Artifact
 * Registry among them, list nothing at their root and answer 404 there. Only Test reads it.
 */
const TestPackage = z
  .string()
  .trim()
  .max(200)
  .refine((v) => !v || PACKAGE_NAME.test(v), "A package's name (e.g. requests)")
  .nullish()

const Fields = z.object({
  name: z.string().trim().min(1).max(100),
  url: Url,
  username: z.string().trim().max(1000).nullish(),
  passwordConfigVar: z.string().trim().max(200).nullish(),
  mode: z.enum(['primary', 'extra']),
  testPackage: TestPackage,
})
type FieldsInput = z.infer<typeof Fields>

/** The fields as stored: blanks as null, the URL without a trailing slash; the password's config var checked. */
async function checked(db: Db, input: FieldsInput) {
  const username = input.username || null
  const passwordConfigVar = input.passwordConfigVar || null
  if (passwordConfigVar && !username) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A password needs a username' })
  }
  if (passwordConfigVar && !(await configVarIsSecret(db, passwordConfigVar))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The password must be a secret config var: ${passwordConfigVar} isn't one`,
    })
  }
  return {
    name: input.name,
    url: input.url.replace(/\/+$/, ''),
    username,
    passwordConfigVar,
    mode: input.mode,
    testPackage: input.testPackage || null,
  }
}

async function configVarIsSecret(db: Db, name: string): Promise<boolean> {
  const [row] = await db
    .select({ isSecret: configVars.isSecret })
    .from(configVars)
    .where(eq(configVars.name, name))
  return !!row?.isSecret
}

/** Workflows whose draft or live release names the index. */
async function workflowsUsing(db: Db, slug: string): Promise<string[]> {
  const named = (column: unknown) => sql`${column} #>> '{settings,python,index}' = ${slug}`
  const rows = await db
    .selectDistinct({ name: workflows.name })
    .from(workflows)
    .leftJoin(workflowReleases, eq(workflowReleases.id, workflows.liveReleaseId))
    .where(or(named(workflows.draftDefinition), named(workflowReleases.definition)))
    .orderBy(asc(workflows.name))
  return rows.map((r) => r.name)
}

export const pythonIndexesRouter = router({
  /** Every index (for the workflow editor's select too); the password only as whether one is configured. */
  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(pythonIndexes).orderBy(asc(pythonIndexes.name))
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      url: row.url,
      mode: row.mode,
      ...(ctx.user.isAdmin && {
        username: row.username,
        passwordConfigVar: row.passwordConfigVar,
        testPackage: row.testPackage,
      }),
      signedIn: !!row.username,
    }))
  }),

  create: adminProcedure
    .input(Fields.extend({ slug: z.string().regex(PYTHON_INDEX_SLUG, 'Lowercase letters, digits, - and _') }))
    .mutation(async ({ ctx, input }) => {
      const fields = await checked(ctx.db, input)
      const [created] = await uniqueOr('An index with that slug already exists', () =>
        ctx.db
          .insert(pythonIndexes)
          .values({ slug: input.slug, ...fields })
          .returning(),
      )
      await ctx.audit({
        action: 'python.index_created',
        objectType: 'python_index',
        objectId: created!.id,
        metadata: { slug: input.slug, url: fields.url, mode: fields.mode, signedIn: !!fields.username },
      })
      return { id: created!.id }
    }),

  /**
   * The slug stays (workflows and locks name it). Envs resolved from it are resolved again on their next run, when
   * what they install from changed (not its name or the package Test uses).
   */
  update: adminProcedure.input(Fields.extend({ id: Id })).mutation(async ({ ctx, input }) => {
    const fields = await checked(ctx.db, input)
    const [before] = await ctx.db.select().from(pythonIndexes).where(eq(pythonIndexes.id, input.id))
    if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such package index' })
    const [updated] = await ctx.db
      .update(pythonIndexes)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(pythonIndexes.id, input.id))
      .returning()
    if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such package index' })
    const installsFrom = (r: typeof fields) => [r.url, r.username, r.passwordConfigVar, r.mode].join('\n')
    if (installsFrom(before) !== installsFrom(fields)) {
      await ctx.db.delete(pythonEnvs).where(eq(pythonEnvs.indexId, input.id))
    }
    await ctx.audit({
      action: 'python.index_updated',
      objectType: 'python_index',
      objectId: input.id,
      metadata: { slug: updated.slug, url: fields.url, mode: fields.mode, signedIn: !!fields.username },
    })
    return { ok: true }
  }),

  /** Refused while a workflow's draft or live release names it. */
  delete: adminProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(pythonIndexes).where(eq(pythonIndexes.id, input.id))
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such package index' })
    const using = await workflowsUsing(ctx.db, row.slug)
    if (using.length) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Workflows use this index: ${using.slice(0, 5).join(', ')}${using.length > 5 ? ` and ${using.length - 5} more` : ''}`,
      })
    }
    await ctx.db.delete(pythonIndexes).where(eq(pythonIndexes.id, input.id))
    await ctx.audit({
      action: 'python.index_deleted',
      objectType: 'python_index',
      objectId: input.id,
      metadata: { slug: row.slug },
    })
    return { ok: true }
  }),

  /** Whether the builder reaches the index and it takes the sign-in, for fields saved or not. */
  test: adminProcedure.input(Fields).mutation(async ({ ctx, input }) => {
    const client = pythonBuilder()
    if (!client) {
      return { ok: false, status: null, message: "There's no package builder here (PYTHON_BUILDER_URL)" }
    }
    const fields = await checked(ctx.db, input)
    try {
      const index = await builderIndex(ctx.db, {
        id: '',
        slug: 'test',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...fields,
      })
      return await client.checkIndex(index, fields.testPackage)
    } catch (err) {
      if (err instanceof BlockFailure) return { ok: false, status: null, message: err.message }
      throw err
    }
  }),
})
