# Session handoff

What has been built, how, and where to pick up. **Read this first in a new session**, then the matching milestone in [architecture.md](architecture.md), which holds the full Retool analysis, the design decisions and the roadmap (M0–M9).

Last updated: 2026-10-12. Commits on `main`: `fe2f073 feat: M0 foundations`, then `docs: add session handoff`. Remote: `origin` = github.com/FabioAlexandreCeriaco/optiply-workflows (**private**), pushed with the authenticated `gh` CLI.

---

## 1. Status at a glance

| Milestone | Status |
|---|---|
| Research: how Retool works (apps, workflows, resources, database, platform) | ✅ Done. Summary is Part 1 of `architecture.md` |
| Build plan and architecture | ✅ Done and approved. Part 2 of `architecture.md` |
| **M0 Foundations** | ✅ **Done and committed** (see §3). Two items couldn't be verified on this machine (see §5). |
| **M1 Resources** | ⏭️ **Next.** Nothing started. |
| M2–M9 | Not started |

## 2. Decisions made with the user (don't re-ask)

- **Product:** an internal Retool-style platform for **Optiply only**: single org, self-hosted. Not multi-tenant SaaS.
- **Priority:** **Resources + Workflows first**. Database is M7, the App builder M8.
- **Stack:** TypeScript full stack. React + Vite frontend, Node backend, Postgres. Monorepo.
- **Workflow engine:** our own Postgres-backed orchestrator, not Temporal and not pg-boss. Rationale is in `architecture.md` §2.1. The workflow semantics are already specified there in §2.2 (readiness and dead-path elimination, error ports, Response, Loop, Wait, schedules, idempotency).
- **Licences:** write our own code. AGPL projects (ToolJet, Windmill, Lowcoder) and n8n are for ideas only. Code may be borrowed from Apache-2.0 or MIT sources (Appsmith).
- **Git:** repo-local identity `fabioceriaco <fabioceriaco@optiply.nl>`. Commit only when the user asks. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Session wrap-up:** the user asked for a handoff document like this one at the end of the session. Keep this file updated.

## 3. What M0 built, and how

### Monorepo (root)
- **Tooling:**
  - pnpm 10.34.7 is pinned via `packageManager`.
  - Turborepo 2.11 tasks are `build`, `typecheck`, `test` and `dev`.
  - Biome 2.5 handles lint and format: single quotes, no semicolons, line width 110, Tailwind directives enabled.
- **TypeScript is `~6.0.3`**, not 7: TS 7 is the Go-native compiler, and drizzle-kit and other tools need the JS compiler API. `tsconfig.base.json` uses Bundler resolution, `strict`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- **Workspace packages export TypeScript source** (`"exports": "./src/index.ts"`); there is no per-package build. The server is bundled by esbuild, and the web app by Vite.
- `AGENTS.md` is written automatically by the turbo CLI. Keep it committed.

### `packages/db`
- **`src/schema.ts`** (Drizzle, snake_case casing): `users`, `sessions`, `groups` (with `systemKind` `admins` or `all_users`), `group_members`, `environments`, `audit_events`. **IDs are UUIDv7, generated app-side** (the `uuid` package) rather than relying on PG18's `uuidv7()`.
- **`migrations/0000_init.sql`** was generated with `pnpm db:generate`, i.e. `drizzle-kit generate`. **Always generate migrations; never hand-edit the snapshot.**
- **`src/migrate.ts`, `runMigrations(url, dir?)`:** runs under `pg_advisory_lock(727001)`, then **idempotently seeds** the environments `production` (default) and `staging`, and the groups **Admins** and **All Users**.
- **`src/embedded.ts`, `dev-db.ts`, `testing.ts`:** Postgres 18 comes from the **`embedded-postgres`** npm package, so dev and tests need **no Docker**. `startTestDatabase()` gives each test file its own throwaway instance, or uses `TEST_DATABASE_URL` when set.

### `packages/sandbox`: the isolated-vm runtime for user JavaScript
- **`CodeRuntime` interface** (`src/types.ts`): `evalExpression`, `runCode` and `dispose`. Errors are `SandboxError` with a kind of `timeout`, `memory`, `runtime`, `syntax` or `serialization`.
- **`IvmRuntime`** (`src/ivm-runtime.ts`):
  - One isolate per runtime instance, with a **fresh context per evaluation**, created from a **snapshot**.
  - The snapshot holds a stdlib bundled by esbuild (`src/stdlib-entry.js`: lodash `_`, and dayjs with utc, timezone, customParseFormat and relativeTime) plus a prelude with a console shim and `__owToJson`.
  - Scope values are copied in as globals. Results are JSON-normalised, so a Date becomes an ISO string.
  - Sync infinite loops are stopped by the per-eval `timeout`. Async continuations are stopped by a **watchdog that disposes the isolate** at timeout + 250ms. The isolate is recreated after an OOM or a dispose.
- **Measured:** about **0.6ms per evaluation**. Covered by 11 tests: no Node APIs reachable (`process`, `require`, the `Function('return this')` escape), sync and async infinite loops killed, memory bomb killed and recovered, isolation between evaluations.
- ⚠️ **Processes must run with `TZ=UTC`.** dayjs' timezone plugin computes wrong DST offsets otherwise (found during testing). `main.ts` sets it, as do the Vitest configs and the Dockerfile.
- ⚠️ **Node needs `--no-node-snapshot`** for isolated-vm. It's set in the dev script, the Vitest `execArgv` and the Docker `CMD`.

### `apps/server`
- **`src/main.ts`:** `ROLE=api|worker|migrate|all`. It forces `TZ=UTC` and uses pino (pretty in development). `AUTO_MIGRATE=true` migrates on start, which is the dev default in `.env.example`.
- **`src/config.ts`:** zod-validated environment variables, loading `.env` from the cwd or the repo root. `HOST` defaults to **127.0.0.1** so the dev server isn't exposed on the LAN; Docker sets `0.0.0.0`.
- **`src/api/app.ts`:**
  - Fastify 5. ⚠️ A pino instance must be passed as **`loggerInstance`**, not `logger`.
  - Registers `/api/health`, the auth routes, and tRPC at `/api/trpc`.
  - Serves the SPA from `WEB_DIST_DIR`, with an `index.html` fallback for routes outside `/api`.
- **Auth** (`src/auth/*`):
  - **Google OIDC** with `openid-client` v6: authorization code + PKCE. State, nonce and verifier live in a signed cookie. Discovery is lazy and memoised. Login requires `email_verified` plus the `@optiply.nl` suffix plus the `hd` claim.
  - **Break-glass local login:** `POST /api/auth/local` with scrypt hashes (`src/auth/password.ts`), only when `LOCAL_LOGIN_ENABLED`.
  - **Sessions:** an opaque random token in the `ow_session` cookie (httpOnly, SameSite=Lax); the database stores only its **sha256**. Disabling a user deletes their sessions.
  - `provisionUser()` (`src/services/users.ts`) runs under an advisory lock. The **first user ever becomes admin**, and every user is added to All Users.
- **tRPC** (`src/trpc/*`):
  - Uses the **superjson** transformer.
  - Procedures: `publicProcedure`, `authedProcedure` (401) and `adminProcedure` (403).
  - Routers:
    - `authConfig`, `me`
    - `users.list` / `setDisabled`
    - `groups.list` / `get` / `create` / `update` / `delete` / `addMember` / `removeMember`. Built-in groups are protected, All Users can't be edited, and the last admin is protected under a row lock.
    - `environments.list`
    - `audit.list` (cursor pagination)
  - `ctx.audit()` writes audit events through `recordAudit()`, which **redacts** secret-looking keys.
  - ⚠️ `init.ts` has `import type {} from '@fastify/cookie'` so `req.cookies` typechecks when the web app imports the router type.
- **`src/worker/index.ts`:** a heartbeat placeholder. **M2 replaces it** with the claim loop, reaper, scheduler tick and retention.
- **`src/cli/create-admin.ts`:** `pnpm --filter @ow/server create-admin -- --email x@optiply.nl --name X`. The password comes from `ADMIN_PASSWORD` or a prompt, minimum 12 characters.
- **`build.mjs`:** esbuild bundles `src/main.ts` together with the `@ow/*` sources. npm packages stay external, and **the build fails if an external import isn't a direct dependency** of `apps/server`. That matters because `pnpm deploy --prod` only exposes direct dependencies; it already caught `postgres` and `uuid` once.
- **Tests:** `test/api.test.ts` has 11 tests and uses Fastify `inject` against an embedded PG. Helpers are in `test/helpers.ts`, including a tiny tRPC client that speaks the superjson envelope.

### `apps/web`
- **Stack:** Vite 8, React 19, TanStack Router (**code-based routes** in `src/router.tsx`, not file-based), TanStack Query, `@trpc/tanstack-react-query`, Tailwind v4 with tokens in `src/styles.css` (`canvas`, `surface`, `border`, `muted`, `ink`, `accent`, …), and a small set of shadcn-style primitives in `src/components/ui.tsx`.
- **Routes:**
  - `/login`
  - The `app` layout, whose guard calls `ensureQueryData(me)`.
  - `/workflows`, `/resources`, `/runs` (placeholders)
  - `/settings/{users,groups,groups/$groupId,environments,audit}`. Admin-only pages are wrapped in `AdminOnly`.
- ⚠️ **After login, refetch `me` with `fetchQuery(..., staleTime: 0)` before navigating.** The guard reads the cached `null` otherwise (a bug found and fixed in the browser test).
- The Vite dev server proxies `/api` to `:3000`. The production bundle is a single chunk of about 500 kB; code-split later.

### Ops
- **`Dockerfile`:** multi-stage. Build on bookworm with python3, make and g++ for isolated-vm, then `pnpm deploy --prod --legacy`. Runtime is `node:24-bookworm-slim` running as `USER node`, with `TZ=UTC` and `--no-node-snapshot`. Migrations are copied to `/app/migrations` (`MIGRATIONS_DIR`) and the web app to `/app/web` (`WEB_DIST_DIR`).
- **`docker-compose.yml`:** `postgres:18`, a one-shot `migrate`, `api` on :3000, and `worker` × 2.
- **`.github/workflows/ci.yml`:** `biome ci`, typecheck and test (embedded PG), plus a `docker build` job.

## 4. Local environment quirks (this Mac)

- Node v24.15.0 (arm64). **There is no global pnpm, no Docker and no system Postgres.**
- Run pnpm as **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`**. **Turbo needs a `pnpm` binary on PATH.** In this session that was done with `corepack enable --install-directory <scratchpad>/bin pnpm` and prepending it to PATH. The user can simply run `corepack enable`, which may need sudo for `/usr/local/bin`.
- **Dev database:** `pnpm dev:db` stores its data in `.data/pg` (gitignored), with `DATABASE_URL=postgres://ow:ow@127.0.0.1:5433/optiply_workflows`.
- **Dev admin:** a local `.env` exists (gitignored) with a random `SESSION_SECRET` and `LOCAL_LOGIN_ENABLED=true`. The local dev database has a local admin, `admin@optiply.nl`. Its password isn't stored in the repo; reset it any time with `create-admin` (which updates an existing user).
- **Background processes:** the dev database, API and Vite were **stopped** at the end of the session. Restart them with `pnpm dev:db` and `pnpm dev`.

## 5. Verification done in M0, and what's still unverified

**Verified:**
- `biome ci` is clean, `pnpm typecheck` passes for 4/4 packages, and `pnpm test` runs 22 tests, all passing.
- Curl smoke test through the Vite proxy: login, then `me`, `groups.create` and `audit.list`.
- **Headless Chrome walkthrough** (puppeteer-core with the local Chrome, run from the scratchpad, not committed): redirect to `/login`, sign in, the workflows placeholder, the users, groups and audit pages, adding a group member. No console errors.
- **Production bundle:** `build.mjs`, then `pnpm deploy`, then `node dist/main.js` serving health, the SPA fallback and assets.

**Not verified yet:**
1. **Google SSO** against real Google. This needs an OAuth client: redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the user.
2. **`docker build` and `docker compose up`.** Docker isn't installed. CI will build the image on the first push.
3. **CI** runs on push to `main`. Check the first run with `gh run list`.

## 6. Known gaps and TODOs carried forward

- **`packages/sandbox/src/stdlib.ts` builds the stdlib at runtime** with esbuild, from a path relative to the source file. That **will break once the server is bundled** (`dist/main.js`). In M2, before the server uses the sandbox, generate the stdlib bundle at build time (for example `stdlib.generated.js`) or embed it as a string, and make `esbuild` a dev dependency. Also add `isolated-vm` as a direct server dependency at that point.
- The `permissions` table (Use/Edit/Own per object and environment) is planned but **not created yet**. It belongs in M1.
- There are no tests yet for the OIDC callback logic. Extract the claim checks into a pure function and unit-test them.
- `packages/db` has no tests of its own (`--passWithNoTests`).
- Web: there's no toast system or confirm dialog yet (`confirm()` is used for deleting a group), and no code-splitting.

## 7. Next step: M1 Resources

From `architecture.md` §2.5 and §2.7:
1. **`packages/crypto`:** AES-256-GCM with versioned keys (`ENCRYPTION_KEYS=v1:…`, `ENCRYPTION_KEY_CURRENT`) and **AAD = `table:rowId:envId`**. Also secret redaction helpers and a `rekey` CLI.
2. **Schema:** `resources`, `resource_configs` (one per environment; non-secret `config` jsonb plus encrypted `secrets`), `permissions(group_id, object_type, object_id?, environment_id?, level use|edit|own)`, `config_vars` and `config_var_values`, and `folders`.
3. **`packages/expressions`:** the `{{ }}` template parser, acorn free-identifier analysis, and the **SQL lexer** that turns `{{ }}` into bind parameters (`$n` for Postgres). A `{{ }}` inside a string literal is an error.
4. **`packages/connectors`:**
   - The `Connector` interface (`configSchema`, `secretsSchema`, `querySchema`, `testConnection`, `compile`, `execute`) and a PoolManager.
   - **Postgres** (postgres.js, `SET LOCAL statement_timeout`, `maxRows`, read-only option).
   - **REST** (undici; auth via API key, bearer, basic or OAuth2 client credentials; `allowedHosts`; SSRF guard).
5. **API and UI:**
   - Resource CRUD per environment, where secrets are write-only and responses return `{set: true}`.
   - Test connection.
   - A **query playground** that runs a query with `{{ }}` against a chosen environment.
   - Permission checks.
   - Config vars and secrets UI.
6. **M1 is done when:**
   - Snapshot tests show no secret ever appears in an API response.
   - SQL injection fixtures stay inert, and `pg_stat_activity` shows `$1`.
   - A ciphertext swapped between rows fails to decrypt.

## 8. How to start the next session

```bash
cd /Users/optiply/optiply-workflows
git log --oneline | head                       # confirm fe2f073 (or later) is HEAD
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm dev:db &                         # Postgres on :5433
corepack pnpm --filter @ow/server dev &        # API on :3000 (auto-migrates)
corepack pnpm --filter @ow/web dev             # http://localhost:5173 (sign in as the local admin; see §4)
```

Before running tests through turbo, make sure `pnpm` is on PATH (see §4). Then begin **M1, step 1** (`packages/crypto`).
