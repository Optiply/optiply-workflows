# Session handoff

What has been built, how, and where to pick up. **Read this first in a new session**, then the matching milestone in [architecture.md](architecture.md), which holds the full Retool analysis, the design decisions and the roadmap (M0–M9).

Last updated: 2026-10-13 (end of session 3).

| | |
|---|---|
| **Branch** | `feat/m2-engine`, 6 commits on top of `main`, pushed |
| **PR** | [#2 M2: Headless engine](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/2), **ready for review, not merged**, CI green on every commit |
| **`main`** | `8edaa51`, the merge of [PR #1](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/1) (M1), kept as a merge commit so the step commits stay in history |
| **Remote** | `origin` = github.com/FabioAlexandreCeriaco/optiply-workflows (**private**), pushed with the authenticated `gh` CLI |

---

## 1. Status at a glance

| Milestone | Status |
|---|---|
| Research: how Retool works | ✅ Part 1 of `architecture.md` |
| Build plan and architecture | ✅ Approved. Part 2 of `architecture.md` |
| **M0 Foundations** | ✅ On `main` (§3) |
| **M1 Resources** | ✅ On `main` (§4) |
| **M2 Headless engine** | ✅ **Done on `feat/m2-engine`, PR #2 ready for review.** All three "done when" criteria pass (§5). |
| **M3 Editor** | ⏭️ **Next**, after PR #2 is merged |
| M4–M9 | Not started |

**Start the next session with:**
1. Review and merge PR #2. Merge with a merge commit, like PR #1, unless you prefer squashing.
2. Then start M3 on a new branch (§11).

## 2. Decisions made with the user (don't re-ask)

### Product and process
- **Product:** an internal Retool-style platform for **Optiply only**: single org, self-hosted. Not multi-tenant SaaS.
- **Priority:** **Resources + Workflows first**. Database is M7, the App builder M8.
- **Stack:** TypeScript full stack. React + Vite frontend, Node backend, Postgres. pnpm + Turborepo monorepo.
- **Workflow engine:** our own Postgres-backed orchestrator, not Temporal and not pg-boss. Rationale in `architecture.md` §2.1; semantics specified in §2.2.
- **Licences:** write our own code. AGPL projects (ToolJet, Windmill, Lowcoder) and n8n are for ideas only. Libraries under permissive licences are fine as dependencies:
  - MIT: acorn, undici.
  - BSD-2-Clause: eslint-scope. Flagged to the user in session 2; no objection.
- **Git workflow:**
  - Repo-local identity `fabioceriaco <fabioceriaco@optiply.nl>`.
  - **Commit only when the user asks.** End commit messages with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - One feature branch per milestone, with a **draft PR** opened early so CI runs on every push. CI only runs on pushes to `main` and on PRs. GitHub needs one commit on the branch before a PR can be opened.
  - Commit messages are detailed: what changed in each file, why, and how it was verified.
  - After each commit, tick the step in the PR description's checklist.
  - Merge milestone PRs with a merge commit (session 3).
- **Working rhythm the user likes:** do one step, report, then wait for "commit" / "continue". Don't start the next step unprompted. Watch CI in the background and report the result.
- **Session wrap-up:** commit, then update this file.

### Taken in M1 (keep these unless there's a reason to change)
- **Encrypted values are one self-describing text token** `<keyVersion>.<iv>.<ciphertext>.<tag>` (base64url). The AAD is `table:rowId:envId`. Every writer goes through `encryptForRow` / `decryptForRow` (`apps/server/src/services/secrets.ts`).
- **Secrets are write-only.** The browser receives `{ set: true }` masks. Saves send a patch: a string sets a value, `null` clears it, a missing key keeps it. Secret validation errors report field paths only.
- **Permission model:**
  - Grants are `(group, objectType resource|folder|workflow, objectId?, environmentId?, level use|edit|own)`.
  - A user's level is the highest of their groups' grants on the object, on all objects of that type (no `objectId`), or on any folder containing it. Admins implicitly own everything.
  - **Resources** are per environment: **Use** = run queries, **Edit** = change settings, **Own** = delete and manage access. Creating resources and folders needs Edit on all resources in all environments.
  - Folder-wide and type-wide grants are admin-only. Objects the user can't see return NOT_FOUND.
- **Secret config vars are not in the query playground scope.** Non-secret ones are `{{ configVars.NAME }}`, plus `current_user`.
- **Postgres read-only mode guards against mistakes; it isn't a security boundary.** The real boundary is a SELECT-only database user.
- **REST data is scrubbed of secret values; Postgres data isn't** (`scrubResultData`). Errors and metadata are always scrubbed.
- **SSRF guard:** REST resources block private, loopback, link-local, metadata, CGNAT and multicast addresses unless `allowPrivateNetwork`; hosts are limited to the base URL's host plus `allowedHosts`; redirects are followed by hand with every hop checked.

### Taken in M2 (keep these unless there's a reason to change)
- **Definition format** (`packages/definition`):
  - Block names are JS identifiers and are the identity. Branch conditions have stable ids, so edges are `cond:<id>`.
  - **Branch and filter conditions are plain JS expressions, written without `{{ }}`.** The filter condition has `value` and `index`.
  - **Block settings are stored sparsely**; defaults (10 s timeout, no retries, 1 s interval, ×2, 60 s cap, `finally: stop`) are applied at run time by `resolveBlockSettings`. If a default changes, released workflows pick it up.
  - **A block only has an `error` output when `finally: continue`.**
  - Every string in a resource query is treated as a template (connector-agnostic), so `{{ }}` inside an SQL comment is also checked.
  - Blocks the start trigger can't reach are a **warning**, not an error; they're skipped at run time.
  - Schemas are strict: unknown keys are errors.
  - `functions` is left out until M5; triggers are a first cut that M4 completes.
- **Globals in every evaluation:** `configVars`, `workflowContext { runId, workflowId, environment, triggerType }`, `idempotencyKey` (the caller's key, or the run id), plus the stdlib (`_`, `dayjs`, `console`). `current_user` isn't available in workflows. `setTimeout` and `fetch` don't exist in the sandbox and are flagged as unknown.
- **Engine behaviour:**
  - At most 10 blocks execute at once per run.
  - **Retries apply to every kind of failure**; the backoff sleeps in the worker.
  - Results are stored as **plain JSON** (dates become strings) and capped at 10 MB.
  - Only the blocks a block references are copied into its sandbox scope.
  - "Sent" and "ignored" Response blocks are marked in metadata, not with extra statuses. A branch's data is the id of the condition that fired (`null` for else). Response header names are lowercased; the status must be 100–599.
  - **A database error or a lost lease interrupts a run instead of failing it.** The worker doesn't hand it back: its lease expires and the reaper counts a recovery, so a run that keeps breaking fails after 3. Only a graceful shutdown hands runs back immediately.
- **Data model:**
  - `workflow_runs.response` (the first Response block's reply) replaces the generic `output`.
  - Every run points at exactly one release or draft snapshot. **Editor runs execute a frozen draft snapshot**, shared by every run of the same draft revision.
  - `block_runs` has `epoch` and `port`.
  - **Deleting a workflow deletes its run history.**
- **Running workflows:**
  - **Draft runs** need Edit on the workflow and Use on every resource it queries in that environment.
  - **Live runs** need Use on the workflow; resources are vouched for at publish time (M4).
  - Runs are refused up front if the definition is invalid or a resource isn't configured in the environment.
  - **Draft runs see only non-secret config vars** (like the playground); runs of a release also get secret ones. Secret values are always scrubbed from logs and errors.
  - **Workflow grants apply to every environment**; per-environment workflow grants are refused. A workflow's owners manage its access.
  - Workflow slugs allow dashes and underscores (they'll appear in webhook URLs).
- **APIs:** managing workflows is tRPC (`workflows.*`). Starting and reading runs is REST under `/api/v1` (session cookie now, API keys in M4), as the architecture plans for public routes. Errors are `{ error: { code, message, details? } }`.

## 3. What M0 built (on `main`)

- **Monorepo:**
  - pnpm 10.34.7 (pinned in `packageManager`), Turborepo 2.11, Biome 2.5, **TypeScript `~6.0.3`**. Not TS 7: the Go-native compiler breaks drizzle-kit.
  - Workspace packages export TS source; there's no per-package build. The server is bundled by esbuild, the web app by Vite.
  - `AGENTS.md` is written by turbo; keep it committed.
  - **Turbo's `^typecheck` follows devDependencies too**, so a test-only dependency can create a cycle (session 3 hit db → definition → connectors → db).
- **`packages/db`:** Drizzle schema with UUIDv7 IDs generated app-side, and migrations generated by `pnpm db:generate` (never hand-edited). `runMigrations` runs under an advisory lock and seeds the production and staging environments plus the Admins and All Users groups. Embedded Postgres 18 for dev and tests.
- **`packages/sandbox`:** isolated-vm `IvmRuntime`, one isolate per runtime and a fresh context per evaluation from a snapshot. A watchdog handles async loops. ⚠️ Processes need **`TZ=UTC`** and Node needs **`--no-node-snapshot`**.
- **`apps/server`:** Fastify 5 + tRPC 11 (superjson); Google OIDC (openid-client v6, PKCE, verified `@optiply.nl` with the `hd` claim) and break-glass local login (scrypt); opaque session cookie stored as its sha256; users, groups and audit routers; `ROLE=api|worker|migrate|all`; `HOST` defaults to `127.0.0.1`.
- **`apps/web`:** React 19, TanStack Router (code-based routes) and Query, Tailwind v4 tokens, small shadcn-style primitives in `components/ui.tsx`.
- **Ops:** multi-stage Dockerfile (`pnpm deploy --prod --legacy`, runtime `node:24-bookworm-slim`), Compose (postgres, migrate, api, 2 workers), CI (`biome ci`, typecheck, test, docker build).

## 4. What M1 built (on `main`)

| Commit | What |
|---|---|
| `c133bad` | **`packages/crypto`**: `parseKeyring` (strict base64 key text), AES-256-GCM `encrypt`/`decrypt`/`encryptJson`, `secretAad`, `rekey`; API-key helpers (`ow_` prefix, sha256); `redact`, `scrubSecrets`, `scrubSecretsDeep`. The server requires `ENCRYPTION_KEYS`. |
| `110ed87` | **Schema** (`0001_resources.sql`): `folders`, `permissions`, `resources`, `resource_configs`, `config_vars` + `config_var_values`. **`rekey` CLI** (`pnpm --filter @ow/server rekey [--dry-run]`). `build.mjs` bundles the CLIs. `cliArgs()` drops pnpm 10's literal `--`. |
| `682fc10` | **`packages/expressions`**: JS-aware `parseTemplate`, `freeIdentifiers`/`freeIdentifierRefs` (acorn + eslint-scope; rejects code that breaks out of the wrapper; **acorn `ranges` is required**), `compileSql` (`{{ }}` → `$n`, quote/comment aware, fix-it hints), `renderTemplate`/`renderText`/`renderJson`. |
| `3e4f5fc` | **`packages/connectors`**: the `Connector` interface, `PoolManager`, `runQuery`/`testResource`. Postgres (⚠️ all user SQL uses the extended protocol; `describe()` first; cursor + `maxRows`; `statement_timeout`; cancel on abort; read-only mode). REST (undici; auth modes; OAuth2 client credentials; allowed hosts; manual redirects; SSRF guard; size cap). |
| `02eb7c6` | **API + UI**: stdlib as a committed generated bundle (`bundle:stdlib`); `ResourceAccess` (now `Access`), resources/permissions/folders/configVars routers; the resources pages, query playground and config vars page. |

M1's "done when" proofs: `apps/server/test/resources.test.ts` (no secret in any of 77+ responses), `packages/connectors/test/postgres.test.ts` (injection inert, `pg_stat_activity` shows `$1`), `packages/crypto/test/aead.test.ts` (swapped ciphertext fails).

## 5. What M2 built (on `feat/m2-engine`)

**The three "done when" criteria, and the test that proves each:**

| Criterion | Proven by |
|---|---|
| Golden semantics tests cover every rule in §2.2 | `architecture.md` §2.2a maps each rule to its tests. Rules for M4/M5 (loops, functions, waits, schedules, HTTP mapping) are marked as such. Session 3 filled three gaps (idempotency key default, run timeout bounds, never overwriting a committed result). |
| A `kill -9` of a worker mid-run resumes without re-running completed blocks | `packages/engine/test/crash.test.ts`: a worker in a child process (`test/fixtures/worker.ts`, run with tsx) is SIGKILLed while `pg_sleep` runs. Another worker recovers it (recoveries 1, epoch 3). The block that had finished executed once, and its row still carries epoch 1. |
| The zombie-worker fencing test passes | `packages/engine/test/dispatcher.test.ts` "fences off a zombie worker": worker A stops renewing mid-block; B recovers and finishes the run; A's own commit is refused ("Lost the lease … (epoch 1)"), and every write at the old epoch is rejected. |

### Step 1, `dd1e7ed`: `packages/definition`
- `workflowDefinitionSchema` (zod v4, strict): `schemaVersion: 1`, `settings.timeoutMs` (1 s–6 h, default 15 min), `triggers` (first cut), `blocks` (startTrigger, code, resourceQuery, branch, filter, response; max 500), `edges {from, port, to}` (max 2000), `layout`.
- `blockPorts`, `resolveBlockSettings`, `DEFAULT_BLOCK_SETTINGS`.
- `validateDefinition(input, { resolveResource? })` returns `{ ok, definition?, diagnostics }`. Each diagnostic has a severity, code, path, block and source offsets; codes are listed in `validate.ts`. With `resolveResource` (server side), each query is checked by its connector's `querySchema` and `validateQuery`.
- `codeFields`, `fieldRefs` and `referencedNames`; `buildGraph` (stable topological order, cycle, memoised ancestors and descendants).
- `canonicalize`, `canonicalJson` (keys sorted by code unit, integer-like keys included), `definitionHash` (SHA-256 via Web Crypto, layout excluded). The package bundles for the browser.

### Step 2, `12eff1b`: schema (migration `0002_workflows.sql`)
- `workflows`, `workflow_draft_snapshots`, `workflow_releases` (SemVer CHECK, hash CHECK), `workflow_triggers` (basic), `workflow_runs`, `block_runs`, `block_run_payloads` (10 MB CHECK), `run_logs`.
- `workflow_runs` CHECKs: exactly one of release or snapshot; a running run has a lease; `finished_at` is set exactly when final. Partial unique indexes on the idempotency key and on `(trigger_id, scheduled_for)`. Partial indexes on the foreign keys that bulk deletes touch.
- **Bug caught in review:** `\.` inside the `sql` template literal became a bare `.`, so the SemVer CHECK accepted `1x2x3`. It's now `\\.`, with a test.
- `@ow/db` depends on `@ow/definition` for the `WorkflowDefinition` type. That's why `@ow/definition` must not depend on `@ow/connectors`, even in tests.

### Step 3, `141e19b`: `packages/engine` run logic
- `executeRun(opts)` validates, then runs: readiness, dead-path elimination, ports, parallel fan-out (max 10), retries with backoff, block timeouts, the run deadline, `finally: stop` (cancels in-flight blocks) and `continue`, and the first Response block as the reply.
  - Results are committed through `RunStore` before children start, so `checkpoints` resume a run without re-running finished blocks.
  - Outcomes are `succeeded | failed | interrupted`.
- Block executors in `blocks.ts`. Errors are normalised by `toEngineError` and scrubbed of secrets.
- `MemoryRunStore` for tests. 33 semantics tests plus 4 against real Postgres (including a block timeout cancelling `pg_sleep` on the server).

### Step 4, `11db86f`: dispatcher
- `queue.ts`:
  - `enqueueRun` (NOTIFY `ow_runs_queued`);
  - `claimRuns` (`FOR UPDATE SKIP LOCKED`, bumps the epoch, lease on the database clock);
  - `renewLease`, `ensureDeadline` and `finishRun` (NOTIFY `ow_run_finished` with the run id);
  - `releaseRun`;
  - `reapExpiredLeases` (requeue with the epoch bumped, `worker_lost` after `maxRecoveries`, running blocks marked `interrupted`);
  - `loadCheckpoints`.
- `PgRunStore`: every write first takes `FOR SHARE` on the run row and checks the epoch and status, and throws `LeaseLostError` otherwise. A committed row is never overwritten. Logs are buffered.
- `Dispatcher`: a claim loop up to `concurrency`, woken by LISTEN with a poll fallback; renews leases every third of the lease; reaps on a timer; one `IvmRuntime` per run; `drain()` and `stop()`.
- `block_runs.port` added. Migration 0002 was regenerated rather than adding 0003: it had only run on throwaway test databases.

### Step 5, `776e888`: server
- `worker/index.ts` runs the `Dispatcher` (`WORKER_CONCURRENCY`, default 4) with `dbResourceProvider` (slug → decrypted config) and `dbRunContext` (config vars).
- `services/workflow-runs.ts` `startManualRun` (the checks in §2), `RunRequestError`.
- tRPC `workflows`: list, get (with diagnostics), create, update, `saveDraft` (CONFLICT on a stale revision), delete.
- REST `api/runs.ts` under `/api/v1`: `POST /workflows/:slug/runs`; `GET /workflows/:slug/runs`, `/runs/:id`, `/runs/:id/blocks`, `/runs/:id/blocks/:key`, `/runs/:id/logs`.
- `Access.workflowLevel` and `canCreateWorkflows`; the permissions router accepts workflow targets. `ResourceAccess`/`loadResourceAccess` were renamed to `Access`/`loadAccess`.

### Step 6 (this commit): coverage review and docs
- `architecture.md` §2.2a, the three gap tests, and this file and the README.

### Totals at the end of M2
`biome ci` is clean. Typecheck passes **9/9** packages. **320 tests pass**:

| Package | Tests |
|---|---|
| expressions | 72 |
| connectors | 54 |
| definition | 52 |
| engine | 47 |
| server | 38 |
| crypto | 25 |
| db | 20 |
| sandbox | 12 |

CI is green on every M2 commit, both jobs, including the crash test on Linux.

## 6. How things were verified (and how to repeat it)

- **Unit and integration tests:** `pnpm test`. Each server, db, connector and engine Postgres test file boots its own embedded Postgres. The engine suite was run three times in a row after steps 3 and 4 with no flakes.
- **Bundled server, session 3:** `node --no-node-snapshot dist/main.js` with ROLE=all against the dev database. A Python script drove the session login, `workflows.create`, `workflows.saveDraft` and `POST /api/v1/workflows/<slug>/runs`.
  - The code → branch → response workflow went from queued to succeeded in 0.06 s. The branch's other side was skipped, and the logs and blocks read back correctly.
  - SIGTERM logged "dispatcher stopped".
  - The script lived in the session scratchpad and isn't committed.
- **To run the bundled server locally**, set `MIGRATIONS_DIR=../../packages/db/migrations` (and `WEB_DIST_DIR=../web/dist` to serve the UI). `@fastify/static` lists files once at startup, so restart it after rebuilding the web app.
- **Headless browser walkthrough (M1):** puppeteer-core plus local Chrome, kept in the scratchpad. Gotchas: `::-p-text()` matches substrings; input values aren't in `innerText`; top-level `await` errors don't fire `unhandledRejection`. Playwright e2e arrives in M3.

## 7. Local environment quirks (this Mac)

- Node v24.15.0 (arm64). **No global pnpm, no Docker, no system Postgres.**
- Run pnpm as **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`**. **Turbo needs a `pnpm` binary on PATH.** In a Claude session, run `corepack enable --install-directory <scratchpad>/bin pnpm` and prepend that directory to PATH. The user can simply run `corepack enable`.
- **Dev database:** `pnpm dev:db` stores its data in `.data/pg` (gitignored), with `DATABASE_URL=postgres://ow:ow@127.0.0.1:5433/optiply_workflows`. It contains a `demo_customers` table (5 rows), **no resources yet**, and since session 3 the M2 tables (migration 0002) plus one smoke-test workflow (`smoke-…`).
- **`.env`** (gitignored) has `SESSION_SECRET`, `LOCAL_LOGIN_ENABLED=true` and a generated `ENCRYPTION_KEYS=v1:…`. `WORKER_CONCURRENCY` defaults to 4 when unset.
- **Dev admins:**
  - `admin@optiply.nl`: the password was reset in session 2 and given to the user then.
  - `m2-smoke@optiply.nl`: created in session 3 for the smoke test, with a random password that wasn't kept. Harmless; delete it or reset it with `create-admin`.

  To set a password:
  ```bash
  corepack pnpm --filter @ow/server create-admin -- --email admin@optiply.nl --name Admin
  ```
  It prompts for a password, or reads `ADMIN_PASSWORD`.
- **Everything was stopped** at the end of the session (database, server).

## 8. Still unverified

1. **Google SSO** against real Google. This needs an OAuth client with redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the user.
2. **`docker compose up`** locally (Docker isn't installed). CI's `docker build` passes. Compose requires `ENCRYPTION_KEYS` in `.env`; its two worker containers now actually run workflows.

## 9. Known gaps and TODOs carried forward

- **Engine:**
  - **Sandbox isolation inside a run:** when the watchdog disposes a run's isolate (a code block stuck in an async loop), other code blocks evaluating at that moment in the same run fail with "Sandbox was reset". Retries absorb it.
  - **Retry backoff sleeps in the worker**, holding a slot. Long backoffs could requeue the run with `availableAt` instead.
  - **Webhook headers reach `startTrigger.headers` unfiltered**: M4 must strip the API-key header.
  - **Block data isn't scrubbed of secret config values**, only logs and errors are (same rule as Postgres data in M1).
  - `pending` block status is never written; `waiting` arrives in M5.
- **Pool invalidation across processes:** there's still no `NOTIFY resource_changed`. Pooled clients are keyed by the config's `updatedAt`, so changes take effect on the next load. Add it if long-lived worker pools cause stale-config problems.
- **Postgres `describe()`** leaves one named prepared statement per query on the connection until postgres.js recycles it.
- **APIs:** no OpenAPI document for the REST routes yet, and no API keys (M4). The runs list paginates by run id (UUIDv7, so creation order).
- **Tests not written yet:** the OIDC callback logic (extract the claim checks into a pure function), and Playwright e2e (M3).
- **Web:** no toast or confirm system (`confirm()` is used), no code-splitting (544 kB bundle), and textareas instead of Monaco (M3). There's no workflow UI at all yet.
- **Not built yet:** MySQL, BigQuery and multipart REST bodies (M6); the `api_keys` table and UI (M4); `oauth_tokens` (M9); releases and their permission check at publish time (M4).

## 10. Next step: M3 Editor

From `architecture.md` §2.6 and §2.7: the canvas (React Flow per block type, ports for `out`/`error`/`cond:*`/`else`, elk autolayout, minimap); block inspectors; Monaco with a `.d.ts` generated from the last run's outputs; autosave with `draftRevision`; Run (with test JSON) and Run block (cached upstream outputs); SSE live status; the run history panel. **Done when** Playwright builds "query → branch → code → response", runs it, renames a block, and its references update.

M2 already provides:
- `@ow/definition` for the editor: validation diagnostics with offsets, `blockPorts`, `buildGraph` and `codeFields`. It bundles for the browser.
- The tRPC `workflows` router, including `saveDraft` with conflicts.
- The REST runs API and NOTIFY `ow_run_finished` for live status.

Still needed for M3:
- **A rename refactor** in `@ow/expressions`, using `freeIdentifierRefs` offsets.
- **"Run block"**, which `executeRun` doesn't support yet: a block on its own with given upstream results.
- **An SSE endpoint**, fed by the `block_runs` changes or a new NOTIFY channel.

## 11. How to start the next session

```bash
cd /Users/optiply/optiply-workflows
git fetch && git status                          # PR #2 merged? Then: git switch main && git pull
gh pr view 2                                     # ready for review → merge, if not done yet
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm dev:db &                           # Postgres on :5433
corepack pnpm --filter @ow/server dev &          # API + worker on :3000 (auto-migrates; needs ENCRYPTION_KEYS in .env)
corepack pnpm --filter @ow/web dev               # http://localhost:5173
git switch -c feat/m3-editor                     # then open a draft PR after the first commit
```
