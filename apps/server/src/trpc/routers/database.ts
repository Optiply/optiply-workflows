import { environments, managedDatabases, resources } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { asc, desc, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { z } from 'zod'
import { CsvError, DELIMITERS, guessCsv } from '../../services/csv'
import {
  addColumn,
  alterColumn,
  authorizeManagedDb,
  ColumnChange,
  ColumnSpec,
  createTable,
  dropColumn,
  dropTable,
  ExistingName,
  getTable,
  listTables,
  ManagedDbError,
  type ManagedDbTarget,
  NewName,
  renameColumn,
  renameTable,
  withManagedDb,
} from '../../services/managed-db'
import {
  DELETE_LIMIT,
  deleteRows,
  insertRow,
  RowKey,
  RowQuery,
  RowValues,
  readRows,
  updateRow,
} from '../../services/managed-db-rows'
import { atLeast, loadAccess } from '../../services/permissions'
import { authedProcedure, type Context, router } from '../init'

/** The start of a file the preview reads (it's a sample; the import reads everything). */
const PREVIEW_MAX_CHARS = 256 * 1024
const Id = z.uuid()
const InEnv = z.object({ environmentId: Id })
const OnTable = InEnv.extend({ table: ExistingName })
const OnColumn = OnTable.extend({ column: ExistingName })

type AuthedContext = Context & { user: NonNullable<Context['user']> }

function open(ctx: AuthedContext, environmentId: string): Promise<ManagedDbTarget> {
  return translate(() => authorizeManagedDb(ctx.db, ctx.user, environmentId))
}

/** Runs as the environment's role; what Postgres refuses comes back as a message about the change. */
function inDb<T>(ctx: AuthedContext, target: ManagedDbTarget, fn: Parameters<typeof withManagedDb<T>>[2]) {
  return translate(() =>
    withManagedDb({ db: ctx.db, keyring: ctx.config.keyring, pool: ctx.services.pool }, target, fn),
  )
}

const TRPC_CODES = {
  not_ready: 'PRECONDITION_FAILED',
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  invalid: 'BAD_REQUEST',
} as const

async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ManagedDbError) {
      throw new TRPCError({ code: TRPC_CODES[err.code], message: err.message })
    }
    if (err instanceof postgres.PostgresError) {
      // 55P03 lock_not_available: someone else is using the table (a long query, an open transaction).
      if (err.code === '55P03') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The table is busy right now; try again in a moment',
        })
      }
      if (err.code === '42P01') throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: err.detail ? `${err.message} (${err.detail})` : err.message,
      })
    }
    throw err
  }
}

async function audit(
  ctx: AuthedContext,
  target: ManagedDbTarget,
  action: string,
  table: string,
  metadata: Record<string, unknown> = {},
) {
  await ctx.audit({
    action: `database.${action}`,
    objectType: 'database_table',
    objectId: table,
    environmentId: target.environmentId,
    metadata,
  })
}

export const databaseRouter = router({
  /** Every environment, whether its database is ready, and whether the caller may use it. */
  environments: authedProcedure.query(async ({ ctx }) => {
    const access = await loadAccess(ctx.db, ctx.user)
    const [resource] = await ctx.db.select().from(resources).where(eq(resources.systemKind, 'database'))
    const rows = await ctx.db
      .select({ environment: environments, schemaName: managedDatabases.schemaName })
      .from(environments)
      .leftJoin(managedDatabases, eq(managedDatabases.environmentId, environments.id))
      .orderBy(desc(environments.isDefault), asc(environments.name))
    return {
      resourceId: resource?.id ?? null,
      resourceSlug: resource?.slug ?? null,
      environments: rows.map((r) => ({
        id: r.environment.id,
        slug: r.environment.slug,
        name: r.environment.name,
        color: r.environment.color,
        ready: Boolean(resource && r.schemaName),
        canUse: Boolean(resource && atLeast(access.level(resource, r.environment.id), 'use')),
      })),
    }
  }),

  tables: authedProcedure.input(InEnv).query(async ({ ctx, input }) => {
    const target = await open(ctx, input.environmentId)
    return inDb(ctx, target, (tx) => listTables(tx, target.schemaName))
  }),

  createTable: authedProcedure
    .input(InEnv.extend({ name: NewName, columns: z.array(ColumnSpec).max(200).default([]) }))
    .mutation(async ({ ctx, input }) => {
      const target = await open(ctx, input.environmentId)
      const table = await inDb(ctx, target, async (tx) => {
        await createTable(tx, input.name, input.columns)
        return getTable(tx, target.schemaName, input.name)
      })
      await audit(ctx, target, 'table_created', input.name, {
        columns: input.columns.map((c) => ({ name: c.name, type: c.type })),
      })
      return table
    }),

  renameTable: authedProcedure.input(OnTable.extend({ to: NewName })).mutation(async ({ ctx, input }) => {
    const target = await open(ctx, input.environmentId)
    const table = await inDb(ctx, target, async (tx) => {
      await renameTable(tx, input.table, input.to)
      return getTable(tx, target.schemaName, input.to)
    })
    await audit(ctx, target, 'table_renamed', input.to, { from: input.table })
    return table
  }),

  dropTable: authedProcedure.input(OnTable).mutation(async ({ ctx, input }) => {
    const target = await open(ctx, input.environmentId)
    await inDb(ctx, target, (tx) => dropTable(tx, input.table))
    await audit(ctx, target, 'table_dropped', input.table)
  }),

  addColumn: authedProcedure
    .input(OnTable.extend({ column: ColumnSpec }))
    .mutation(async ({ ctx, input }) => {
      const target = await open(ctx, input.environmentId)
      const table = await inDb(ctx, target, async (tx) => {
        await addColumn(tx, input.table, input.column)
        return getTable(tx, target.schemaName, input.table)
      })
      await audit(ctx, target, 'column_added', input.table, {
        column: input.column.name,
        type: input.column.type,
      })
      return table
    }),

  renameColumn: authedProcedure.input(OnColumn.extend({ to: NewName })).mutation(async ({ ctx, input }) => {
    const target = await open(ctx, input.environmentId)
    const table = await inDb(ctx, target, async (tx) => {
      await renameColumn(tx, input.table, input.column, input.to)
      return getTable(tx, target.schemaName, input.table)
    })
    await audit(ctx, target, 'column_renamed', input.table, { column: input.to, from: input.column })
    return table
  }),

  dropColumn: authedProcedure.input(OnColumn).mutation(async ({ ctx, input }) => {
    const target = await open(ctx, input.environmentId)
    const table = await inDb(ctx, target, async (tx) => {
      await dropColumn(tx, input.table, input.column)
      return getTable(tx, target.schemaName, input.table)
    })
    await audit(ctx, target, 'column_dropped', input.table, { column: input.column })
    return table
  }),

  alterColumn: authedProcedure
    .input(OnColumn.extend({ change: ColumnChange }))
    .mutation(async ({ ctx, input }) => {
      const target = await open(ctx, input.environmentId)
      const table = await inDb(ctx, target, async (tx) => {
        await alterColumn(tx, target.schemaName, input.table, input.column, input.change)
        return getTable(tx, target.schemaName, input.table)
      })
      await audit(ctx, target, 'column_changed', input.table, { column: input.column, change: input.change })
      return table
    }),

  /**
   * Guesses how to import a CSV from its start (the browser sends the first part of the file): delimiter, column
   * names and types, date order, decimal commas, and preview rows. Only parses; the import itself streams to
   * `POST /api/v1/database/import`.
   */
  // A mutation only so the sample travels in a POST body: as a query it would be in the URL.
  previewCsv: authedProcedure
    .input(
      z.object({
        sample: z.string().max(PREVIEW_MAX_CHARS),
        complete: z.boolean().default(false),
        /** Read with this delimiter instead of the guessed one. */
        delimiter: z.enum(DELIMITERS).optional(),
        /** Whether the first row holds column names (types are guessed from the data rows only). */
        header: z.boolean().default(true),
      }),
    )
    .mutation(({ input }) => {
      try {
        return guessCsv(input.sample, {
          complete: input.complete,
          delimiter: input.delimiter,
          header: input.header,
        })
      } catch (err) {
        if (err instanceof CsvError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
        throw err
      }
    }),

  /** A page of rows, sorted and filtered, with the table's shape and how many rows match. */
  rows: authedProcedure
    .input(OnTable.extend({ query: RowQuery.default(RowQuery.parse({})) }))
    .query(async ({ ctx, input }) => {
      const target = await open(ctx, input.environmentId)
      return inDb(ctx, target, (tx) => readRows(tx, target.schemaName, input.table, input.query))
    }),

  // Row writes are audited by table, key and columns, never values (they're the user's data).
  insertRow: authedProcedure.input(OnTable.extend({ values: RowValues })).mutation(async ({ ctx, input }) => {
    const target = await open(ctx, input.environmentId)
    const row = await inDb(ctx, target, (tx) => insertRow(tx, target.schemaName, input.table, input.values))
    await audit(ctx, target, 'row_inserted', input.table, { columns: Object.keys(input.values) })
    return row
  }),

  updateRow: authedProcedure
    .input(OnTable.extend({ key: RowKey, values: RowValues }))
    .mutation(async ({ ctx, input }) => {
      const target = await open(ctx, input.environmentId)
      const row = await inDb(ctx, target, (tx) =>
        updateRow(tx, target.schemaName, input.table, input.key, input.values),
      )
      await audit(ctx, target, 'row_updated', input.table, {
        key: input.key,
        columns: Object.keys(input.values),
      })
      return row
    }),

  deleteRows: authedProcedure
    .input(OnTable.extend({ keys: z.array(RowKey).min(1).max(DELETE_LIMIT) }))
    .mutation(async ({ ctx, input }) => {
      const target = await open(ctx, input.environmentId)
      const deleted = await inDb(ctx, target, (tx) =>
        deleteRows(tx, target.schemaName, input.table, input.keys),
      )
      await audit(ctx, target, 'rows_deleted', input.table, { keys: input.keys, deleted })
      return { deleted }
    }),
})
