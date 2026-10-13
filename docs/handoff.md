# Session handoff

What has been built, how, and where to pick up. **Read this first in a new session**, then the matching milestone in [architecture.md](architecture.md), which holds the full Retool analysis, the design decisions and the roadmap (M0–M9).

Last updated: 2026-10-13 (end of session 3, which finished M2 and M3).

| | |
|---|---|
| **Branch** | `feat/m3-editor`, 6 commits on top of `main`, pushed |
| **PR** | [#3 M3: Editor](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/3), **ready for review, not merged**, CI green on every commit (now three jobs: check, e2e, docker) |
| **`main`** | `4a8356e`, the merge of [PR #2](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/2) (M2), after `8edaa51` (PR #1, M1). Milestones are merged with merge commits so the step commits stay in history. |
| **Remote** | `origin` = github.com/FabioAlexandreCeriaco/optiply-workflows (**private**), pushed with the authenticated `gh` CLI |

---

## 1. Status at a glance

| Milestone | Status |
|---|---|
| Research: how Retool works | ✅ Part 1 of `architecture.md` |
| Build plan and architecture | ✅ Approved. Part 2 of `architecture.md` |
| **M0 Foundations** | ✅ On `main` (§3) |
| **M1 Resources** | ✅ On `main` (§4) |
| **M2 Headless engine** | ✅ On `main` (§5) |
| **M3 Editor** | ✅ **Done on `feat/m3-editor`, PR #3 ready for review.** The Playwright "done when" passes locally and in CI (§6). |
| **M4 Releases & triggers** | ⏭️ **Next**, after PR #3 is merged (§11) |
| M5–M9 | Not started |

**Start the next session with:**
1. Review and merge PR #3 with a merge commit, like PR #1 and #2.
2. Then start M4 on a new branch (§12).

## 2. Decisions made with the user (don't re-ask)

### Product and process
- **Product:** an internal Retool-style platform for **Optiply only**: single org, self-hosted. Not multi-tenant SaaS.
- **Priority:** **Resources + Workflows first**. Database is M7, the App builder M8.
- **Stack:** TypeScript full stack. React + Vite frontend, Node backend, Postgres. pnpm + Turborepo monorepo.
- **Workflow engine:** our own Postgres-backed orchestrator, not Temporal and not pg-boss. Rationale in `architecture.md` §2.1; semantics specified in §2.2.
- **Licences:** write our own code. AGPL projects (ToolJet, Windmill, Lowcoder) and n8n are for ideas only. Libraries under permissive licences are fine as dependencies:
  - MIT: acorn, undici, @xyflow/react, @dagrejs/dagre, zustand, monaco-editor, @monaco-editor/react.
  - Apache-2.0: @playwright/test.
  - BSD-2-Clause: eslint-scope. Flagged to the user in session 2; no objection.
  - **elkjs (EPL-2.0) was declined** in session 3; autolayout uses dagre.
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

### Taken in M3 (keep these unless there's a reason to change)
- **Renaming a block** (`renameBlock` in `@ow/definition`) rewrites only real references (locals, property names, strings and comments are untouched), keeps shorthand keys (`{ old }` → `{ old: renamed }`), and **refuses a name a local variable would capture**. Fields with syntax errors are renamed where possible and reported.
- **Run block** reuses the ancestors' results from the latest finished run in that environment (or `fromRunId`), marked `cachedFrom`; ancestors without a result run first; nothing after the block runs. **New input means nothing is reused**, since every block depends on the start trigger. Stored as `workflow_runs.target_blocks`.
- **Live status** comes from NOTIFY `ow_run_events`, sent inside the fenced commits, so a fenced-off worker can't publish. One LISTEN connection per process fans out to SSE subscribers. Clients never step a block back from a final status.
- **Editor:**
  - Validation runs in the browser on every edit (`@ow/definition`), and drafts save while invalid. **Run is disabled while there are errors.**
  - Autosave 0.8 s after the last edit, with the draft revision; a conflict shows a Reload banner. Run saves first, because runs execute the saved draft.
  - New blocks are connected after the selected block (not after a branch, whose outputs are per condition).
  - Monaco's own TypeScript checking is off: **our validator is the single source of problems**, shown as markers. Completions come from a `.d.ts` typed from the latest finished run (results up to 512 KB each).
  - The editor is a lazy chunk; Monaco is a second lazy chunk loaded with the first code field.
- `/runs` lists runs across the workflows you can see; each opens in the editor with `?run=<id>`.

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

## 5. What M2 built (on `main`)

| Commit | What |
|---|---|
| `dd1e7ed` | **`packages/definition`**: the strict zod schema (startTrigger, code, resourceQuery, branch, filter, response; ports `out`/`error`/`cond:<id>`/`else`; sparse block settings), `validateDefinition` (diagnostics with paths and offsets; queries checked by their connector server side), `buildGraph`, `codeFields`/`fieldRefs`, canonical JSON and `definitionHash`. |
| `12eff1b` | **Schema** (`0002_workflows.sql`): workflows, draft snapshots, releases, triggers (basic), runs (the queue: lease, fencing `epoch`, CHECKs), block runs, payloads (10 MB), logs. Bug caught: `\.` in a `sql` template literal became `.` (SemVer CHECK accepted `1x2x3`). |
| `141e19b` | **Engine** `executeRun`: readiness, dead-path elimination, parallel fan-out (max 10), branch, `finally` stop/continue, retries, timeouts, run deadline, first Response replies; results committed before children start, so `checkpoints` resume. |
| `11db86f` | **Dispatcher**: `claimRuns` (`FOR UPDATE SKIP LOCKED`, epoch bump), leases renewed, LISTEN wake-ups, `reapExpiredLeases` (`worker_lost` after 3), `PgRunStore` (every write share-locks the run row and checks the epoch), graceful `stop()`. |
| `776e888` | **Server**: the worker runs the Dispatcher; tRPC `workflows` (CRUD, `saveDraft` with revisions); REST runs API under `/api/v1`; run checks (draft runs need Edit + Use on resources; draft snapshots); workflow permissions; `Access`. |
| `2db92b3` | §2.2a coverage table, three gap tests, docs. |

M2's "done when" proofs: `architecture.md` §2.2a (every §2.2 rule mapped to its tests); `packages/engine/test/crash.test.ts` (a SIGKILLed worker's run resumes elsewhere without re-running finished blocks); `packages/engine/test/dispatcher.test.ts` "fences off a zombie worker".

## 6. What M3 built (on `feat/m3-editor`)

**"Done when"**: Playwright builds "query → branch → code → response", runs it, renames a block, and its references update. Proven by `apps/web/e2e/editor.spec.ts`, which does exactly that through the UI and then runs the renamed workflow again. It passes locally (four runs, about 8 s each) and in CI's `e2e` job.

### Step 1, `9b6bcbf`: rename and Run block (backend)
- `@ow/expressions` flags shorthand references; `renameBlock` in `@ow/definition` (see §2).
- `executeRun({ only })`, `enqueueRun(…, { seed })`, `workflow_runs.target_blocks` (migration `0003_run_targets.sql`), `startBlockRun` and `POST /api/v1/workflows/:slug/blocks/:block/runs`.
- Caught by the type checker: `ancestors()` returns the graph's memoised set; mutating it would have corrupted later lookups.

### Step 2, `2a6f783`: live run events
- `RUN_EVENTS_CHANNEL` (`ow_run_events`): block events from `PgRunStore` inside the fenced transaction; run events from claim (in the claim statement), finish, release and the reaper.
- `RunEventHub` (one LISTEN per process) and `GET /api/v1/runs/:id/events` (SSE: `snapshot`, `block`, `run`, `end`; subscribe before snapshot; 15 s pings). `buildApp` takes the postgres.js `listener`.

### Step 3, `86593aa`: workflows list and canvas
- `/workflows` list and "New workflow" (slug from name); the editor route is lazy and full-bleed (`staticData.fullBleed`).
- `@xyflow/react` canvas: a handle per port, connect/delete/move, dagre "Arrange", minimap; diagnostics as badges, broken edges red; autosave with conflicts. State in zustand (`editor/store.ts`).

### Step 4, `6cd5064`: inspectors, Monaco, completions, rename UI
- A form per block type plus timeout/retries/failure and description (`editor/inspectors.tsx`).
- Monaco 0.57 bundled locally (`editor/monaco.ts`, `code-field.tsx`): `MonacoEnvironment.getWorker` supplies Vite `?worker` module workers (`vite.config` `worker.format: 'es'`); markers from our diagnostics; `{{ }}` completions in SQL/text.
- `.d.ts` from the latest run (`scope-types.ts`, `last-run.ts`).
- **Bugs found in the browser** (all fixed): Monaco's editor worker didn't load without `getWorker`; Monaco inside a `<label>` couldn't be focused (code fields use `EditorField`, a div); React Flow's document key handlers swallowed spaces typed in Monaco and Backspace could delete the selected block (the side panel is `nokey`).

### Step 5, `3e1d591`: running from the editor
- Run (saves first, test input, environment picker), Run block, live statuses on the canvas (outlines, fired edges), the run panel (blocks with data/errors, logs, output, JSON export, recent runs), `/runs` (`GET /api/v1/runs`).
- **Bug found in the browser:** a zustand selector returning a new array each call looped React forever (#185). Select stable state and derive with `useMemo`.

### Step 6 (this commit): Playwright e2e, CI, docs
- `apps/web/playwright.config.ts`, `e2e/global-setup.ts` (embedded Postgres + seeded `customers`, admin via the bundled `create-admin`, the bundled server serving the built web app, a Postgres resource via the API), `e2e/editor.spec.ts`.
- CI job `e2e`: builds web and server, installs Chromium, runs the test, uploads the report and traces on failure.

### Totals at the end of M3
`biome ci` is clean. Typecheck passes **9/9** packages. **337 tests pass** (expressions 73, definition 58, connectors 54, engine 52, server 43, crypto 25, db 20, sandbox 12) plus **1 Playwright e2e**.

Bundles: main 568 kB, editor chunk 431 kB, Monaco about 4 MB (≈1 MB gzipped) loaded with the first code field, the JS language worker 6.9 MB loaded with the first JS field.

## 7. How things were verified (and how to repeat it)

- **Unit and integration tests:** `pnpm test`. Each server, db, connector and engine Postgres test file boots its own embedded Postgres. The engine suite was run three times in a row after steps 3 and 4 with no flakes.
- **Bundled server, session 3:** `node --no-node-snapshot dist/main.js` with ROLE=all against the dev database. A Python script drove the session login, `workflows.create`, `workflows.saveDraft` and `POST /api/v1/workflows/<slug>/runs`.
  - The code → branch → response workflow went from queued to succeeded in 0.06 s. The branch's other side was skipped, and the logs and blocks read back correctly.
  - SIGTERM logged "dispatcher stopped".
  - The script lived in the session scratchpad and isn't committed.
- **To run the bundled server locally**, set `MIGRATIONS_DIR=../../packages/db/migrations` (and `WEB_DIST_DIR=../web/dist` to serve the UI). `@fastify/static` lists files once at startup, so restart it after rebuilding the web app.
- **Playwright e2e (committed):** `pnpm --filter @ow/web build && pnpm --filter @ow/server build && pnpm --filter @ow/web e2e`. Locally it uses the installed Chrome (`channel: 'chrome'`); CI uses Playwright's Chromium. The server runs on port 4387 (`E2E_PORT`).
- **Headless browser walkthroughs (session 3, not committed):** puppeteer-core scripts in the session scratchpad (`pptr/walk-editor.mjs`, `walk-inspector.mjs`, `walk-run.mjs`) drove the bundled server against the dev database for each M3 step, with screenshots read back. Gotchas:
  - Typing into Monaco: wait for `.monaco-editor.focused` first; it auto-closes brackets and quotes, then types over them, so typing balanced text works.
  - Monaco wraps long lines on screen: rendered text contains extra line breaks.
  - Click empty canvas away from the floating toolbar (top left), controls (bottom left) and minimap (bottom right).
  - Chrome logs expected 4xx responses as console errors.
  - `::-p-text()` matches substrings; input values aren't in `innerText`.
- **Restart the bundled server after rebuilding the web app**: `@fastify/static` lists files once at startup, and stale asset names return the SPA's HTML (a MIME-type error in the browser).

## 8. Local environment quirks (this Mac)

- Node v24.15.0 (arm64). **No global pnpm, no Docker, no system Postgres.**
- Run pnpm as **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`**. **Turbo needs a `pnpm` binary on PATH.** In a Claude session, run `corepack enable --install-directory <scratchpad>/bin pnpm` and prepend that directory to PATH. The user can simply run `corepack enable`.
- **Dev database:** `pnpm dev:db` stores its data in `.data/pg` (gitignored), with `DATABASE_URL=postgres://ow:ow@127.0.0.1:5433/optiply_workflows`. It contains:
  - a `demo_customers` table (id, email, plan, created_at; 5 rows, created by hand in session 2);
  - a **"Demo DB" Postgres resource** (`demo_db`, production only) pointing at the dev database itself, created in session 3;
  - migrations up to `0003`, and test workflows from session 3 (`smoke-…`, `editor-smoke-…`, `inspector-…`, `runs-…`) with their runs. All safe to delete.
- **`.env`** (gitignored) has `SESSION_SECRET`, `LOCAL_LOGIN_ENABLED=true` and a generated `ENCRYPTION_KEYS=v1:…`. `WORKER_CONCURRENCY` defaults to 4 when unset.
- **Dev admins:**
  - `admin@optiply.nl`: the password was reset in session 2 and given to the user then.
  - `m2-smoke@optiply.nl`: created in session 3 for the smoke tests and browser walkthroughs (random password kept only in that session's scratchpad). Harmless; delete it or reset it with `create-admin`.

  To set a password:
  ```bash
  corepack pnpm --filter @ow/server create-admin -- --email admin@optiply.nl --name Admin
  ```
  It prompts for a password, or reads `ADMIN_PASSWORD`.
- **Everything was stopped** at the end of the session (database, server).

## 9. Still unverified

1. **Google SSO** against real Google. This needs an OAuth client with redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the user.
2. **`docker compose up`** locally (Docker isn't installed). CI's `docker build` passes. Compose requires `ENCRYPTION_KEYS` in `.env`; its two worker containers now actually run workflows.

## 10. Known gaps and TODOs carried forward

- **Engine:**
  - **Sandbox isolation inside a run:** when the watchdog disposes a run's isolate (a code block stuck in an async loop), other code blocks evaluating at that moment in the same run fail with "Sandbox was reset". Retries absorb it.
  - **Retry backoff sleeps in the worker**, holding a slot. Long backoffs could requeue the run with `availableAt` instead.
  - **Webhook headers reach `startTrigger.headers` unfiltered**: M4 must strip the API-key header.
  - **Block data isn't scrubbed of secret config values**, only logs and errors are (same rule as Postgres data in M1).
  - `pending` block status is never written; `waiting` arrives in M5.
- **Pool invalidation across processes:** there's still no `NOTIFY resource_changed`. Pooled clients are keyed by the config's `updatedAt`, so changes take effect on the next load. Add it if long-lived worker pools cause stale-config problems.
- **Postgres `describe()`** leaves one named prepared statement per query on the connection until postgres.js recycles it.
- **APIs:** no OpenAPI document for the REST routes yet, and no API keys (M4). The runs list paginates by run id (UUIDv7, so creation order).
- **Tests not written yet:** the OIDC callback logic (extract the claim checks into a pure function). The web app has no unit tests; it's covered by the Playwright test and the (uncommitted) walkthroughs.
- **Web:**
  - No toast or confirm system (`confirm()` is used).
  - The main bundle is 568 kB; the editor and Monaco are split out, the other pages aren't.
  - The editor has no undo/redo across blocks (Monaco has per-field undo), no copy/paste of blocks, and no "create function from selection" (functions are M5).
  - The run panel's logs tab shows the first 500 lines.
  - The resources playground still uses textareas; it could reuse `CodeField`.
- **Editor completions** cover the latest finished run only, typed from samples (array items merged); there's no environment choice for them.
- **Not built yet:** MySQL, BigQuery and multipart REST bodies (M6); the `api_keys` table and UI (M4); `oauth_tokens` (M9); releases and their permission check at publish time (M4).

## 11. Next step: M4 Releases & triggers

From `architecture.md` §2.2 (schedules), §2.3 and §2.7: semver releases and rollback; projecting the live release's triggers into `workflow_triggers`; webhooks (sync and async, aliases with `:params`, API keys, `?environment=`, `Idempotency-Key`); schedules (cron or interval, timezone default Europe/Amsterdam, overlap `skip`/`queue`/`allow`, catch up with one run after downtime); per-workflow `max_concurrent_runs`. **Done when:** sync webhook p50 under 50 ms; tests pass across the Amsterdam DST change; a 1-minute cron with a 2-minute run never overlaps.

Already in place:
- `workflow_releases` (SemVer, `definitionHash`), `workflows.live_release_id`, `workflow_triggers` (basic), `workflow_runs.idempotency_key` / `scheduled_for` unique indexes with the `ON CONFLICT` insert tested.
- `@ow/crypto` API-key helpers (`ow_` prefix, sha256, timing-safe compare); no `api_keys` table or UI yet.
- NOTIFY `ow_run_finished` (run id) and `ow_run_events` for waiting on a sync webhook's response; `workflow_runs.response`.
- Live runs need Use on the workflow; **publishing must check Use on every resource the release queries** (§2).

Watch out for:
- Strip the API-key header before it reaches `startTrigger.headers`.
- Sync webhooks run in-process in the API under a semaphore (architecture §2.1); the engine and `RunStore` already allow that.
- Releases should store `canonicalize(definition)` and its hash; the editor needs a Releases tab (publish, rollback).

## 12. How to start the next session

```bash
cd /Users/optiply/optiply-workflows
git fetch && git status                          # PR #3 merged? Then: git switch main && git pull
gh pr view 3                                     # ready for review → merge (merge commit), if not done yet
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm dev:db &                           # Postgres on :5433
corepack pnpm --filter @ow/server dev &          # API + worker on :3000 (auto-migrates; needs ENCRYPTION_KEYS in .env)
corepack pnpm --filter @ow/web dev               # http://localhost:5173
git switch -c feat/m4-releases-triggers          # then open a draft PR after the first commit
```
