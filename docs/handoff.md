# Session handoff

What has been built, how, and where to pick up. **Read this first in a new session**, then the matching milestone in [architecture.md](architecture.md), which holds the full Retool analysis, the design decisions and the roadmap (M0–M9).

Last updated: 2026-10-14 (end of session 5, which built M5).

| | |
|---|---|
| **Branch** | `feat/m5-advanced-blocks`, 8 commits on top of `main`, pushed |
| **PR** | [#6 M5: Advanced blocks](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/6), **ready for review, not merged**; CI green on every step commit (jobs: check incl. the webhook and sandbox benchmarks, e2e, docker) |
| **`main`** | `05f360a`, the merge of [PR #5](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/5) (M4). Milestones are merged with merge commits so the step commits stay in history. |
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
| **M3 Editor** | ✅ On `main` (§6) |
| **M4 Releases & triggers** | ✅ On `main` (§7) |
| **M5 Advanced blocks** | ✅ **Done on `feat/m5-advanced-blocks`, PR #6 ready for review.** All three done-whens proven, in tests and on Docker Compose (§8). One open issue: an intermittent isolated-vm crash (§12). |
| **M6 Hardening** | ⏭️ **Next**, after PR #6 is merged (§13) |
| M7–M9 | Not started |

**Start the next session with:**
1. Review and merge PR #6 with a merge commit, like the others.
2. Then start M6 on a new branch (§13, §14).

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
- **Globals in every evaluation:** `configVars`, `workflowContext { runId, workflowId, environment, triggerType }`, `idempotencyKey` (the caller's key, or the run id), plus the stdlib (`_`, `dayjs`, `console`). `current_user` isn't available in workflows. `setTimeout` doesn't exist in the sandbox and is flagged as unknown; `fetch` exists since M5, in code only.
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

### Taken in M4 (keep these unless there's a reason to change)
- **Releases:**
  - Publishing releases the draft at the revision the publisher sees (refused if someone saved since) and makes it live in one transaction. Versions: explicit or bumped from the highest (patch by default, 1.0.0 first), always higher than every release. Publishing an unchanged definition (same hash, layout ignored) is refused.
  - **Publish and rollback need Edit on the workflow and Use on every resource it queries in every environment** (agreed with the user): webhook and schedule runs have no user behind them, and `?environment=` can pick any environment.
  - Rollback = `releases.setLive` with any release; same checks.
  - The semver helpers live in `@ow/definition` (`versions.ts`), shared with the publish dialog.
- **Triggers:**
  - Values people type (cron, time zone, alias, interval) are checked by the **validator**, not the schema, so a half-typed draft still saves. Trigger diagnostics are pinned to the start trigger.
  - A webhook exists only when the definition has `triggers.webhook` with `enabled: true`. Default methods `[POST]`, sync timeout 30 s (0–5 min).
  - Webhook URLs: `/api/v1/workflows/<slug>/webhook` and `/api/v1/hooks/<alias>`. Alias segments are lowercase text or `:params`, the first must be text; two live aliases with the same **shape** (`orders/:`) conflict; the most specific match wins.
  - Projection into `workflow_triggers` matches rows by (kind, name), so a trigger keeps its id across releases; an unchanged schedule (same cron/interval/time zone) keeps `next_fire_at`.
- **Cron semantics** (our own parser, `packages/definition/src/cron.ts`, no dependency): 5 fields plus `@daily` etc., Vixie's day-of-month/day-of-week OR rule, evaluated on the zone's wall clock (default Europe/Amsterdam). **A skipped wall-clock time (spring forward) fires once at the end of the gap; a repeated one (fall back) fires once, the first time.** A daily job runs exactly once a day.
- **Scheduler:** every worker ticks every 5 s on the **database clock**; each due trigger is locked with SKIP LOCKED; **catch-up = one run for the latest fire time that passed**; overlap `skip` (default; a queued, running or waiting run counts) / `queue` (serialized by the claim gate) / `allow`. Scheduled runs get `startTrigger.data = { scheduledFor, schedule }`.
- **Concurrency:** `max_concurrent_runs` counts **every** run of the workflow, editor runs included (agreed). Enforced when claiming, under transaction-scoped advisory locks taken in sorted order; a full workflow doesn't block other runs. It belongs to the workflow, not the release.
- **Webhooks and API keys:**
  - **Webhooks always need an API key** (`X-Api-Key` or `Authorization: Bearer ow_…`), and that header (plus `cookie`) never reaches the run. Public or signed webhooks are a later option.
  - Keys are admin-managed, shown once, stored as sha256, optionally limited to workflows and environments, can expire, and are revoked rather than deleted. A key may read single runs (`GET /api/v1/runs/:id`) it's allowed, for async callers.
  - Sync webhook runs execute **in the API process** (`InlineRunner`, `WEBHOOK_INLINE_CONCURRENCY`, default 8) when a slot is free and the workflow is under its limit; otherwise on a worker. The call answers as soon as the reply is recorded (store hook in-process, `response` run event across processes). After the timeout or with `Prefer: respond-async`: `202 {runId, status}` + `Location`.
  - Reply mapping: the Response block's status/headers/body (hop-by-hop headers dropped; a string body with a non-JSON content type is sent raw); no Response → `200 {runId, status}`; failure first → `500` with the error. `X-Run-Id` always. `Idempotency-Key` (≤ 255) replays the earlier run, marked `Idempotent-Replayed: true`.
  - Bodies: JSON (empty → null), forms → object, anything else → text. `?environment=` is removed from `urlParams`.
- **UI:** the editor loads a workflow once per visit (refetches no longer reset it); "unpublished changes" compares the server's `draftHash` (returned by every save) with the live release's hash, so no Web Crypto is needed in the browser.

### Taken in M5 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M5** (PR #6's "Defaults"):
  - **Function calls aren't checkpointed**: they belong to the block (or loop iteration) that calls them, which re-runs as a whole.
  - **Function parameters** are read as `params.x`. A function returns its `returns` block's data, by default the only block nothing follows. `params` is reserved as a block name everywhere.
  - **Child workflows** always run the child's **live release**, in the parent's environment (also from draft runs).
  - **Cancel** needs the access starting the run took: Edit on the workflow for a draft run, Use for a live one. API keys may cancel runs they may read.
  - **During a Wait** other branches keep running; the run pauses once only waits are left.
- **`await fn(a, b)` passes arguments by position** in the function's parameter order (Function blocks and loop runners pass them by name). Flagged in the step 2 report.
- **Definition:**
  - Loops have no block-level retries (per item: `config.iteration`), waits only `finally`. Default block timeouts: loop and wait 6 h (bounded by the run timeout), function and workflow 15 min, others 10 s.
  - Function blocks can't contain triggers, Response, Wait or sync child workflows; recursion between functions is refused; `await fn()` and `fetch` are allowed in code only.
  - At most one error handler; a block can't be on both the main and handler paths; handler blocks may read any main-path block.
  - The server validates child workflows: unknown → `unknown_workflow`, no live release → `unpublished_workflow`.
- **Sandbox:** `fetch(url, { method, headers, body })` with a string body and `text()`/`json()` (no `arrayBuffer`, `URL`, `Headers` or `AbortController` in the sandbox); private, loopback, link-local and metadata addresses are refused unless `CODE_FETCH_ALLOW_PRIVATE_NETWORK=true`; 10 MB cap; aborted with the block and when the code returns. Host calls go through one `__owHost` reference answering JSON.
- **Engine:**
  - **Waits:** a waiting block stores `{ until, childRunId?, since? }` on its `waiting` row; a resumed block uses it (a Wait's template isn't evaluated again). Waits due within 1 s finish in process. Pausing bumps the epoch and sets `suspended_at`; `ensureDeadline` moves the deadline on by the time spent waiting. Paused runs resume on the workers' 5 s poll (or at once when a child wakes them).
  - **Cancel:** queued/waiting → `cancelled` at once; running → `cancel_requested_at` + NOTIFY `ow_run_cancel`, with lease renewal and the reaper as fallbacks; children are cancelled recursively.
  - **Error handler:** runs on block failure and run timeout (not on cancel), with its own 60 s limit; the run still fails with the original error.
  - **Loops:** iterations commit in batches (200 or 250 ms) as `loop[i]` rows, `ON CONFLICT DO NOTHING`; one `iterations` run event per batch; loop metadata is a summary plus the first 100 failures.
  - **Child workflows:** idempotency key `child:<run>:<block or loop[i]>:<attempt>`; a sync block waits 2 s in process, then pauses (rechecking every 2 s while the run is still busy here, otherwise at the block timeout or after an hour) and is woken when the child ends; past its timeout the child is cancelled. A loop's workflow runner waits within the iteration timeout instead (it holds the worker). Nesting is capped at 10 levels.
- **Server/API:** `POST /runs/:id/cancel` (200/202/409), `GET /runs/:id/children`, `GET /runs/:id/blocks/:key/iterations`; run views have `parentRunId`; iteration rows never appear in a run's block list.
- **UI:** a function opens on the canvas (the store's `graph`); the toolbar is icon buttons keeping their `Add a … block` titles; Monaco model paths include the function (`<workflow>/<fn or _>/<block>/<field>`).

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

## 6. What M3 built (on `main`)

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

### Step 6, `9e9fd63`: Playwright e2e, CI, docs
- `apps/web/playwright.config.ts`, `e2e/global-setup.ts` (embedded Postgres + seeded `customers`, admin via the bundled `create-admin`, the bundled server serving the built web app, a Postgres resource via the API), `e2e/editor.spec.ts`.
- CI job `e2e`: builds web and server, installs Chromium, runs the test, uploads the report and traces on failure.

### Totals at the end of M3
`biome ci` is clean. Typecheck passes **9/9** packages. **337 tests pass** (expressions 73, definition 58, connectors 54, engine 52, server 43, crypto 25, db 20, sandbox 12) plus **1 Playwright e2e**.

Bundles: main 568 kB, editor chunk 431 kB, Monaco about 4 MB (≈1 MB gzipped) loaded with the first code field, the JS language worker 6.9 MB loaded with the first JS field.

## 7. What M4 built (on `main`)

**Before M4 (PR #4, merged as `493798e`):**
- CI was red on `main` after the M3 merge: the editor e2e typed JSON key by key and raced Monaco's auto-closing on a slow runner, and its retry hit the slug the first attempt had taken. Now text is inserted in one go and retried until it shows; each attempt has its own slug.
- `docker compose up` had **never** started: Compose passes `ENCRYPTION_KEY_CURRENT=""` when unset and the config read `""` as a key version. `loadConfig` now treats empty variables as unset (`apps/server/test/config.test.ts`).

**Done-whens:**
- **Sync webhook p50 under 50 ms:** `apps/server/test/webhook-latency.test.ts` (200 calls over real HTTP after 20 warm-ups; run alone with `pnpm --filter @ow/server bench:webhooks`, and as its own CI step after `pnpm test`, because during `pnpm test` the suites compete for CPU: CI measured p50 35.6 and 45.2 ms that way). Locally p50 14.7 ms, p90 16.3, p99 18.1. On the Compose stack, with a real Postgres query in the workflow: p50 37 ms over 20 curl calls.
- **Tests pass across the Amsterdam DST change:** `packages/definition/test/cron.test.ts` (daily, hourly, every-15-minutes and weekday jobs across 2026-03-29 and 2026-10-25, a year of daily fires, New York and Lord Howe) and `packages/engine/test/scheduler.test.ts` "schedules across the Amsterdam DST changes" (real scheduler ticks every 10 minutes).
- **A 1-minute cron with a 2-minute run never overlaps:** `packages/engine/test/scheduler.test.ts` "a 1-minute cron whose runs take 2 minutes" (minute-by-minute simulation of tick, claim and finish: `skip` never overlaps, `queue` runs every fire one at a time, `allow` overlaps), and live on the Compose stack (§8): 15 minutes of a real `* * * * *` schedule whose run sleeps 120 s gave 5 runs (09:01, 09:04 … 09:13), 10 skipped fires and 0 overlapping runs.

### Step 1, `cebe087`: triggers in the definition, cron with time zones
- `cron.ts` (parser, `nextCronFire`, `wallToInstant` with Intl only, `upcomingCronFires`, `nextIntervalFire`), `triggers.ts` (`parseWebhookAlias` with shapes, `matchWebhookAlias`, `nextScheduleFire`), the webhook/schedule schema (§2), and five trigger diagnostics.

### Step 2, `456cedf`: releases and trigger projection
- `services/releases.ts` (`publishRelease`, `setLiveRelease`, `checkReleasable`, `projectTriggers`), `trpc/routers/releases.ts` (`list`, `get`, `publish`, `setLive`), `workflows.get` with `liveRelease` and `draftHash`, `workflows.triggers`, `workflows.update` with `maxConcurrentRuns`. `checkDefinition` (server-side validation) shared with runs.
- Migration `0004_trigger_projection.sql`: `workflow_triggers.environment_id`, `alias_shape` (unique), `last_fired_at`.

### Step 3, `f1b0501`: scheduler and claim gates
- `packages/engine/src/scheduler.ts` (`tickSchedules`, `Scheduler`, started by the worker). `claimRuns` became a transaction with the `max_concurrent_runs` and `queue` gates (advisory locks in sorted order, re-checked after locking); `finishRun` and the reaper wake workers when a slot frees.
- Migration `0005_run_gates.sql`: partial indexes for running runs per workflow and active runs per trigger.
- Mutation-checked: disabling the gate re-check fails 3 tests; disabling `skip` fails the overlap test.

### Step 4, `6eb6ee5`: webhooks and API keys
- Migration `0006_api_keys.sql`: `api_keys`, `workflow_runs.api_key_id`.
- Engine: `RunExecutor` (extracted from the Dispatcher), `InlineRunner`, `startRun` (claim-on-insert with the limit and idempotency), `response` run events and the store's `onResponse` hook.
- Server: `services/api-keys.ts`, `trpc/routers/api-keys.ts` (admin), `services/webhooks.ts`, `api/webhooks.ts` (routes, body parsers, refusals, sync/async), API-key reads of `GET /api/v1/runs/:id`, `WEBHOOK_INLINE_CONCURRENCY`.

### Step 5, `da74613`: UI
- Editor: `releases.tsx` (header badge, Publish dialog, Releases tab with live triggers and rollback), `triggers.tsx` (webhook and schedules on the start trigger, next fires, inline problems), `workflow-settings.tsx` (run timeout, runs at once); side-panel tabs; the editor loads once per visit.
- `settings/api-keys.tsx`; `Dialog`, `CopyButton`, `Checkbox` in `components/ui.tsx`.
- Verified with a temporary Playwright walkthrough and 8 screenshots (not committed).

### Step 6, `8d75469`: e2e, Compose check, docs
- `apps/web/e2e/releases.spec.ts`: enable the webhook with an alias, publish v1.0.0, create an API key in Settings, call the webhook without cookies (and get 401 without the key), publish a change as v1.1.0 and see it, roll back from the Releases tab and see v1.0.0 again. Shared helpers moved to `e2e/helpers.ts`.
- The latency benchmark moved to `webhook-latency.test.ts` (see above).
- README, `architecture.md` §2.2a and §2.3, this file.

### Totals at the end of M4
`biome ci` is clean. Typecheck passes **9/9**. **413 tests pass** (definition 87, expressions 73, server 72, engine 70, connectors 54, crypto 25, db 20, sandbox 12), plus the webhook benchmark (skipped in `pnpm test`, run on its own) and **2 Playwright e2e**.

Bundles: main 576 kB, editor chunk 458 kB.

## 8. What M5 built (on `feat/m5-advanced-blocks`)

**Done-whens**, proven in tests and on the Compose stack (§9):
- **A 10k-iteration loop survives a crash:** `packages/engine/test/crash.test.ts` (a forked worker SIGKILLed a third of the way; all 10,000 results right and in order, fewer than 500 re-run). On Compose: the worker holding the lease was `docker kill`ed with 3,534 of 10,000 iterations committed; the other worker finished it (1 recovery, epoch 3), 10,000 distinct items over **10,010 executions** (only the 10 in flight re-ran), `resumed: 3534`.
- **A Wait survives a full stack restart:** `packages/engine/test/waiting.test.ts` "survives every worker stopping…". On Compose: a run with a 90 s Wait and a 60 s run timeout paused; `docker compose down` (Postgres included) for 48 s, then `up -d`; it finished 1 s after its resume time with every block run once, and its deadline moved on by the 91 s it waited.
- **Cancel aborts in-flight SQL and fetch:** `waiting.test.ts` "cancel" (pg_sleep gone from `pg_stat_activity`, the fetch's connection closed). On Compose: a run with `pg_sleep(120)` and a `fetch` to a slow server on the host in flight; the cancel answered 202, the run was `cancelled` 534 ms later, and at 700 ms Postgres showed no `pg_sleep` and the server had seen the request closed unanswered.

### Step 1, `53da87f`: definition
Schema for `loop`, `function`, `workflow`, `wait`, `errorTrigger` and `functions[]`; the validator rewritten around `checkGraph` (main graph and each function); `walk.ts` (`blockGraphs`, `queriedResources`, `calledWorkflows`, …); `renameBlock(…, { function })` and `renameFunction`; canonical form with functions. The server's resource checks use `queriedResources` (resources in loops and functions are checked too).

### Step 2, `ae00ebe`: sandbox bridges
`fetch` and host functions in the sandbox (`__owHost`, the `fetch` shim); `CodeFetcher` in `@ow/connectors` (SSRF guard, manual redirects, size cap, abort); `fetch` wired into code blocks; `CODE_FETCH_ALLOW_PRIVATE_NETWORK`. The flaky "< 10 ms context" check moved to `pnpm --filter @ow/sandbox bench` (its own CI step).

### Step 3, `2a8a35a`: Wait, cancel, error handler
Migration `0007_run_suspend_cancel.sql`; the orchestrator restructured into phases (main, handler) with parked waits; `suspendRun`, `cancelRun`, deadline extension, the reaper honouring cancels; `listenForCancels` in the Dispatcher and InlineRunner; sync webhooks answer 202 when a run pauses.

### Step 4, `920e0b7`: functions and loops
Nested in-memory executions for function calls (`FunctionCallStore`); `loop.ts` (modes, runners, per-item timeout/retries, `onError`); iteration checkpoints with a batching recorder and `RunStore.iterationsFinished`; `blocks.ts` refactored into `runCode`/`runResourceQuery`/`callWorkflowFunction` over a `Work`.

### Step 5, `11e9acc`: Workflow block
`children.ts` (`PgChildRuns`, `waitForChild`, `childResult`); the Workflow block and loop workflow runner; `WaitState` replacing the bare resume time; `wakeParents` on every way a child ends; the `suspendRun` race fix; cancel cascading to children.

### Step 6, `32c9422`: server
Cancel, children and iterations endpoints; child workflows checked (validator `resolveWorkflow`, Use access for draft runs and publishing); the 10-level nesting cap.

### Step 7, `dfe5853`: UI
The open graph in the store (`graph`, `graphOf`, `updateGraph`); `functions.tsx` (Functions tab, function settings, banner); forms for every new block and per-type settings; graph-aware completions (functions, `params`, `fetch`); the run panel's Cancel, waiting notes, iterations list and parent/child links. Found in the browser walkthrough: a cancelled run's wait stayed `waiting` in the editor (now `cancelWaitingBlocks` sends block events).

### Step 8 (this commit): e2e, Compose check, docs
- `apps/web/e2e/advanced.spec.ts`: a loop calling a missing function (Problems shows it, Run disabled); create the function in the Functions tab with a parameter and Monaco code; run; check the loop's sum and its iterations; see the run pause at a Wait; cancel it from the run panel.
- `docker-compose.yml` passes `CODE_FETCH_ALLOW_PRIVATE_NETWORK` (default false).
- README (loops, functions, child workflows, waits, the error handler, cancel; the new API routes; the sandbox bench), `architecture.md` §2.2a (every M5 rule with its tests) and §2.3, this file.

### Totals at the end of M5
`biome ci` is clean. Typecheck passes **9/9**. **518 tests pass** (engine 125, definition 116, server 78, expressions 73, connectors 63, crypto 25, db 20, sandbox 18), plus the two benchmarks (run on their own) and **3 Playwright e2e** (all passed with `--repeat-each=2`).

Bundles: main 576 kB, editor chunk 493 kB.

## 9. How things were verified (and how to repeat it)

- **Unit and integration tests:** `pnpm test`. Each server, db, connector and engine Postgres test file boots its own embedded Postgres. The engine suite was run three times in a row after step 3 with no flakes.
- **Webhook latency:** `pnpm --filter @ow/server bench:webhooks` (prints p50/p90/p99).
- **Sandbox context speed:** `pnpm --filter @ow/sandbox bench` (0.66 ms locally).
- **Playwright e2e (committed):** `pnpm --filter @ow/web build && pnpm --filter @ow/server build && pnpm --filter @ow/web e2e`. Locally it uses the installed Chrome (`channel: 'chrome'`); CI uses Playwright's Chromium. The server runs on port 4387 (`E2E_PORT`). All three specs passed with `--repeat-each=2`.
- **Docker Compose, session 5** (the M5 done-whens; Node scripts `ow.mjs`, `setup.mjs`, `check-loop.mjs`, `check-wait.mjs`, `check-cancel.mjs` in the session scratchpad, not committed):
  - A fresh stack (the session 4 volume was gone), started with `PUBLIC_URL=http://localhost:3000 CODE_FETCH_ALLOW_PRIVATE_NETWORK=true docker compose up -d --build`; admin via `create-admin` with `ADMIN_PASSWORD`; a `shop` database (with a `hits` table) and a `shop` Postgres resource (`statementTimeoutMs` 600000).
  - The three checks in §8, run as draft runs through the API (login with `POST /api/auth/local`, tRPC for setup, `/api/v1` for runs). The lease owner (`<container id>-<pid>-…`) names the container to kill.
  - Afterwards the containers were recreated without the fetch flag.
- **Docker Compose, session 4** (architecture §2.8; scripts in the session scratchpad, not committed):
  - `docker compose up -d --build` with `PUBLIC_URL=http://localhost:3000`; admin via `docker compose exec api node dist/cli/create-admin.js`.
  - Databases `shop_prod` and `shop_staging` in the Compose Postgres with different `orders`; a `shop` Postgres resource configured for both (test connection OK in both).
  - The `orders` workflow (webhook → query → JS → branch → two Responses), published v1.0.0: `curl` with `X-Api-Key` returned the production answer, `?environment=staging` (through the alias `customers/:customerId/orders`) the staging one; no key → 401; `Prefer: respond-async` → 202 + `Location`; the same `Idempotency-Key` twice → the same run, replayed.
  - **`kill -9` of a worker mid-run:** a live run of `a (3 s) → b (25 s) → c` on a worker; while `b` ran, `docker kill -s KILL` on the container holding the lease. The other worker resumed it once the 30 s lease expired; the run succeeded with 1 recovery and epoch 3; `a` ran once (not re-run), `b` re-ran (its first insert rolled back with the killed connection). Note: `docker kill` counts as a manual stop, so `restart: unless-stopped` doesn't restart the container; `docker compose up -d worker` does.
  - **1-minute cron, 2-minute run:** the `slow-cron` workflow (`insert` a hit, then `select pg_sleep(120)`, block timeout 150 s) with schedule `* * * * *`, overlap `skip`, watched for 15 minutes through the database: runs fired at 09:01, 09:04, 09:07, 09:10 and 09:13 (each 120 s; the fire at the minute a run ends is checked just before it finishes, so one starts every 3 minutes), 10 fires were logged as skipped, and a self-join on the runs' start and finish times found **0 overlapping pairs**. The first three runs failed with "statement timeout": a Postgres resource's `statementTimeoutMs` defaults to 120 s and caps the block timeout (M1); after raising it to 180 s, the next two succeeded. Then v1.0.1 turned the schedule off (its trigger kept its id, `next_fire_at` null).
- **Bundled server without Docker:** `node --no-node-snapshot dist/main.js` with `MIGRATIONS_DIR=../../packages/db/migrations` (and `WEB_DIST_DIR=../web/dist` to serve the UI). Restart it after rebuilding the web app: `@fastify/static` lists files once at startup, and stale asset names return the SPA's HTML (a MIME-type error in the browser).
- **Browser walkthroughs** (sessions 3–5, not committed): session 3 used puppeteer-core scripts; sessions 4 and 5 used a temporary Playwright spec reusing `e2e/global-setup.ts` with screenshots read back (session 5: 15 screenshots of every M5 form, functions, a paused run, iterations, the child link and cancel). Gotchas:
  - Typing into Monaco races its auto-closing on slow machines: use `keyboard.insertText` (see `e2e/helpers.ts`).
  - Monaco wraps long lines on screen: rendered text contains extra line breaks.
  - Click empty canvas away from the floating toolbar (top left), controls (bottom left) and minimap (bottom right).
  - "Not published" also matches a button named "Publish": use `exact: true`.

## 10. Local environment quirks (this Mac)

- Node v24.15.0 (arm64). **Docker Desktop 29.8 with Compose v5.6 is installed** (since session 4; 8 CPUs, about 4 GB for Docker). No global pnpm, no system Postgres.
- Run pnpm as **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`**. **Turbo needs a `pnpm` binary on PATH.** In a Claude session, run `corepack enable --install-directory <scratchpad>/bin pnpm` and prepend that directory to PATH. The user can simply run `corepack enable`.
- **Dev database:** `pnpm dev:db` stores its data in `.data/pg` (gitignored), with `DATABASE_URL=postgres://ow:ow@127.0.0.1:5433/optiply_workflows`. It has a `demo_customers` table, a "Demo DB" resource (`demo_db`), and test workflows from session 3, all safe to delete; it's still at migration `0003` and migrates on the next `pnpm dev`.
- **Compose stack** (volume `optiply-workflows_pgdata`, recreated in session 5): holds the session 5 check: a `shop` database (`hits` table), the `shop` resource, draft workflows `loop-10k`, `wait-restart` and `cancel-me` (no schedules or webhooks), and admin `admin@optiply.nl` with a random password kept in the session scratchpad (reset it with `docker compose exec api node dist/cli/create-admin.js --email admin@optiply.nl --name Admin`). Compose reads `.env`, whose `PUBLIC_URL` points at Vite (`:5173`): run it with `PUBLIC_URL=http://localhost:3000` (or change `.env`). It holds port 3000, like `pnpm dev`.
- **`.env`** (gitignored) has `SESSION_SECRET`, `LOCAL_LOGIN_ENABLED=true` and a generated `ENCRYPTION_KEYS=v1:…`. `WORKER_CONCURRENCY` defaults to 4 and `WEBHOOK_INLINE_CONCURRENCY` to 8 when unset.
- **Dev admins (dev database):** `admin@optiply.nl` (password given to the user in session 2) and `m2-smoke@optiply.nl` (session 3, random password; harmless). Set a password with `corepack pnpm --filter @ow/server create-admin -- --email admin@optiply.nl --name Admin` (prompts, or reads `ADMIN_PASSWORD`).
- **At the end of session 5** the Compose stack was left running (nothing scheduled; private-network fetch off); stop it with `docker compose down` (add `-v` to drop its database). The dev database (still at migration `0003`) and dev servers weren't started this session.

## 11. Still unverified

1. **Google SSO** against real Google. This needs an OAuth client with redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the user.

## 12. Known gaps and TODOs carried forward

- **⚠️ Intermittent isolated-vm crash (M5, open):** on this Mac the 10k-iteration crash test passed 6 of 8 standalone runs (about 20 s each). Once, the test process died with **SIGILL**: macOS's crash report (`~/Library/Logs/DiagnosticReports/node-2026-10-14-125546.ips`) shows a stack overflow on an isolated-vm 7.0.1 thread-pool thread, with only isolated-vm frames (13 of them). Once, the first run (alongside another test file) hung for 15 minutes. Not reproduced with 30k sequential or 20-way concurrent evaluations, or 300 rounds of disposing an isolate under load; it has passed in every CI run on Linux so far. In production such a crash kills the worker, and its runs resume elsewhere. Ideas: evaluate all of an iteration's `{{ }}` in one context (a query runner makes one context per template), report upstream with a reproduction, or try a debug build of isolated-vm.
- **Engine:**
  - **Sandbox isolation inside a run:** when the watchdog disposes a run's isolate (a code block stuck in an async loop), other code blocks evaluating at that moment in the same run fail with "Sandbox was reset". Retries absorb it.
  - **Retry backoff sleeps in the worker**, holding a slot. Long backoffs could requeue the run with `availableAt` instead.
  - **Block data isn't scrubbed of secret config values**, only logs and errors are (same rule as Postgres data in M1).
  - `pending` block status is never written.
  - **Paused runs resume on the workers' 5 s poll** (like schedules), so up to 5 s late; children wake their parent at once.
  - **No per-run cap on in-flight `fetch` requests** (the architecture's 50); the shared agent allows 32 connections per origin.
  - **A loop's sync workflow runner holds the worker** while its children run (it waits within the iteration timeout, default 10 s: raise it for slow children); a Workflow block pauses instead.
  - **Renaming a function parameter doesn't rewrite `params.x`** in its blocks (renaming functions and blocks does).
  - The `suspendRun` race fix (a child ending just before its parent pauses) has no test; the window is too narrow to hit reliably.
  - A webhook run executing in the API process is resumed by a worker if the API dies (lease); the caller's sync request just fails. That's expected; noted for ops docs.
- **Webhooks:** API key only (no public or HMAC-signed webhooks, no `?api_key=` query parameter); no rate limiting; no OpenAPI document for the public REST routes yet. API keys can read single runs, not list them.
- **Scheduler:** fires up to 5 s late (tick interval); a skipped fire (overlap `skip`) is only logged, not recorded as a run; the catch-up after very long downtime of a dense cron steps through at most 10k fire times.
- **Pool invalidation across processes:** there's still no `NOTIFY resource_changed`. Pooled clients are keyed by the config's `updatedAt`, so changes take effect on the next load.
- **Postgres `describe()`** leaves one named prepared statement per query on the connection until postgres.js recycles it.
- **Tests not written yet:** the OIDC callback logic (extract the claim checks into a pure function). The web app has no unit tests; it's covered by the three Playwright tests and the (uncommitted) walkthroughs.
- **Web:**
  - No toast system; `confirm()` is still used for destructive actions (the new `Dialog` could replace it).
  - The main bundle is 576 kB; the editor and Monaco are split out, the other pages aren't.
  - The editor has no undo/redo across blocks, no copy/paste of blocks, and no "create function from selection". No release diff view yet (`releases.get` returns the definition for one). Functions can't be test-run on their own yet (their params' `testValue` is stored but unused).
  - The run panel's logs tab shows the first 500 lines. The resources playground still uses textareas.
- **Editor completions** cover the latest finished run only; there's no environment choice for them.
- **Not built yet:** MySQL, BigQuery and multipart REST bodies (M6); `oauth_tokens` (M9); retention (M6); User Tasks (M6).

## 13. Next step: M6 Hardening

From `architecture.md` §2.7: MySQL and BigQuery connectors, OAuth2 client-credentials (REST already has it; see whether M6 means more), retention (a daily batched delete of runs older than 30 days), an audit UI, Prometheus `/metrics`, a backup runbook, and User Tasks with an inbox. **Done when:** retention runs without long locks; a User Task resumes its run.

Already in place:
- A User Task can reuse M5's waiting machinery: a block that parks with a `WaitState` (it could hold a task id the way a Workflow block holds `childRunId`), and something that wakes the run (`wakeParents` shows how: set `available_at` to now and NOTIFY).
- `block_runs` and `block_run_payloads` cascade from `workflow_runs`; loops can add up to 100k rows per run, so retention should delete in batches by run.
- The audit log already records workflow, release, run and cancel events (`recordAudit`).

Watch out for:
- The isolated-vm crash (§12) before relying on long loops in production.
- Retention must not hold long locks on `workflow_runs`, which is the queue.

## 14. How to start the next session

```bash
cd /Users/optiply/optiply-workflows
git fetch && git status                          # PR #6 merged? Then: git switch main && git pull
gh pr view 6                                     # ready for review → merge (merge commit), if not done yet
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm dev:db &                           # Postgres on :5433
corepack pnpm --filter @ow/server dev &          # API + worker on :3000 (auto-migrates; needs ENCRYPTION_KEYS in .env)
corepack pnpm --filter @ow/web dev               # http://localhost:5173
git switch -c feat/m6-hardening                  # then open a draft PR after the first commit
```
