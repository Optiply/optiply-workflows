# Session handoff

What has been built, how, and where to pick up. **Read this first in a new session**, then the matching milestone in [architecture.md](architecture.md), which holds the full Retool analysis, the design decisions and the roadmap (M0–M12, M13+ to choose from).

Last updated: 2026-10-17 (session 12: the CI timeouts fixed as an engine race, PR #13 reviewed and merged, M12 (Python) planned with the user).

| | |
|---|---|
| **Branch** | `feat/m12-python` (M12, from `main` at `ee42bc7`). M11 was built on `feat/m11-git-sync` (the plan, 6 steps of which 4 and 5 in two commits each, an engine fix and the review fixes) |
| **PR** | [#14 M12](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/14), draft. Before: [#13 M11](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/13), reviewed before merging (10 fixes, `a492ed0`), merged by the user as `ee42bc7`; CI green on `main` |
| **`main`** | `ee42bc7`, the merge of PR #13 (M11 with its engine fix and review fixes). Milestones are merged with merge commits so the step commits stay in history. **The user merges PRs** (Claude Code's permission check refuses `gh pr merge` from a session). |
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
| **M5 Advanced blocks** | ✅ On `main` (§8) |
| **M6 Hardening** | ✅ On `main` (§9), merged in session 7 after a review pass (7 fixes, `41cad4a`) |
| **M7 Database** | ✅ On `main` (§9a), merged at the start of session 8 |
| **M8 App builder** | ✅ On `main` (§9b), merged in session 8 after a review pass (10 fixes, `cefd37a`). The done-when (build a CRUD app on a Postgres table with an editable Table and a save query) proven in Playwright and on Docker Compose. |
| **M9 OAuth** | ✅ On `main` (§9c): PR #10, then its review fixes as PR #11 (10 fixes, one of them security: tokens could be sent to another host). The done-when proven in Playwright and on Docker Compose. |
| **M10 Finishing apps** | ✅ On `main` (§9d): the sandbox in a Worker, Table paging/sorting/search (server-side through `sql.column`/`sql.direction`), multipage apps, folders for workflows and apps. PR #12, reviewed before merging (10 fixes, `6c95f5a`). The done-when proven in Playwright and on Docker Compose. |
| **M11 Git sync** | ✅ On `main` (§9e): workflows and apps in a GitHub repo (code and SQL as files), protection, branch drafts in the editors, Commit and pull requests, deploy on merge (webhook and polling). PR #13, reviewed before merging (10 fixes, `a492ed0`), plus an engine race found through its CI (`25218f0`). The done-when proven in Playwright and on Docker Compose. |
| **M12 Python** | 🚧 On `feat/m12-python` (§9f), PR #14: planned in session 12 (§14, `architecture.md` §2.14); steps 1 (the executor), 2 (the definition) and 3 (engine and server) built |

**Start the next session with:** M12 step 1 (§14): the executor spike and service, unless it's already pushed (check the draft PR's checklist).

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

### Taken in M6 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M6** (PR #7's "Defaults"):
  - **User Task forms are fields in the block** (text, long text, number, checkbox, choice) with outcome buttons; an app-based form can come with M8.
  - **Assignees are users (by email) and groups (by name)**, templatable; any of them can complete the task, admins always can.
  - **BigQuery was tested against a fake API only**; a real-project check waits for a service account.
  - **The isolated-vm crash was step 1**, timeboxed.
- **isolated-vm:** the upstream fix (laverdet/isolated-vm#574, unreleased in 7.0.1) is applied with `pnpm patch` (`patches/isolated-vm@7.0.1.patch`), which also makes the package compile from source on install. **Drop the patch once a release (7.0.2+) has the fix.**
- **`.pnpmfile.cjs` strips drizzle-orm's optional peers** except `postgres` and `pg`. Without it, any package bringing one of them (mysql2, `@opentelemetry/api` via prom-client) forks drizzle-orm into a second instance and the server's types break against `@ow/db`'s.
- **Connectors:**
  - MySQL: mysql2 server-side prepared statements, arrays expanded into lists (`IN ({{ ids }})`; empty → `NULL`), objects as JSON, `KILL QUERY` from a side connection on cancel and timeouts, `transaction_read_only` sessions, LOAD DATA LOCAL refused, TLS `require` by default (mysql2 has no `prefer`), `DATE`/`DATETIME` as stored strings, `TIMESTAMP` as UTC instants, `BIGINT` as numbers unless past 2^53. `{{ }}` values are evaluated before MySQL sees the SQL (Postgres describes first).
  - BigQuery: the REST API with undici (**not** `@google-cloud/bigquery`: ~30 packages for four calls); service-account JWT; the key's own `token_uri` is ignored; our own job id (`ow_<uuid>`) so cancel always finds the job; `maximumBytesBilled` 10 GiB by default; labels = the resource's + `ow_source`, `ow_workflow`, `ow_run`, `ow_environment`, `ow_trigger` (or `ow_user` from the playground); null parameters are NULL STRINGs; objects JSON text.
  - `QueryContext.labels` / `RunOptions.labels` carry who runs a query; only BigQuery uses them so far.
- **Retention:** `RUN_RETENTION_DAYS` (default 30, `0` off); daily per 24 h from the first check, not at a fixed time of day; ≤ 5,000 rows per statement, each its own transaction; runs with an unfinished child are kept; one worker a day wins `maintenance_jobs` (an atomic upsert, no lock held while it works).
- **User Tasks:**
  - One `out` port: branch on `task.data.outcome` (outcome ports like Branch conditions would be more editor work).
  - Field defaults only fill the form in; an omitted field is `null`.
  - No due time → no expiry, but the run rechecks its task hourly as a safety net.
  - Assignees are resolved (and fixed) when the task opens; literal ones are also checked before runs and publishing (`unknown_assignee`).
  - Visibility: assignees and admins see and complete; people with Use on the workflow see but can't complete; anyone else gets 404.
  - Completing locks the run row first, so a pause and an answer can't miss each other (`suspendRun` also looks for completed tasks). Runs ending any other way close their open tasks.
- **Metrics:** `/metrics` on the API port; workers serve it (and `/health`) on `METRICS_PORT` (9464); open unless `METRICS_TOKEN` is set. Database gauges are the same in every process: dashboards use `max`.
- **Audit export:** admins, ≤ 100,000 rows, streamed; formula-like cells get a leading `'`; exports are audited.

### Taken in M7 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M7:**
  - **Tables live in the platform's Postgres**, one schema per environment (`owdb_<env>`), each owned by its own locked-down role.
  - **The schema editor has the core DDL set:** create/rename/drop tables (auto `id bigint` identity key), add/rename/drop columns, type change with a cast, nullable/unique/default. No foreign keys or indexes yet; raw SQL is always there through a query.
  - **The grid is TanStack Table** (Glide Data Grid only supports React ≤ 18). v8.21.3, not v9 (new API, days old); TanStack Virtual 3.14.13.
  - **Access (step 2): Use on `optiply_db` in an environment is all of it** (rows, schema and SQL), because Use on any resource already allows any SQL with its rights. A read-only tier (a SELECT-only role and a second resource) was offered and deferred.
- **The role logs in with its own password; never `SET ROLE`.** A query can switch back mid-statement (`set_config('role', …)` + dynamic SQL like `query_to_xml`), since the session user may always return to itself. The password is in `optiply_db`'s `resource_configs.secrets` (so `rekey` covers it) and goes to Postgres as a SCRAM verifier computed in Node.
- **Provisioning runs at every start** (migrate role and API), under advisory lock `727002`, and repairs: role attributes and password, roles granted to it (revoked), schema/object owners (a restore), `CREATE` on `public` before PG 15. Needs superuser or `CREATEROLE`; without, a warning and the platform runs on. A non-superuser can't even write `NOSUPERUSER`/`NOCREATEDB`/… in `ALTER ROLE`, so those are checked instead; it gets `GRANT <role> TO current_user` to own things on the role's behalf.
- **Role names carry a tag of the database name** (`owdb_<md5[:6]>_<env>`), because roles are cluster-wide; stored in `managed_databases`, so a renamed database keeps its roles.
- **The built-in resource** (`resources.system_kind = 'database'`, slug `optiply_db`, type `postgres`): can't be renamed, reconfigured, deleted or tested with other settings (that would send the stored password elsewhere), admins included. Listed after people's own resources, so new query blocks keep defaulting to theirs (CI caught it).
- **Rows:** values travel JSON-exact (bigint/decimal strings, datetimes ISO in UTC: transactions set `TimeZone` UTC, dates `YYYY-MM-DD`, JSON as JSON) and are **sent as text and cast in SQL** (`$n::text::<type>`): postgres.js otherwise converts booleans ('true' became false), dates (throws in JS) and JSON (stringified twice) once it knows the type. Writes by a single-column primary key only. Row writes are audited without values.
- **Schema changes** wait at most 5 s for locks (`lock_timeout`), 120 s per statement.
- **CSV:** our own RFC 4180 parser (lenient like spreadsheets about stray quotes). Imports: one line of JSON spec then the file in the body (`application/x-ow-csv-import`), all rows or none, ≤ 50 MB / 500k rows, problems by line and column (≤ 20). Empty values are NULL. Date order DMY unless the file shows MDY. Exports guard formulas in text cells only (numbers stay numbers). `previewCsv` is a mutation (a 256 kB sample can't go in a URL).

### Taken in M8 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M8** (PR #9's "Decisions"):
  - **App expressions run in the browser** (Retool's way); queries still run on the server.
  - **Use on an app is enough to run its queries.** Queries are stored in the app; the browser sends a query's name and its `{{ }}` values, never SQL. The publisher vouches for the resources (Use everywhere).
  - **Apps get releases like workflows** (draft, autosave, semver publish, rollback; viewers see the live release).
  - **Components: the CRUD core plus a chart** (Table, Form, Text/Number/Date inputs, Select, Checkbox, Button, Text, Container, Modal, Chart).
- **Libraries:** react-grid-layout 2.2.4 (MIT; 2.3.0 was days old), Chart.js 4.5.1 (MIT, one MIT dependency; not Recharts, which brings Redux and d3), vitest for the web app's pure modules.
- **The sandbox:** a hidden iframe with `sandbox="allow-scripts"` (opaque origin) and its own CSP `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'` (no requests at all), talking to the page over a MessageChannel handed over once (`ow:connect`). It runs on the page's thread, not a Worker (worker scripts in an opaque-origin frame can't be loaded the same way in dev and production): **an infinite loop in app code freezes the tab** (it can't escape the sandbox). The sandbox's script is bundled by esbuild in a Vite plugin (`apps/web/vite/app-runtime.ts`, `virtual:app-runtime`) and written into the frame with the stdlib (`@ow/sandbox/stdlib`).
- **`current_user` in queries is filled in by the server:** a `{{ }}` reading only `current_user` (and JS/stdlib globals) is evaluated in the server sandbox; the browser's value is ignored. One mixing `current_user` with app values is refused (`mixed_current_user` in the validator, and by the server). `expressionSide` / `browserExpressions` in `@ow/app-definition` are the shared rule.
- **App query access:** draft runs need Edit on the app and Use on the resource in that environment; live runs need Use on the app, and **a release that is no longer live is refused** (CONFLICT, a Reload banner). Only **manual (write) queries are audited** (`app.query_run`, without values); automatic reads re-run as people type.
- **Definition:** every string is a template; components, queries, transformers and variables share one namespace; the layout is kept apart but **counts in the hash** (a move is a change people see). Dependencies are per property (`freeIdentifierRefs(…, { properties: true })`). Input state restarts only when its default's value changes; variables evaluate once; transformers are synchronous (`sync-function-body`); calling a method from a reactive value is an error (`code_only`); modals can't sit inside other components.
- **Runtime:** automatic queries re-run 100 ms after their inputs settle; a newer run's result wins; manual and JS query failures notify once, automatic ones only keep `query.error`. Form submit checks required inputs (the form is `noValidate`) and resets only when every handler succeeded; a table's `saveChanges` likewise clears the changeset only on success. `setHidden` overrides the prop's template until reload.
- **Typing never jumps back:** `set` messages carry a sequence number the sandbox acknowledges (`ack`); until then the page ignores values for those keys still coming from the sandbox (message order over the port makes this exact).
- **Editor:** the running draft follows edits (`update` message) 300 ms after they stop, carrying over typed values, query results and variables; automatic queries re-run only when they or their values changed. Queries save the draft first (`beforeQuery: ensureSaved`): the server runs what's saved. Positions are committed on drag/resize stop (opening an app never dirties it). No dragging between containers ("Inside" moves a component). JSON and number fields keep the text as typed (`useParsedText`): parsing never reformats it under the cursor.
- **Table:** edits are keyed by the primary key (rows without one can't be edited); the key column is never "changed"; all of `data` is read (no server-side paging yet).
- **Chart:** the dataviz skill's reference categorical palette, in its validated order (validated on our white surface; three slots under 3:1, hence the Table view), never cycled: past 8 series (7 pie slices) they're named or folded into "Other". Light mode only.
- **From the PR #9 review:** moving a workflow or app between folders needs Own, into a folder of its own type only, and folder grants count only for their own type; app queries run with `untrustedValues` (REST path values encoded per segment); the editor fetches the draft fresh per visit and loads it once; the viewer keeps the release it opened (a newer one shows through the Reload banner); confirmations queue.
- **`"sideEffects": false`** on `@ow/definition`, `@ow/app-definition`, `@ow/expressions` and `@ow/app-runtime`: unused zod schemas no longer ship (the sandbox script 649 → 187 kB, the main bundle 590 → 414 kB).

### Taken in M9 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M9** (PR #10's "Decisions"):
  - **Shared accounts, per-user optional** (Retool's model). A resource's `tokens` is `shared` (someone with Edit connects one account per environment; every query uses it, webhook and schedule runs included) or `perUser` (each person connects their own; used by the playground, apps and their own draft runs; workflows on it can't be published).
  - **Custom auth flows are part of M9.**
  - **Presets for Google, HubSpot, Slack and Microsoft 365.** No live provider check yet: the user had no OAuth app credentials (§12).
- **One callback for every resource:** `<PUBLIC_URL>/api/oauth/callback`. State, the PKCE verifier, the person and the consent fingerprint sit in a signed HttpOnly cookie named after the state (`ow_oauth_<state[:16]>`, path `/api/oauth`, 10 min, SameSite=Lax); the callback needs it, the same state and the same person's session, and re-checks access and the consent settings. The flow ends on a server-rendered page that posts `ow:oauth` to the opener (`PUBLIC_URL`'s origin only) and closes; the web app opens it in a popup (`lib/oauth.ts`).
- **Access:** connecting or disconnecting the shared account needs Edit on the resource in that environment; one's own needs Use, or Use on an app whose live release queries the resource (`appId`; app viewers have no resource access). A resource is either shared or per-user, never both.
- **Connectors never hold user tokens:** `QueryContext.credentials` (`CredentialSource`: `accessToken({ force })` for OAuth, `authVariables({ force })` for custom flows) is supplied by the server (`credentialsFor` in `services/oauth-tokens.ts`); `runQuery` scrubs everything it hands out. A 401 forces one refresh and a retry.
- **Storage:** `oauth_tokens` (migration `0013`), encrypted JSON in `tokens` (AAD `oauth_tokens:<id>:<env>`; in `ENCRYPTED_COLUMNS`, so `rekey`/`verify-secrets` cover it). Refreshes, sign-ins and connects take a transaction-scoped advisory lock per owner (`withRefreshLock` in `services/refresh-lock.ts`): waiters try the lock and sleep outside any transaction, so only the one refreshing holds a pooled connection (during the provider call). Whoever waited uses what the other stored; a forced refresh is skipped when the stored token or variables are no longer the ones the failing request used.
- **Refused refreshes** (`invalid_grant` and Slack's equivalents) mark the row `reconnect`, committed, and are audited (`resource.oauth_refresh_failed`); other provider errors leave it. No refresh token: an expired token needs a reconnect; a refused one is sent back unchanged (the API's own 401 shows).
- **Consent fingerprint** (`consentHash`): authorize and token URLs, client ID, trimmed scopes, sorted non-empty consent parameters, the token mode, and **where tokens go** (the base URL's origin and the allowed hosts), not the secret, PKCE or client auth; for custom flows (`customFlowHash`) the base URL, allowed hosts and the steps. `saveConfig` deletes the config's tokens when it changes; reads (and tests of unsaved settings) refuse a mismatch, so nobody with Edit can point a resource elsewhere and receive its token.
- **Whose account:** the engine got `actingUserId` (the person who started a draft run; null for runs of a release); app queries use the viewer; the playground the caller. Publishing and rollback refuse workflows querying a per-user resource in any environment.
- **`auth_required` errors** carry `{ reason, account: shared|user, resourceId, environmentId }`; the UI turns them into Connect / Reconnect prompts (`components/auth-required.tsx`), and apps re-run their failed **automatic** queries after connecting (manual ones wait for the person).
- **Custom flows:** steps `request` (a REST query through the resource's base URL, allowed hosts and network settings, without its default headers, parameters or auth), `code` (sandbox, 30 s), `variable` (`auth.<name>`; `secret: false` keeps it out of the scrubbing, for values like a tenant id); `secrets.NAME` from the new secret `values`; refresh steps merged over the current variables, falling back to signing in; `ttlSeconds`; one shared set of variables per config (no per-user flows, no form step). Each process has a sandbox for flows (the API's; the worker creates one).
- **REST requests are assembled the same way for every auth type** (`prepareAttempt`, `attemptHeaders`, `attemptUrl`): the resource's default headers and parameters (rendered with `auth` for custom flows), the secret headers, the query's own (which override the defaults), then the credentials. On a cross-origin redirect, credentials and defaults that use `auth` are dropped.
- **Token endpoints follow redirects on the same origin only** (re-sending the POST; at most 5): the request carries the client secret. Before M9, client credentials followed any redirect. A string `expires_in` is read as a number.

### Taken in M10 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M10** (PR #12's "Decisions"):
  - **M10 is finishing apps**, all four parts: the sandbox off the page's thread, Table paging, multipage apps, folders for workflows and apps. Python, SQS/Kafka, Git sync, multiplayer editing and AI actions moved to M11+.
  - **Multipage apps are global + page-scoped** (Retool's model): one namespace; page-scoped automatic queries run only while their page is open.
  - **Server-side sorting uses a safe helper** (`sql.column`/`sql.direction`, checked on the server), not the CASE-per-column pattern.
  - **Tables have no search box by default** (a prop turns it on).
- **The sandbox:** the iframe starts a Worker from a blob: URL holding the stdlib and runtime (CSP `worker-src blob:` added, nothing else); the Worker inherits the frame's CSP. Spiked in Chrome 155, Firefox 157 and WebKit 27.2 (fetch cors/no-cors/data:, sync and async XHR, WebSocket, EventSource, `importScripts`, `import()`, nested and http workers, IndexedDB all refused; a server recording every request received none; a control run without `default-src 'none'` let them all through). The Worker refuses to start if `fetch('data:,')` isn't blocked. The page talks to the Worker over the same MessagePort, passed on by the frame. A srcdoc frame inherits any page CSP too (none today).
- **Watchdog** (`runtime/watchdog.ts`, pure): a ping a second, one unanswered for 5 s means stopped; a tick later than twice the interval (background tab, sleep) starts a new ping instead, so throttling never stops a working app. Stopping removes the frame (which ends the Worker) and shows `AppStopped` with Restart (a fresh start: typed values and results are lost, the console kept); in the editor an edit restarts it. Replies go only to the port that asked (a restarted sandbox reuses request ids).
- **SQL fragments:** `{{ sql.column(value, ['a', 'b'], 'fallback') }}` and `{{ sql.direction(value) }}` must be the whole `{{ }}`, the list string literals (`sqlFragment`); the connector re-checks the value (the helper's own result: a listed column or the fallback; empty means the fallback) and quotes it per dialect, before the statement reaches the database (`resolveFragments`). `sql` is a stdlib global, so a reserved name (like `url`): entities and blocks named so must be renamed.
- **Table:** `paging` `scroll` (default) / `pages` / `server`; `pageSize` 50 (`pageSizeOf` shared with `pagination`); `search` (off); `totalRowCount`. State `page`, `sort` (`{ column, desc }`), `searchText`, and the derived read-only `pagination` (`{ page, pageSize, offset }`, a graph node kind like a form's `data`). `setPage`/`setSort`/`setSearchText` and `pageChange`/`sortChange`/`searchChange`; sort and search go back to page 0. The search box writes with the acknowledged `set`. In the browser modes the pure `tableView` searches the shown cells (case and accents ignored), sorts and pages.
- **Pages:** optional `pages` and `page` (**no schema v2**: an app without pages is one page holding everything). `page` on top-level components, queries and transformers; components in containers take their container's; variables are global. Code on a page reads globals and its page's; global code only globals; handler targets likewise (`other_page`). `url` is a built-in graph entity (`url.page`, `url.params`). `edit` can't name a page. Automatic queries on a closed page mark themselves stale (also when their timer fires after the page closed) and run when it opens; run-on-load queries run each time their page opens.
- **Page URLs:** one viewer route `/apps/$slug/{-$page}` (two routes remounted the app between pages); **search params are plain text router-wide** (`URLSearchParams`, not TanStack's JSON). `url.params` is the query string without `env`, and `env` is stripped from `openPage` params too (app code can't switch the environment). The viewer passes the URL to the host (`start`, then `navigate`); `utils.openPage` and Navigation links go through `host.openPage` (the viewer navigates; the editor's host moves in place).
- **The editor's pages:** the page being edited is the store's `url`; the draft follows it, and the host re-sends it after every definition update (a page added or renamed is navigated to before the draft has it). The first page added to a one-page app puts everything on `page1`. New components, queries and transformers go on the edited page. The canvas has the frame grid (global) above the page's.
- **Folders:** `folders.*` per type (`resource` by default); `list` returns `{ folders, canManage }`; managing a type's folders needs that type's create right; folder grants stay admin-only, and for workflow/app folders they apply to every environment (a one-environment grant is refused). `components/folders.tsx` is shared by the three lists. Moving still needs Own.
- **e2e users:** `e2e-member@optiply.nl` isn't an admin (made with the CLI, then removed from the admins group in the global setup).

### Taken in M11 (keep these unless there's a reason to change)
- **Agreed with the user at the start of M11:** Git sync the Retool way (protected objects on branches, reviewed in pull requests, deployed on merge); GitHub (plain git for content, its API for pull requests, its push webhook); code and SQL split out into files; workflows and apps only (not resources, folders or config vars). Python, SQS/Kafka, multiplayer and AI actions move to M12+.
- **Decided while building it** (told the user in the step reports):
  - **Protection takes effect at once**, not when the protect PR merges (main would drift meanwhile). Unprotect (Own) undoes it; the directory stays in the repo and stops deploying (`not_protected`).
  - **Writing to the deploy branch is the right to deploy**: deploys check everything publishing does except people's grants. Releases made by Git sync have no `created_by`, carry `git_commit`, and their notes are the commit subject, or the PR title and number for GitHub merge commits.
  - **Admins keep an emergency rollback** (Make live on a protected object; audited `emergency: true`). It stays until a deploy that changes the object's directory, or an admin's Deploy now: a merge touching only other objects leaves it (session 12, from the PR #13 review; the text had said "the next deploy").
  - **The deploy branch never takes a draft or a protect commit**: changes reach it through pull requests only (refused on the server). Protecting again picks a free branch name (`protect/<kind>-<slug>-2`, …) when an earlier protect left one.
  - **A directory removed from the branch doesn't delete the object** (`missing`); a slug held by an unprotected object isn't touched; one broken directory doesn't stop the others; no `ow.json` deploys nothing; an object deleted on the instance comes back on the next deploy.
  - **`maxConcurrentRuns`, folders and grants stay on the instance**; a workflow's name and description are in the repo.
  - **Empty workflow layouts aren't kept** in the repo; an app's layout is kept exactly (it counts in its hash). Files end with one newline that reading takes off.
  - **Update from branch replaces** the draft (no merging of both sides' edits).
  - **A branch-draft snapshot has no foreign key** to its draft (runs outlive a discarded draft).
- **The git client** uses plumbing only on a bare cache per process (no working tree), a fast-forward push, the token through `GIT_ASKPASS`, only https (plus http/file with `GIT_ALLOW_INSECURE_URLS`), no redirects, no hooks or credential helpers; a repo on another host needs the token again.
- **Tests run git for real**: local bare repos (`file://`), `git http-backend` behind basic auth for the token path, a fake GitHub (`apps/server/test/fake-github.ts`) that merges PRs for real and can send signed push webhooks; the e2e setup starts both.

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

## 8. What M5 built (on `main`)

**Done-whens**, proven in tests and on the Compose stack (§10):
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

### Step 8, `77faf90`: e2e, Compose check, docs
- `apps/web/e2e/advanced.spec.ts`: a loop calling a missing function (Problems shows it, Run disabled); create the function in the Functions tab with a parameter and Monaco code; run; check the loop's sum and its iterations; see the run pause at a Wait; cancel it from the run panel.
- `docker-compose.yml` passes `CODE_FETCH_ALLOW_PRIVATE_NETWORK` (default false).
- README (loops, functions, child workflows, waits, the error handler, cancel; the new API routes; the sandbox bench), `architecture.md` §2.2a (every M5 rule with its tests) and §2.3, this file.

### Totals at the end of M5
`biome ci` is clean. Typecheck passes **9/9**. **518 tests pass** (engine 125, definition 116, server 78, expressions 73, connectors 63, crypto 25, db 20, sandbox 18), plus the two benchmarks (run on their own) and **3 Playwright e2e** (all passed with `--repeat-each=2`).

Bundles: main 576 kB, editor chunk 493 kB.

## 9. What M6 built (on `main`)

Merged in session 7 as `b9cbaaf`. Before merging, a review of PR #7 found seven issues, fixed in `41cad4a`: a late MySQL `KILL QUERY` could hit another query on a reused connection (killed connections are now dropped, and a kill that can't be sent ends the wait); MySQL session setup is awaited and fails the query clearly (a MariaDB 10.11 check showed the old code was safe only by accident); retention could delete the current draft's snapshot; a rerun User Task block failed if an assignee had gone since; answers past a task's due time were accepted; the audit CSV export didn't end on a failed page (the "hang on abort" didn't reproduce on Node 24); `until` dropped the last microseconds.

**Done-whens**, proven in tests and on the Compose stack (§10):
- **Retention runs without long locks:** `packages/engine/test/retention.test.ts` deletes 40 old runs with 100,000 block rows and payloads and 2,000 logs while a second pool keeps queueing, claiming and finishing runs and a third samples `pg_locks` and `pg_stat_activity` every 10 ms: 0 lock waits, every statement ≤ 5,000 rows, longest ~25–30 ms locally (~250–340 ms on a busy CI runner; the bound is 1 s), the queue never stalled. On Compose: the same 100,000 rows deleted by the daily job in 3.5 s (longest statement 134 ms) while 4,347 runs went through the API (p50 33 ms, p99 61 ms); 1,558 samples, **0 lock waits**, oldest open transaction 103 ms.
- **A User Task resumes its run:** `packages/engine/test/tasks-pg.test.ts` "a run waits for its task, and completing it resumes the run, even with no worker running at the time" (workers stopped, the task answered, a new worker resumes the run in < 5 s), plus `apps/web/e2e/tasks.spec.ts` through the UI. On Compose: a run waiting on its task survived `docker compose down` (Postgres included, ~20 s) and `up`; completing the task afterwards resumed it, and it succeeded **127 ms later** with the answer.

### Step 1, `8d271ab`: the isolated-vm crash
The intermittent SIGILL from M5 is isolated-vm 7.0.1's timer thread draining expired timers recursively (one stack frame per timer; every eval with a `timeout` leaves one behind until it would have fired). Reproduced every time (5,000 timers expiring together crash; 2,000 don't). Fixed upstream in laverdet/isolated-vm#574 (merged 2026-09-26, unreleased); applied with `pnpm patch`, which also makes isolated-vm compile from source (≈ 16 s here, ≈ 64 s in CI; Xcode CLT locally, `python3 make g++` in the Docker build stage). The Dockerfile drops the ~80 MB of build intermediates. Regression test `packages/sandbox/test/ivm-timers.test.ts` (a child SIGSTOPped until 20k timers expire; SIGILL unpatched). The 10k-loop crash test then passed 8/8 (was 6/8).

### Step 2, `f8dde88` (+ `804f968`, formatting): MySQL
`compileSql(…, 'mysql')` (`?`, MySQL quoting and comments, `offsets` to expand arrays), `packages/connectors/src/mysql.ts`, `@ow/connectors/testing` (a throwaway `mysql:8.4` container or `MYSQL_TEST_URL`; skipped without Docker except in CI), 24 connector tests + 4 server tests, `lib/resource-types.ts` in the web app (`isSqlType`, badges), the shared SQL settings form. Found: Node network errors carry a negative `errno`; the process list shows prepared statements with values substituted (MySQL rebuilds the text for display; `performance_schema.prepared_statements_instances` shows the `?`).

### Step 3, `8f9cd7c`: BigQuery
`compileSql(…, 'bigquery')` (`@pN`, GoogleSQL strings incl. triple-quoted/raw/bytes, `@@system` allowed), `packages/connectors/src/bigquery.ts` (REST + undici, JWT sign-in, jobs.insert + getQueryResults + jobs.cancel, typed parameters and values), a fake API (`test/bigquery-fake.ts`, 17 tests, mutation-checked), engine and playground job labels, the BigQuery settings form. Checked against Google's discovery document and the real token endpoint (a throwaway key: "Invalid grant: account not found").

### Step 4, `643a50a` (+ `2339aa3`, CI headroom): retention
`packages/engine/src/retention.ts` (`deleteOldRuns`, `claimMaintenanceJob`, `RetentionJob`), migration `0008_retention.sql` (`maintenance_jobs`, `workflow_runs_finished_idx`), `RUN_RETENTION_DAYS`. A naive single cascading DELETE was tried as a mutation: one ~300 ms transaction for these rows (it grows with the backlog), caught by the exact-count assertions.

### Step 5, `fc87046`: User Tasks in the definition and engine
The `userTask` block and its validator rules, `checkTaskSubmission`, migration `0009_user_tasks.sql`, `PgUserTasks` / `completeTask` (`packages/engine/src/tasks.ts`), `WaitState.taskId`, open tasks closed when runs end, `suspendRun` checking completed tasks. 7 Postgres tests (dispatchers polling once a minute, so a prompt resume can only come from the wake-up), mutation-checked on both wake paths.

### Step 6, `cbda185`: the Inbox and the task API
tRPC `tasks` (list, openCount, get, complete), literal assignees checked before runs and publishing (`resolveAssignee`), the Inbox (`/inbox`, sidebar badge, To do/Done, everyone's tasks for admins), the task page (form, browser-side checks, answer view), the User Task form in the editor, run-panel links. 4 server tests and a browser walkthrough.

### Step 7, `666cdcb`: operations
`apps/server/src/metrics.ts` (prom-client 15.1.3; `RunObserver` and `Scheduler.onFire` hooks in the engine), audit filters, facets and the streamed CSV export (`api/audit.ts`, `services/audit-log.ts`), `verifySecrets` + `dist/cli/verify-secrets.js`, `docs/runbooks/backup.md` with a restore drill run on Compose (§10).

### Step 8 (this commit): e2e, Compose check, docs
- `apps/web/e2e/tasks.spec.ts`: edit a User Task in the editor (autosave), run it, follow the run panel to the task, see it in the Inbox, a required field refused, answer it, and the run's next block uses the answer.
- The Compose check of both done-whens (§10), the runbook's warning about killing side processes in the Postgres container, `architecture.md` §2.2a/§2.3/§2.5/§2.8, this file.

### Totals at the end of M6
`biome ci` is clean. Typecheck passes **9/9**. **615 tests pass** (engine 137, definition 124, connectors 104 incl. 24 MySQL and 17 BigQuery, server 95, expressions 91, crypto 25, db 20, sandbox 19), plus the two benchmarks (run on their own) and **4 Playwright e2e** (all passed with `--repeat-each=2`).

Bundles: main 488 kB, editor chunk 320 kB.

## 9a. What M7 built (on `main`)

**Done-when** (create a table, import a CSV, query it from a workflow), proven:
- `apps/web/e2e/m7-done-when.spec.ts`, all in the browser: a table made with the schema editor, a `;` CSV appended with the import wizard, a workflow whose query block picks `optiply_db` returns the matching rows.
- `apps/server/test/database-workflows.test.ts` with a real worker: the same workflow returns production's rows in production and staging's in staging; `public.users` is refused from a workflow; Use is checked per environment.
- On Docker Compose (§10): the same, on Postgres 18 with SCRAM auth.

### Step 1, `b4d26e8` (+ `7601334`): provisioning
Migration `0010` (`managed_databases`, `resources.system_kind`), `apps/server/src/services/database.ts` (`provisionDatabases`, `connectionTarget`, `scramVerifier`), the built-in resource guards in the resources router, startup calls in `buildApp` and the migrate role. 10 tests (`database.test.ts`), including the role escapes, a simulated restore, a hand-granted `pg_read_all_data` taken away, and a non-superuser with `CREATEROLE` on a fresh database. The follow-up lists built-in resources last (the editor e2e had picked `optiply_db` as the new block's default).

### Step 2, `9e8343b`: schema API
`services/managed-db.ts` (types, defaults and `parseDefault`, `withManagedDb`, DDL builders, `alterColumn` all-or-nothing), the `database` router. 13 tests (`database-schema.test.ts`), including a busy table failing with CONFLICT in ~5 s.

### Step 3, `720dc16`: rows API
`services/managed-db-rows.ts` (`readRows`, `selectionSql`, `insertRow`, `updateRow`, `deleteRows`, per-field checks in savepoints). 13 tests (`database-rows.test.ts`). The postgres.js parameter conversion problem was found here.

### Step 4, `c1c1fda`: CSV
`services/csv.ts` (parser, `detectDelimiter`, `columnNames`, `guessCsv`), `services/managed-db-csv.ts` (`ImportSpec`, `importCsv`, `exportCsv`), `api/database.ts` (the two streamed routes), `api/streaming.ts` (`drainOrClose`, shared with the audit export). 16 parser tests (incl. the same records for every chunk size, which caught a line count bug) and 13 route tests (incl. 50,000 rows and an export re-imported into an equal table).

### Step 5, `4e3df1f`: the Database page
`apps/web/src/pages/database/` (`index.tsx`, `grid.tsx`, `cells.tsx`, `filters.tsx`, `row-dialog.tsx`), the `/database` route (lazy) and nav entry. An ARIA grid on divs (two Biome a11y rules off for `grid.tsx`, with the reason). 2 Playwright tests (editing, sort, filter + export, hidden columns, add/delete; 350 rows loading as you scroll).

### Step 6, `e0aaad5`: schema editor and import wizard
`schema-dialogs.tsx` (New table, Column, Table settings), `import-dialog.tsx` (preview, options, column mapping, problems). `previewCsv` became a mutation with a delimiter override. A Playwright test drives both, including a Dutch file.

### Step 7, `0fabc20`: workflows
No engine change. `resources.list` returns `systemKind`; a Built-in badge, a read-only Settings card linking to the Database page, the editor's picker marking it, the Database page linking to the resource. `database-workflows.test.ts` (4) and a Playwright test (badge, playground query, link).

### Step 8 (this commit): e2e, Compose check, docs
`apps/web/e2e/m7-done-when.spec.ts`, the Compose check (§10), `docs/runbooks/backup.md` (the managed database in a restore), `architecture.md` §2.3/§2.5/§2.8/§2.10, this file.

### Review fixes (before merging)
The `code-review` skill (high) on PR #8 found 10 issues; each was checked against the code. Fixed: the Database page's transactions now pin `search_path`, `DateStyle`, read write and UTC (a plain `SET` in a playground query outlasts its transaction on the shared pool: the regression test fails without the fix with "cannot execute CREATE TABLE in a read-only transaction"); JSON "is"/"is not" filters compared against double-encoded text; deleting more than 1,000 selected rows failed (now batched); codes with leading zeros (EANs, postcodes) and numbers past bigint were guessed as numbers (now text); slugs like `eu-west`/`eu_west` would share a schema (now suffixed, and migration `0011` makes schema and role names unique); before PG 15 a no-op revoke on `public` went unnoticed (now checked); an import column past the file's width imported as NULL (now refused); `getTable` read the whole schema's catalog (now one table); unchecking "first row holds the column names" kept the old types (the preview now guesses again with `header: false`). Not changed, noted in §13: an export holds a pooled connection for the whole download.

### Totals at the end of M7
`biome ci` is clean. Typecheck passes **9/9**. **697 tests pass** (server 173, engine 139, definition 124, connectors 106, expressions 91, crypto 25, db 20, sandbox 19), plus the two benchmarks and **9 Playwright e2e**. The existing editor spec failed once locally at a step that drags between blocks (then 3/3 alone and in later full runs; CI retries once).

Bundles: first-load JS ~780 kB (main 590 kB + `ui` 181 kB + `jsx-runtime` 9 kB; rolldown re-split the shared chunks, the total didn't change), the database chunk 113 kB, the editor chunk 319 kB.

## 9b. What M8 built (on `main`)

**Done-when** (build a CRUD app on a Postgres table with an editable Table and a save query), proven:
- `apps/web/e2e/m8-done-when.spec.ts`, all in the browser after making the table through the Database API: a new app from the Apps page; a `products` query; a Table bound to it, columns from "From data", `stock` made editable; a manual `save_stock` query (`update … from jsonb_to_recordset({{ table1.changesetArray }}::jsonb) …`) re-reading `products` on success; the Table's `save` wired to it; no problems; published v1.0.0; in the published app a cell edited and saved; the row read back from the database.
- On Docker Compose (§10): the same app published by the separate `m7-check` admin, a cell edited and saved in Chrome, the row read back, the write audited without values.

### Step 1, `136f21e`: the app definition
`packages/app-definition`: schema, component registry, reactive graph (per-property dependencies, Tarjan cycles, topological order), `AppModel` evaluator, validator, canonical hash, `renameAppEntity`. `@ow/expressions` got opt-in member properties and `sync-function-body`. 33 tests; the "pruning" mutation first survived and the test was strengthened.

### Step 2, `5922a78`: the server
Migration `0012_apps.sql` (`apps`, `app_releases`, `app` object type), `Access.appLevel`/`canCreateApps`, `services/apps.ts` (checkApp, publish, setLive, runAppQuery), the `apps.*` router, app grants in `permissions.*`, `expressionSide`/`browserExpressions` and `mixed_current_user`. 9 server tests, 7 mutation checks.

### Step 3, `8978b4b`: the runtime
`packages/app-runtime` (protocol, `AppRuntime`), the sandbox iframe and its entry, the Vite plugin, `AppHost`, `/apps/$slug` with a fallback renderer, `"sideEffects": false`. `e2e/app-sandbox.spec.ts` (fetch, the parent document and cookies out of reach).

### Step 4, `ba6dfc1`: the editor
`/apps/$slug/edit`: react-grid-layout canvas, palette and tree, inspector, handlers editor, code panel, autosave; hot updates with carry-over; pure edits in `@ow/app-definition` (one found a move bug); the shared Monaco field (`components/code/`). `e2e/app-editor.spec.ts`.

### Step 5, `b784ba2`: components
Table (`table-model.ts`), inputs, Text, Button, form `noValidate`, `saveChanges`, acknowledged sets, vitest in the web app. `e2e/app-components.spec.ts` (a published CRUD app; found the browser's validation pre-empting the runtime's, the asterisk in accessible names, the key column tinted).

### Step 6, `62b0e31`: the Chart
Chart.js in its own chunk, `chart-model.ts` (tested), the dataviz rules, a table view. `e2e/app-charts.spec.ts` (found invisible line keys and a pie legend regression).

### Step 7, `90cada1`: apps in the product
`/apps` and the sidebar entry, the editor's release controls (Publish, Releases with rollback, Access, App settings, Open app), the viewer's Edit link and unpublished page, `AccessEditor` for apps. `e2e/app-releases.spec.ts`.

### Step 8 (this commit): done-when, Compose check, docs
`e2e/m8-done-when.spec.ts`; the Compose run (§10); README (Managed database, Building apps), `architecture.md` §2.3/§2.8/§2.11, this file. The done-when caught JSON fields reformatting under the cursor (fixed with `useParsedText`) and a test helper clicking the middle of tall Monaco fields (now near the top-left).

### Review fixes (before merging), `cefd37a`
The `code-review` skill (high) on PR #9 found 10 issues; each was checked against the code and all 10 held:
- **Folder moves needed only Edit** and accepted any folder, so a resource folder's grants could reach an app. `checkFolderMove` now needs Own and a folder of the object's type, create checks the type, and `Access` counts folder grants only for objects of the folder's own type. **Workflows had the same gap since M2**; fixed there too.
- **REST paths in apps:** a viewer could send `../users/42` as a path value. Connectors take `untrustedValues` (always set for app queries); the REST connector then encodes each path value as one segment.
- **Editor:** `apps.get` is fetched fresh per visit (`gcTime 0`) and loaded once per visit (coming back used to restore the first visit's draft and revision; saving App settings replaced unsaved edits). One `ScopeSync` per editor builds completions (every field used to rebuild them on each value change).
- **Runtime UI:** confirmations queue (`useConfirmations`; a second one used to strand the first); the viewer loads its release once per visit (a refetch on focus used to restart the app).
- **Table:** edits remember their row's and column's keys (data changing mid-edit could move them onto another row); `selectionKey` matches rows without a primary key by content.
- `toJson`/`errorView` shared (`services/query-results.ts`).
Tests: 3 server tests (folders, workflows, a REST path against a real HTTP server), a return-to-editor check in `e2e/app-releases.spec.ts`, `selectionKey`; mutation-checked.

### Flaky tests fixed on the way (none caused by M8)
- `798b523`: the MySQL "prepares the statement with ?" test counted released statements once; now polls up to 2 s.
- `1fda33e`: the engine "replies with the first Response block" test gave the late branch 100 ms; now 1.5 s.
- `ac07346`: the engine retention test's time limits (1 s) were exceeded under a full local `pnpm test`; now 2 s, the row-count guards unchanged.

### Totals at the end of M8
`biome ci` is clean. Typecheck passes **11/11**. **775 tests pass** (server 185, engine 139, definition 124, connectors 106, expressions 93, app-definition 41, crypto 25, db 20, sandbox 19, app-runtime 15, web 8), plus the two benchmarks and **15 Playwright e2e**.

Bundles: first-load JS ~600 kB (main 414 kB + `ui` 178 kB + small chunks); the apps chunk (viewer, runtime, sandbox script) 317 kB, the app editor 133 kB, Chart.js 191 kB (with the first chart), the workflow editor 336 kB, the database page 87 kB.

## 9c. What M9 built (on `feat/m9-oauth`, PR #10)

**Done-when** (a REST resource connected with the authorization code runs queries from the playground, a workflow including a scheduled live run, and an app; an expired token refreshes on its own; a revoked one asks for a reconnect; a per-user resource uses each viewer's own account in an app; a custom auth flow refreshes once on a 401), proven:
- `apps/web/e2e/m9-done-when.spec.ts` (3 tests, against a fake provider and API in the test process; `--repeat-each=3` passed): the resource set up and connected through the UI (popup), the playground, a draft run, a scheduled run (made due through the seeded `shop_db` resource, which reaches the platform database), a published app, expiry (one refresh grant), revocation (the reconnect message, then Reconnect on the card); two people (the global setup now makes `e2e-second@optiply.nl`) each connecting their own account in one app; a custom flow built in the editor, signing in once and refreshing once.
- On Docker Compose (§10): the same, with the provider on the Mac.

### Step 1, `512bbd6`: connector
`packages/connectors/src/oauth.ts` (PKCE, state, consent URL, code exchange, refresh, client credentials over one token request, Slack's and Entra ID's quirks, `OAuthGrantError`), `oauth-presets.ts`, the `oauth2AuthorizationCode` auth type, `CredentialSource`, `auth_required`. 27 tests.

### Step 2, `e1430be`: token storage
Migration `0013`, `services/oauth-tokens.ts` (`saveTokens`, `deleteTokens`, `connectionStatus`, `oauthCredentials` with the locked refresh), `saveConfig` dropping tokens on consent changes. 13 tests (5 workers → 1 refresh against a provider refusing reused refresh tokens).

### Step 3, `b8a4454`: connect flow
`api/oauth.ts` (start, callback), `services/oauth-connect.ts` (checks, cookie, result page), `resources.oauthConnections` and `resources.oauthDisconnect`. 10 tests.

### Step 4, `a7205a5`: tokens on every path
The engine's `actingUserId`, `credentialsFor` in the resource provider, apps and the playground, the publish check. 7 integration tests with a real worker against an API that says whose account each token is. An engine test ("stops a workflow that calls itself after 10 levels") failed once locally under load and passed in every rerun and in CI.

### Step 5, `c49ecba`: UI
`pages/resources/oauth.tsx` (fields with presets and the redirect URI; the connection card), `lib/oauth.ts` (popup), `components/auth-required.tsx`, the app host's `connections` and `NeededConnections` banner; saving keeps the Settings tab open (it used to jump to Query). A Chrome walkthrough (not committed).

### Step 6, `7a6aa32`: custom auth flows (back end)
The `custom` auth type, `auth-flow.ts` (`runAuthFlow`), per-attempt `authMaterial` in the REST connector, `services/custom-auth.ts`. 17 tests.

### Step 7 (this commit): custom flow UI, done-when, Compose check, docs
`pages/resources/custom-auth.tsx` (secret values, sign-in and refresh steps, the sign-in-again interval; `SecretRecord` generalizes the secret headers editor), `e2e/m9-done-when.spec.ts`, the second e2e user, README ("Signing in to APIs"), `architecture.md` §2.3/§2.5/§2.7/§2.8/§2.12, this file.

### Review fixes (before merging)
The `code-review` skill (high) on PR #10 found 10 issues; each was checked against the code and all 10 held:
- **Tokens could be sent elsewhere:** the consent fingerprint didn't cover where requests go, so someone with Edit could test (or save) settings pointing at their own host and receive the connected account's token. It now covers the base URL's origin and the allowed hosts (custom flows too).
- **App viewers couldn't connect their own account** on a per-user resource they have no grant on, though app queries would use it: `/api/oauth/start` and `oauthDisconnect` take `appId` (Use on an app whose live release queries the resource); the app banner passes it.
- **Switching shared ↔ per-user kept the other mode's tokens** (an old shared token came back when switching back): the token mode is in the fingerprint.
- **Waiters held pooled connections** while one process called a slow provider under a lock: `withRefreshLock` (try, sleep outside the transaction) for OAuth refreshes, custom sign-ins and connects.
- **A custom flow's forced refresh** compared with the row read at refresh time, not the variables the failing request used, so it could sign in again after someone else had: it now tracks what it handed out (like OAuth's last token).
- **Two connects at once** for the same owner could hit the unique constraint (a 500): connects take the owner's lock.
- **With custom auth the resource's default headers overrode the query's own**, and custom auth was special-cased in three places: one assembly for every auth type (above).
- **Every custom variable was scrubbed**, corrupting results containing a non-secret value: `secret: false` per variable (a checkbox in the editor).
- **Token endpoints that redirect** (a trailing slash) stopped working: same-origin redirects are followed.
Tests: 6 server tests (connecting through an app, testing settings that send elsewhere, base URL / allowed hosts / mode changes disconnecting, no lock waits in `pg_locks` during a slow refresh, a connect waiting for the owner's lock, a late refresh, non-secret variables), 2 connector tests (header precedence, token redirects); each fix mutation-checked. Correction: step 1 added 21 tests (16 in `oauth.test.ts`, 5 REST), not 27.

### Totals at the end of M9
`biome ci` is clean. Typecheck passes **11/11**. **848 tests pass** after the review fixes (server 226, engine 139, connectors 138, definition 124, expressions 93, app-definition 41, crypto 25, db 20, sandbox 19, app-runtime 15, web 8), plus the two benchmarks and **18 Playwright e2e**.

Bundles: main 425 kB (414 before M9).

## 9d. What M10 built (on `main`)

**Done-when** (a two-page app: its list page pages, sorts and searches a 100k-row table server-side; a row opens the detail page with the id in the URL; the app sits in a folder granting a group Use; an infinite loop in its code is stopped and the tab stays responsive), proven:
- `apps/web/e2e/m10-done-when.spec.ts`: a published app over a 100,000-row managed table; as the non-admin `e2e-member`: nothing visible before the folder's grant (the empty state, folders existing), then 100000 rows 25 at a time (Page 1 of 4000, the request with offset 25 seen), sorted by id descending through `sql.column`/`sql.direction`, "item 4242" giving 11 rows, a row opening `/item?id=42425`, the tab named after the page, the global Navigation back with the search kept, an endless loop stopped while the tab keeps drawing, Restart. The admin makes the folder, moves the app and grants the group Use through the UI.
- On Docker Compose (§10): the same in Chrome.

### Plan, `a5b86bd`
`architecture.md` §2.7 (the M10 row, M11+), this file's §14.

### Step 1, `bb2baab`: the sandbox in a Worker
The spike (above), `runtime/host.ts` (bootstrap document, watchdog, `stopped`, `restart`, replies per port), `runtime/watchdog.ts` (5 tests), `sandbox-entry.ts` as the Worker with the self-check, `stopped.tsx`, `ping`/`pong`. e2e: more escape probes (no request may be answered; Chrome reports the XHR and fails it with `csp`), an endless loop (frames, the Worker closed, Restart), a loop at start, an edit restarting the editor's app. 4 mutation checks.

### Step 2a, `37f3d32`: `sql.column` and `sql.direction`
`expressions/src/sql.ts` (fragments, `fragmentText`, `withFragments`), `connectors/src/sql-fragments.ts`, the stdlib's `sql`, typings in both editors. Tests on real Postgres, MySQL (Docker), the BigQuery fake, the sandbox and the server's app path. 2 mutation checks.

### Step 2b, `ed0b806`: Table paging, sorting and search
The Table's props, state, methods and events, the `pagination` node, `tableView`, the renderer (search box, pager, row count). `e2e/app-table.spec.ts` (browser and server-side tables over 120 rows).

### Step 3a, `9cd0420`: pages in the definition
Schema, `pages.ts`, the `url` entity, the validator's page rules. `test/pages.test.ts`.

### Step 3b, `e5b2d1c`: pages at run time
`AppRuntime.navigate`, page-scoped auto queries, `utils.openPage`, the protocol, the host, the router (one route, plain search params), the viewer, the canvas's frame and page grids. `e2e/app-pages.spec.ts` (URLs, Back and Forward keeping one sandbox and what was typed).

### Step 4a, `732dfa4`: page edits and Navigation
`addPage`, `renamePage`, `setPageTitle`, `movePage`, `onPage`, `removePage`, `setEntityPage`, page options on the other edits; the Navigation component; `host.openPage`.

### Step 4b, `a9ae3f4`: pages in the editor
The store's `url`, `editor/pages.tsx` (pages panel), the two grids, the palette and tree per page, the Page fields, the host re-sending the page after updates (its mutation needed a `url.page` assertion to be caught), the tab title. `e2e/app-editor-pages.spec.ts`.

### Step 5, `8c692bd`: folders for workflows and apps
`folders.*` per type, `components/folders.tsx`, the Workflows and Apps lists. `e2e/folders.spec.ts`; two existing specs' `getByLabel('Name')` made exact (a row's "Folder of … (renamed)" select matched).

### Step 6, `b62f132`: done-when, Compose check
`e2e/m10-done-when.spec.ts`, the member user, workflow/app folder grants for every environment (found while writing it: a one-environment grant was stored and never counted).

### Review fixes (before merging), `6c95f5a`
The `code-review` skill (high) on PR #12 found 10 issues; each was checked against the code and all held (the reserved `sql` name being a noted trade-off):
- **`sql.column`'s fallback was refused by the server** (the helper sends it when nothing is sorted): the README's own example failed on every unsorted load. My tests had always listed the fallback among the columns.
- Page titles lost their spaces while typing (trimmed per keystroke); an app's own `url` entity broke navigation in the Worker; list pages went blank for people with nothing shared while folders existed; app code could switch the viewer's environment through an `env` param; deleting a page left Navigation links to it (blocking publishing); a query waiting when its page closed still ran; a `{{ }}` right after a fragment was glued to it (`DESC$1`); odd page sizes were handled two ways; two page pickers.
Tests for each (the e2e ones mutation-checked).

### Totals at the end of M10
`biome ci` is clean. Typecheck passes **11/11**. **897 tests pass** (server 228, engine 139, connectors 144, definition 124, expressions 103, app-definition 53, crypto 25, db 20, sandbox 20, app-runtime 22, web 19), plus the two benchmarks and **25 Playwright e2e**. Bundles weren't measured this session.

## 9e. What M11 built (on `feat/m11-git-sync`, PR #13)

**Done-when** (protect a workflow and an app; edit both on a branch and run the branch drafts; commit, the repo showing code as `.js` and SQL as `.sql`, and open a PR; merging it deploys a new live release of each within seconds of the webhook, and on the next poll without it, and a workflow added on the branch is created; main is read-only for protected objects; an invalid commit on main deploys nothing and says why), proven:
- `apps/web/e2e/m11-done-when.spec.ts` (~19 s; passed 3 times in a row): Git sync set up in Settings → Git with a generated webhook secret; a published workflow (SQL + code) protected from the list, a published app (SQL in a Text) from its settings; both protect PRs merged; main read-only; on a new branch the code edited and the branch draft run (`ADA@EXAMPLE.COM`); Commit with the diff; the app on the same branch with its SQL edited and its branch draft showing the second customer; the repo's `.js` and `.sql` read with git; a developer pushes a new workflow on the branch with git; the PR opened from the Commit dialog and merged on the fake GitHub, whose signed push webhook deploys it all (under 10 s; both 1.0.1, the new one created and protected, 1.0.0); main and the app's live release show the change; with the webhook off, an invalid commit pushed straight to main is deployed by polling with its problems shown on Settings → Git, the live release kept.
- On Docker Compose (§10): the same spec against localhost:3000, through a git server and the fake GitHub on the Mac.

### Plan, `ba22cdc`
`architecture.md` §2.7 (the M11 row, M12+), §2.13 (the design), this file's §14.

### Step 1, `b159b32`: the file format
`packages/git-format` (browser-safe): workflows and apps to files and back, `ow.json`, repo splitting, problems by path, case-collision warnings. 824 tests, mostly a seeded round trip over 400 workflows and 400 apps (2 mutation checks).

### Step 2, `55d74e2`: git on the server
git in the image; `services/git/cli.ts` (clean environment, askpass, error kinds, scrubbing), `repo.ts` (bare cache, plumbing read and write, fast-forward push), `commit.ts` (`commitToBranch`, conflicts, retries), `settings.ts`; `git_settings` (migration 0014), `git.*` admin API, Test connection; `git_settings` covered by rekey/verify. 24 tests.

### Step 3, `c4ea6bb`: deploy from main
`services/git/deploy.ts` (lease, requests and rounds, per-directory trees, passes, problems, missing, history), `deployer.ts` (polling in workers), `api/git-webhook.ts` (signed push webhook); the release services split so publishing and deploying share the release path; `git_objects`, `git_deploys` and the Git columns (migration 0015). 17 tests. (CI: the engine race below once; rerun green.)

### Step 4a, `61f8e82`: protection, read-only main, pull requests
`services/git/protection.ts`, `github.ts` (api.github.com, GHES, `GITHUB_API_URL`), `git.protect`/`unprotect`/`branches`/`pullRequest`/`openPullRequest`, the read-only rules and admin rollback in the routers, objects created protected. 12 tests over the fake GitHub.

### Step 4b, `4e7d86f`: branch drafts
`services/git/branch-drafts.ts` and `branchDrafts.*` (open, save, changes, update from branch, commit, discard), branch-draft runs and app queries, branch snapshots kept by retention (migration 0016). 14 tests.

### Step 5a, `376d7ee`: Settings → Git, Protect in the lists
`pages/settings/git.tsx`, `components/git.tsx`, "In Git" and Protect in the lists, "Create it in Git", Git sync release authors, `git.info`; release notes from PR titles; the e2e setup's repo and fake GitHub. (CI: a lint error, `role="group"` on a div, fixed in 5b.)

### Step 5b, `e2ee242`: the editors
`components/git-bar.tsx` (branch picker, status, Update, PR, Commit dialog with diffs), `lib/diff.ts` (5 tests), both editors on branches (read-only main, branch drafts saved and run), Protect/Unprotect in their settings. A walkthrough found main stale after a merge (fixed). (CI: the engine race again; see the fix below.)

### Engine fix, `25218f0` (session 12): a child ending while its parent pauses
The CI timeouts of "stops a workflow that calls itself after 10 levels" (4.3 s normally, past 30 s twice) were a missed wake-up, not slowness: a child's `wakeParents` that ran while the parent was still `running`, committed after the parent's `suspendRun` re-check had looked, was seen by neither, and the parent slept for its hour-long recheck. Now `finishRun`, `suspendRun` and `cancelRun` lock the parent's row first (`lockParents`, `for no key update`, ancestor before descendant); the reaper locks parents with `skip locked` and leaves a run whose parent is busy for its next pass. Regression test in `children-pg.test.ts`: a test-only deferred constraint trigger holds the child's commit open after its wake-up (failed before the fix: the parent an hour out). Step 6's 90 s limit for the test was dropped (it only hid the stall).

### Step 6 (this commit): done-when, Compose check, docs
`e2e/m11-done-when.spec.ts` (with `E2E_GIT_REPO_DIR` for running it against another stack); the app editor stays mounted while main turns read-only after Protect (found by the spec: the Protect dialog vanished); `docker-compose.yml` passes `GIT_POLL_SECONDS`, `GIT_ALLOW_INSECURE_URLS` and `GITHUB_API_URL`; the test git server and fake GitHub take a listening address.

### Review fixes (session 12, PR #13 review; this commit)
Ten findings from the `code-review` skill, each checked against the code: (1) branch drafts and protect refused on the deploy branch (an Edit-only person could commit straight to main with the instance token, deployed unreviewed); (2, 3) changes and commit fetch the draft's base commit first (a new process's cache didn't have it: BAD_GATEWAY after a restart); (4) update from branch only at the revision it read (a concurrent save was overwritten); (5) a draft whose base commit is gone asks before being replaced; (6) a commit moves the base even when someone saved meanwhile (a false conflict with our own commit); (7) the deploy lease released only while held, and a request left at the round limit put back; (8) the rollback wording (above); (9) protecting again picks a free branch name, the Protect dialog leaving the default to the server; (10) one `liveOrDraft`. Tests: five in `git-branch-drafts.test.ts` (failed before the fixes), one in `git-protect.test.ts` (failed before).

### Totals at the end of M11
`biome ci` is clean. Typecheck passes **12/12**. **1,799 tests pass** (git-format 824, server 300, connectors 144, engine 140, definition 124, expressions 103, app-definition 53, crypto 25, web 24, app-runtime 22, db 20, sandbox 20; 2 skipped), plus the two benchmarks and **26 Playwright e2e** (19 spec files, 1.7 min locally). Main bundle 447 kB (130 kB gzipped).

## 9f. What M12 built (on `feat/m12-python`, PR #14)

### Plan, `c99a281`
`architecture.md` §2.7 (the M12 row, M13+), §2.14 (the design), this file's §14.

### Step 1 (this commit): the executor
- **The spike** (timeboxed, as planned): nsjail isn't in Debian (bookworm or trixie), so it's built from source (3.6, March 2026, pinned commit). In Docker Desktop: `--privileged` works; so does **`--cap-add SYS_ADMIN` plus Docker's seccomp profile with `pivot_root` added**, which is what we use (plus `apparmor=unconfined` for Linux hosts). Without SYS_ADMIN, no namespaces; with the default seccomp profile, `pivot_root` is refused; the cgroup is read-only until the entrypoint remounts it and delegates the controllers; a new `/proc` can't be mounted under Docker's masked one (the jail has none, so the loader needs `/etc/ld.so.cache`); kafel calls `umount2` `umount` (checked against both its amd64 and aarch64 tables). Timing: a jailed interpreter 12 ms, pandas' import 213 ms, a trivial block over HTTP 39 ms p50.
- `apps/code-executor`: `Dockerfile` (nsjail build stage; Python 3.12 slim; the virtualenv from `requirements.lock` with hashes), `seccomp.json`, `executor/server.py` (stdlib HTTP: `/run`, `/check`, `/health`, token, concurrency, cancel on hang-up, log framing and caps, outcome without a result → timeout/memory/exit code), `executor/runner.py` (in the jail: the code as a function body through the AST so line numbers and strings stay as written, `Obj` for attribute access, JSON conversion of pandas/numpy/datetime/Decimal/NaN/NaT, errors with the user's frames only, syntax checks), `executor/jail.cfg`, `executor/entrypoint.sh`.
- `@ow/code-executor/testing`: `startTestExecutor` (image tagged by a hash of its sources, built when missing; `PYTHON_EXECUTOR_TEST_URL`), `executorAvailable`, `EXECUTOR_DOCKER_FLAGS`.
- `test/executor.test.ts`, 23 tests against the container: the protocol and token; scope by attribute and key; conversions; empty code; prints in order with levels; a printed outcome isn't taken; syntax, runtime (trimmed traceback), serialization (16 MB) errors and `os._exit`; `/check` compiles without running; the jail (nobody, its own environment only, sees only `bin dev etc lib opt tmp usr`, can't write outside `/tmp`, no network even to the executor, no `unshare`/`ptrace`/`mount`, `fork` allowed); limits (an infinite loop at the timeout, 1 GB → memory and the next run fine, a fork bomb under 32, `/tmp` and file size, the log cap); a hung-up caller's jail killed; 8 runs 4 at a time; latency.
- **CI's first run** (x86-64, `f37c34d`): every execution failed with "exit code 255": the jail had `/lib` but not `/lib64`, where x86-64 binaries find their loader (arm64's is in `/lib`, so the Mac never saw it). Reproduced and checked without pushing: the image built for x86-64 under Docker Desktop's emulation, with a copy of the jail config without the seccomp policy (qemu can't install a guest's seccomp filter): without `/lib64` it fails the same way, with it 21 of the 23 tests pass (the namespace test needs the seccomp policy, and emulation is 10× slower); the x86-64 policy compiles. A jail that never starts is now an `internal` error with nsjail's reason (nsjail logs at `--quiet`, not `--really_quiet`), and the tests throw it instead of showing `ok: false`.
- Found while testing: a refused request's unread body was read as the next request on a kept-alive connection (`'{}POST'`); stdout and stderr on two pipes lost their order (now framed on one); pandas' `NaT` is a `datetime` (it came back as `"NaT"`).

### Step 2 (this commit): the definition
- `@ow/expressions`: `python.ts` (`analyzePython`: refs, builtins, bound; `PYTHON_KEYWORDS`, `PYTHON_BUILTINS` taken from Python 3.12 itself) and the `python-body` code kind through `freeIdentifierRefs`, so field references, the engine's scope (`referencedNames`) and rename work unchanged. 12 unit tests, and `python-symtable.test.ts`: the same names as Python's `symtable` on 38 snippets (`test/python-corpus.ts`; it caught `del`).
- `@ow/definition`: `language: 'python'` on code blocks and code loop runners (optional, so JavaScript is no language and old hashes stand; `'javascript'` isn't accepted, keeping one spelling), `CODE_LANGUAGES`/`CodeLanguage`; the `python-body` field kind; `python_unsupported` (functions, `fetch`) and `python_builtin` (warning); no `unknown_identifier` for Python; Python-only keywords reserved for workflow blocks; `calledFunctions` skips Python. 9 tests (`test/python.test.ts`).
- `@ow/git-format`: `blocks/<name>.py` for Python (code blocks and loop runners), `.js` otherwise; the round-trip property test generates Python too. 2 tests.

### Step 3 (this commit): engine and server
- `@ow/sandbox`: `PythonExecutorClient`/`PythonRunner` (`python.ts`); `SandboxError` gets the `unavailable` kind and `details`.
- `@ow/engine`: `services.python` and `RunExecutorOptions.python`; `runCode(…, language)` → `runPython` for code blocks and loop runners; `toEngineError` keeps `details`. 7 tests against the executor container (`test/python.test.ts`: scope and result with pandas and logs, a loop runner, errors with line and traceback, timeout and retries, an aborted run hangs up, an unreachable executor, none at all).
- `@ow/definition`: `pythonFields`, `lineColumnOffset`, the `python_unavailable` code.
- Server: `PYTHON_EXECUTOR_URL`/`PYTHON_EXECUTOR_TOKEN` (`config.ts`), `services/python.ts` (`configurePython`, `pythonRunner`, `pythonDiagnostics`), `checkDefinition` adds them, the worker and the API give their runners the client, `workflows.checkPython`. 5 tests against the executor (`test/python.test.ts`: a draft run on a worker with its logs, refusing to run and publish broken Python with the diagnostic's place, publishing and running a release, checkPython, no executor), and one in `config.test.ts`.

## 10. How things were verified (and how to repeat it)

- **Unit and integration tests:** `pnpm test`. Each server, db, connector and engine Postgres test file boots its own embedded Postgres. The engine suite was run three times in a row after step 3 with no flakes.
- **Webhook latency:** `pnpm --filter @ow/server bench:webhooks` (prints p50/p90/p99).
- **Sandbox context speed:** `pnpm --filter @ow/sandbox bench` (0.66 ms locally).
- **Playwright e2e (committed):** `pnpm --filter @ow/web build && pnpm --filter @ow/server build && pnpm --filter @ow/web e2e`. Locally it uses the installed Chrome (`channel: 'chrome'`); CI uses Playwright's Chromium. The server runs on port 4387 (`E2E_PORT`). Fifteen specs at the end of M8 (nine after M7). For repeats, pass `--repeat-each=3` to `pnpm exec playwright test` in `apps/web` (through `pnpm … e2e -- …` the flag doesn't reach Playwright). The `typeInto` helper clicks a Monaco field near its top-left corner: with more lines than fit, the middle of `.view-lines` is over the next field.
- **MySQL tests** start a `mysql:8.4` container (Docker) or use `MYSQL_TEST_URL`; skipped locally without Docker, required in CI (~46 s for the connector file, including the container start).
- **Docker Compose, session 11** (the M11 done-when; `compose-check/` in the session scratchpad: `servers.mts`, the spec copy, `cleanup.mjs`, not committed):
  - Asked first (the user had signed in 50 minutes before). On the Mac: a git server (`git http-backend` behind a random token) and the fake GitHub, listening on 0.0.0.0 (ports 53017 and 53018), reached from the containers at `host.docker.internal`. The stack rebuilt on the branch with `GIT_ALLOW_INSECURE_URLS=true GITHUB_API_URL=http://host.docker.internal:53018 GIT_POLL_SECONDS=5`: back after 6 s, migrations 0014–0016 applied (17 in all), git 2.39.5 in the containers.
  - A throwaway database `m11_check` (a `customers` table) behind its own resource; `m7-check@optiply.nl` got a new random password (`compose/m7-check-password` in this session's scratchpad).
  - The spec copy in Chrome as `m7-check` (the instance using `http://host.docker.internal:53017/optiply/flows.git`, the test reading the repo from disk): passed in 12.6 s on the second run (the first found the test race fixed in step 6: it checked the app before the deploy reached it). Deploys from merges came through the webhook (39–87 ms each); the invalid commit through polling (`problems`: the bad block type in `workflow.json`, and its `emails.js` no longer belonging to anything).
  - Afterwards: the check's workflows, apps and resources deleted through the API, Git sync disconnected, `git_objects` and `git_deploys` emptied (check data only), `m11_check` dropped (`WITH (FORCE)`: a pooled connection of the deleted resource held it), the session signed out; the stack recreated without the test-only flags (back after 3 s) and left on the M11 image; the servers on the Mac stopped.
- **Docker Compose, session 10** (the M10 done-when; `compose-check/` in the session scratchpad: a copy of the spec with its own accounts and a config pointing at `localhost:3000`, not committed):
  - Asked first (the stack is shared); `PUBLIC_URL=http://localhost:3000 docker compose up -d --build` with the step 6 code: healthy within seconds, no migration (still `0013`), the managed database as it was.
  - `m7-check@optiply.nl` got a new random password (`compose/m7-check-password` in this session's scratchpad); a non-admin `m10-member@optiply.nl` was made with `create-admin` and taken out of the admins group with SQL.
  - The spec's steps in Chrome (Playwright, `channel: 'chrome'`): passed in 10.7 s.
  - Afterwards, with the user's OK: the stack rebuilt on merged `main` (`bb7f6b7`), and the check's app, folder, group (through the API as `m7-check`), table (`database.dropTable`) and the member user (SQL, in a transaction) deleted.
- **Docker Compose, session 9** (the M9 done-when; `m9-check.mjs` in the session scratchpad, not committed):
  - Checked first that the user wasn't mid-task (audit: they had signed in 10 minutes before; asked, they said go ahead). `PUBLIC_URL=http://localhost:3000 docker compose build` while running, then `up -d`: localhost:3000 back after **10 s**; migrate applied `0013`.
  - The `m7-check@optiply.nl` admin got a new random password (`compose/m7-check-password` in this session's scratchpad); `admin@optiply.nl` untouched.
  - A fake provider on the Mac (listening on 0.0.0.0): the browser reaches its consent screen at `127.0.0.1:<port>`, the containers its token endpoint and API at `host.docker.internal:<port>` (`allowPrivateNetwork` on).
  - In Chrome as `m7-check`: the redirect URI shown as `http://localhost:3000/api/oauth/callback`; the shared account connected in the popup; the row encrypted; the playground, a scheduled live run (made due with SQL) and a published app all used it; an expired token refreshed once; a revoked one refused with `invalid_grant`, then Reconnect from the card fixed it; a custom flow signed in once, reused its session, and refreshed once on a 401; the audit had `oauth_connected`, `oauth_refresh_failed`, `oauth_connected` and no token or secret anywhere; no page errors.
  - Afterwards the check's resources, workflow and app were deleted (their tokens went with them) and the session signed out; the user's `test` and `cancel-me` workflows and schedule were untouched.
- **Docker Compose, session 8** (the M8 done-when; `m8-check.mjs` in the session scratchpad, not committed):
  - Checked first that the user wasn't mid-task (audit: they had signed in 11 minutes before; asked, they said go ahead). `PUBLIC_URL=http://localhost:3000 docker compose build` while running, then `up -d`: localhost:3000 back after **6 s**; migrate applied `0012` (the `apps` table exists); the managed database unchanged.
  - The `m7-check@optiply.nl` admin got a new random password (`compose/m7-check-password` in this session's scratchpad); `admin@optiply.nl` untouched.
  - `m8-check.mjs` (Chrome through Playwright's library, as `m7-check`): a managed table, the done-when's app published through the API (server diagnostics empty), the viewer showing the rows **223 ms** after opening, the sandbox `allow-scripts`, a stock cell edited and saved in the browser, the row read back (`Gadget 99`), no page errors; the audit shows `app.query_run` for `save_stock` only (not the automatic read), without values. Afterwards the app was deleted, the table dropped and the session signed out.
  - The user created an app `test` on the stack minutes after the rebuild (left alone).
- **Docker Compose, session 7** (the M7 done-when; `m7-check.sh` in the session scratchpad, not committed):
  - Checked first that the user wasn't mid-task (audit: they had signed in a minute before; told them, they said go ahead). `PUBLIC_URL=http://localhost:3000 docker compose build`, then `up -d`: localhost:3000 back after **8 s**; the migrate service applied `0010` and logged `managed database ready` with `owdb_production`/`owdb_6054d5_production` and `owdb_staging`/`owdb_6054d5_staging`.
  - A separate admin `m7-check@optiply.nl` (random password, `compose/m7-check-password` in the scratchpad) so `admin@optiply.nl` was left alone. As it, with curl and tRPC: a table created; a Dutch `;` CSV with decimal commas appended (3 rows, `1.234,50` → `1234.50`); a draft workflow on `optiply_db` returned the 2 matching rows; a workflow selecting `public.users` failed "permission denied for table users"; the export matched.
  - In Postgres: both roles `LOGIN`, no superuser/createdb/createrole/bypassrls, `NOINHERIT`, limit 50, password stored as `SCRAM-SHA-256$…`, `search_path` set, each schema owned by its role, no memberships. A wrong password from the api container (over the Docker network, `scram-sha-256`) is refused. (Inside the Postgres container, socket and 127.0.0.1 are `trust` in the official image: not a test of anything.)
  - A schema-only `pg_dump` has only `ALTER SCHEMA … OWNER TO owdb_…` for the managed schemas (skipped by `--no-owner`): a restore onto a server without the roles doesn't stop on them.
  - Afterwards the check's workflow and table were deleted and its session signed out; the `m7-check` user remains (can't be deleted).
- **Docker Compose, session 6** (the M6 done-whens; Node scripts `ow.mjs`, `task-setup.mjs`, `task-complete.mjs`, `load.mjs`, `cleanup.mjs` and `old-runs.sql` in the session scratchpad, not committed):
  - The stack was rebuilt with the step 7 code (`PUBLIC_URL=http://localhost:3000 docker compose up -d --build`); migrations 0008 and 0009 applied to session 5's data. The admin password was reset with `create-admin` (`ADMIN_PASSWORD`).
  - **User Task:** `task-setup.mjs` makes a workflow whose User Task is assigned to the admin and starts a run (→ `waiting`, task `open`); `docker compose down`, 20 s, `up -d`; `task-complete.mjs` sees the task still open and the run still waiting, completes it, and the run succeeds 127 ms later with the answer in its reply.
  - **Retention:** `old-runs.sql` inserts 40 runs finished 40 days ago with 100,000 block rows, payloads and 2,000 logs; `load.mjs 150` starts and waits for trivial runs for 150 s; a `psql … \watch 0.1` inside the Postgres container samples waiting locks and the oldest open transaction; `maintenance_jobs.last_started_at` reset to null makes the job due. Results in §9.
  - **Incident:** stopping that monitor with `pkill` inside the Postgres container made Postgres crash-restart (~1 s; the side process had become a child of Postgres, PID 1, and died by signal). Data recovered from the WAL; the load had already ended. Warning added to the runbook.
  - The **restore drill** (`docs/runbooks/backup.md`): dump, restore into `ow_restore_drill`, identical counts, `verify-secrets` (right key: all decrypt; wrong key: exit 1), migrate no-op, an API on the copy signs in and lists workflows; the drill database was dropped.
  - Afterwards the check's workflows (`approve-refund`, `ping`) were deleted with their runs, at the user's request.
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
- **Browser walkthroughs** (sessions 3–6, not committed): session 3 used puppeteer-core scripts; sessions 4–6 used a temporary Playwright spec (`e2e/zz-walkthrough.spec.ts`, deleted afterwards) reusing `e2e/global-setup.ts` with screenshots read back (session 6: the MySQL and BigQuery forms, the Inbox, the task form, the User Task form and the audit page). Gotchas:
  - Typing into Monaco races its auto-closing on slow machines: use `keyboard.insertText` (see `e2e/helpers.ts`).
  - Monaco wraps long lines on screen: rendered text contains extra line breaks.
  - Click empty canvas away from the floating toolbar (top left), controls (bottom left) and minimap (bottom right).
  - "Not published" also matches a button named "Publish": use `exact: true`.
  - A field label containing "host" (e.g. the SSL option "…hostname") matches `getByLabel('Host')`: prefer `getByRole('textbox', { name })`. Fields inside a `Field` `<label>` take its hint into their accessible name; buttons inside one take the whole label (the label editors' "Add").

## 11. Local environment quirks (this Mac)

- Node v24.15.0 (arm64). **Docker Desktop 29.8 with Compose v5.6 is installed** (since session 4; 8 CPUs, about 4 GB for Docker). No global pnpm, no system Postgres.
- Run pnpm as **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`**. **Turbo needs a `pnpm` binary on PATH.** In a Claude session, run `corepack enable --install-directory <scratchpad>/bin pnpm` and prepend that directory to PATH. The user can simply run `corepack enable`.
- **Dev database:** `pnpm dev:db` stores its data in `.data/pg` (gitignored), with `DATABASE_URL=postgres://ow:ow@127.0.0.1:5433/optiply_workflows`. It has a `demo_customers` table, a "Demo DB" resource (`demo_db`), and test workflows from session 3, all safe to delete; it's still at migration `0003` and migrates on the next `pnpm dev`.
- **Compose stack** (volume `optiply-workflows_pgdata`): running the image of **`feat/m11-git-sync`** (step 6, uncommitted at build time but the same code as the step 6 commit; rebuilt in session 11 with the user's OK; **migrations 0014–0016 applied**, so going back to `main`'s image runs it on a newer schema: additive tables and columns only). Git sync isn't set up on it. Session 11's check left nothing behind (§10); `m7-check`'s password is in session 11's scratchpad. Before that: the image of `main` at `bb7f6b7` (M10 with its review fixes; migration `0013`). Session 10's check left nothing behind (§10); `m7-check`'s password is in session 10's scratchpad. Before that: the image of `main` at `a04c68e` (M9 with the PR #11 review fixes; no OAuth connections stored). Before that: the M9 step 7 image (session 9's Compose check). Before that: the image of `main` at `fe0c65d` (M8 with the PR #9 review fixes; migration `0012`). It holds no apps (the user made and deleted a `test` app in session 8). Before that: the M7 step 7 image (session 7), with the managed database provisioned (`owdb_production`, `owdb_staging`; no tables). Also holds an admin `m7-check@optiply.nl` used by the session 7 and 8 checks (its password was reset again in session 9, kept in that session's scratchpad at `compose/m7-check-password`; reset it again with `create-admin` and `ADMIN_PASSWORD`). Before that: the M6 step 7 image. Holds session 5's `shop` database and resource, the draft workflows `loop-10k`, `wait-restart` and `cancel-me`, and **the user's own work from session 6** (a `test` workflow, an API key, and a schedule on `cancel-me` that fires: check with the user before changing them). Admin `admin@optiply.nl`: the password was reset in session 6 to a random one kept in that session's scratchpad (`compose/admin-password`); set your own with `docker compose exec api node --no-node-snapshot dist/cli/create-admin.js --email admin@optiply.nl --name Admin`. Compose reads `.env`, whose `PUBLIC_URL` points at Vite (`:5173`): run it with `PUBLIC_URL=http://localhost:3000` (or change `.env`). It holds port 3000, like `pnpm dev`. Postgres isn't published to the host: use `docker compose exec postgres psql -U ow -d optiply_workflows`.
- **Don't kill side processes inside the Postgres container** (see the runbook): Postgres is PID 1 there and crash-restarts when an adopted child dies by signal.
- **The session scratchpad can be cleared mid-session** (it happened in session 6): recreate the `pnpm` shim with `corepack enable --install-directory <scratchpad>/bin pnpm`.
- **isolated-vm compiles on `pnpm install`** (the patch): needs the Xcode command-line tools.
- **Docker images used by tests:** `mysql:8.4` (pulled on first use) and, since M12, `ow-code-executor:test-<hash>` (built from `apps/code-executor` by the first test that needs it: ~35 s with the layers cached, a few minutes cold; old tags can be removed with `docker image rm`).
- **`.env`** (gitignored) has `SESSION_SECRET`, `LOCAL_LOGIN_ENABLED=true` and a generated `ENCRYPTION_KEYS=v1:…`. `WORKER_CONCURRENCY` defaults to 4 and `WEBHOOK_INLINE_CONCURRENCY` to 8 when unset.
- **Dev admins (dev database):** `admin@optiply.nl` (password given to the user in session 2) and `m2-smoke@optiply.nl` (session 3, random password; harmless). Set a password with `corepack pnpm --filter @ow/server create-admin -- --email admin@optiply.nl --name Admin` (prompts, or reads `ADMIN_PASSWORD`).
- **At the end of session 11** the Compose stack was left running on the M11 branch's image (above). The dev database and dev servers weren't started. The e2e builds (`apps/web/dist`, `apps/server/dist`) are from step 6. `git` must be on PATH for the server tests and e2e (it is on this Mac and in CI).
- **At the end of session 10** the Compose stack was left running on the image of `main` (`bb7f6b7`). The dev database and dev servers weren't started. The e2e builds (`apps/web/dist`, `apps/server/dist`) are from `main` before the merge commit (the same code). Playwright's Firefox and WebKit (for the step 1 spike) were installed into session 10's scratchpad only.
- **At the end of session 9** the Compose stack was left running on the image of `main` (`a04c68e`, M9 with its review fixes), the user signed in to it. The dev database and dev servers weren't started this session. The e2e builds (`apps/web/dist`, `apps/server/dist`) are from step 7.
- **At the end of session 8** the Compose stack was left running on the image of `main` (`fe0c65d`, M8 with the review fixes).
- **At the end of session 7** the Compose stack was left running on the M7 step 7 image (the user's `cancel-me` schedule still fires hourly). **At the end of session 6** the Compose stack was left running (the user's `cancel-me` schedule is active; private-network fetch off); stop it with `docker compose down` (add `-v` to drop its database). The dev database (still at migration `0003`) and dev servers weren't started this session.

## 12. Still unverified

1. **Google SSO** against real Google. This needs an OAuth client with redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the user.
2. **BigQuery against a real project**: needs a service account (BigQuery Job User + Data Viewer) and a dataset. Only the token endpoint was checked live.
3. **MySQL `verify-full` TLS** against a server with a certificate from a real or private CA (tested: `require` works, a self-signed certificate is rejected).
4. **Provisioning on managed Postgres** (Cloud SQL, RDS) with a non-superuser `CREATEROLE` user: tested on embedded Postgres 18 only. Cloud SQL's `cloudsqlsuperuser` and RDS's `rds_superuser` aren't real superusers.
5. **A restore onto a different Postgres server** (the roles missing): reasoned from the dump and covered by the provisioning test that drops the role; not run end to end.
6. **The 50 MB / 500k-row import caps**: enforced in code, not exercised (the largest import tested was 50,000 rows).
7. **Prometheus scraping** by a real Prometheus (the endpoints were scraped with curl and fetch only); no dashboards or alerts exist yet.
8. **Apps in Firefox and Safari**: the Worker sandbox's isolation was spiked in Firefox 157 and WebKit 27.2 (Playwright's builds, session 10: everything refused, as in Chrome); the rest (the running app, the watchdog, react-grid-layout, the Table, pages and Back/Forward) was exercised in Chrome only (locally and Chromium in CI).
9. **OAuth against real providers** (Google, HubSpot, Slack, Microsoft 365): the presets and quirks were checked against the providers' documentation and a fake provider only. Needs an OAuth app per provider with the redirect URI `<PUBLIC_URL>/api/oauth/callback` and its client ID and secret from the user. **Slack requires HTTPS redirect URIs** (as far as I know): its live check needs a tunnel or an HTTPS `PUBLIC_URL`.
10. **The OAuth popup in Firefox and Safari** (`window.open` plus `postMessage` from the result page; checked in Chrome only).
11. **Large app data**: the Table virtualizes rows and pages server-side (100k rows in the done-when, 25 at a time), but every query result still crosses the sandbox and the store whole: a big unpaged result (thousands of rows in `scroll` mode) wasn't measured.
12. **Git sync against real GitHub** (session 11 used a local git server and a fake GitHub): pushing over https with a fine-grained token through askpass, the REST pull request calls, GitHub's push webhook and its signature, branch protection refusing pushes to main (`[remote rejected]`), fetching a commit by sha (`ensureCommit`), and GitHub Enterprise Server's `/api/v3`. Needs a scratch repo and a fine-grained token (Contents and Pull requests, read and write, on that repo only) from the user.
13. **Big repos**: every deploy of a new commit reads and decodes every directory under `workflows/` and `apps/` (fine for tens of objects; not measured for hundreds), and the bare cache fetches whole branches.

## 13. Known gaps and TODOs carried forward

- **isolated-vm patch:** remove `patches/isolated-vm@7.0.1.patch` (and its `patchedDependencies` entry) once a release has laverdet/isolated-vm#574; prebuilds then load again.
- **Unexplained:** one session-5 run of the crash test hung for 15 minutes; the timer crash kills rather than hangs, so it may be unrelated. Not seen again.
- **Engine:**
  - **Sandbox isolation inside a run:** when the watchdog disposes a run's isolate (a code block stuck in an async loop), other code blocks evaluating at that moment in the same run fail with "Sandbox was reset". Retries absorb it.
  - **Retry backoff sleeps in the worker**, holding a slot. Long backoffs could requeue the run with `availableAt` instead.
  - **Block data isn't scrubbed of secret config values**, only logs and errors are (same rule as Postgres data in M1).
  - `pending` block status is never written.
  - **Paused runs resume on the workers' 5 s poll** (like schedules), so up to 5 s late; children wake their parent at once.
  - **No per-run cap on in-flight `fetch` requests** (the architecture's 50); the shared agent allows 32 connections per origin.
  - **A loop's sync workflow runner holds the worker** while its children run (it waits within the iteration timeout, default 10 s: raise it for slow children); a Workflow block pauses instead.
  - **Renaming a function parameter doesn't rewrite `params.x`** in its blocks (renaming functions and blocks does).
  - A webhook run executing in the API process is resumed by a worker if the API dies (lease); the caller's sync request just fails. That's expected; noted for ops docs.
- **Webhooks:** API key only (no public or HMAC-signed webhooks, no `?api_key=` query parameter); no rate limiting; no OpenAPI document for the public REST routes yet. API keys can read single runs, not list them.
- **Scheduler:** fires up to 5 s late (tick interval); a skipped fire (overlap `skip`) is only logged, not recorded as a run; the catch-up after very long downtime of a dense cron steps through at most 10k fire times.
- **Pool invalidation across processes:** there's still no `NOTIFY resource_changed`. Pooled clients are keyed by the config's `updatedAt`, so changes take effect on the next load.
- **Postgres `describe()`** leaves one named prepared statement per query on the connection until postgres.js recycles it.
- **Connectors (M6):** MySQL evaluates `{{ }}` before the server sees the SQL (Postgres describes first); BigQuery sends null as a NULL STRING (comparing with a number column needs a `CAST`) and objects as JSON text; no multipart REST bodies yet (planned for M6, not built); no `disablePreparedStatements`.
- **User Tasks:** one `out` port (no per-outcome ports); the sidebar badge refreshes every 30 s; group assignees in the editor are plain inputs (problems shown under them, no `{{ }}` markers); no reminders or reassignment; tasks can't be completed over the REST API with an API key.
- **Retention:** runs every 24 h from the first check, not at a fixed hour; migration 0008's `CREATE INDEX` isn't concurrent (fine while `workflow_runs` is small; a large production table needs `CREATE INDEX CONCURRENTLY` by hand).
- **Metrics:** the database gauges keep their last values if a read fails; no histogram of queue wait per run, no per-connector query metrics.
- **Audit export** stops at 100,000 rows (narrow the filters for more).
- **Tests not written yet:** the OIDC callback logic (extract the claim checks into a pure function). The web app has unit tests for its pure modules since M8 (the table and chart models); the rest is covered by the Playwright tests and the (uncommitted) walkthroughs.
- **Web:**
  - Apps have notifications (`pages/apps/notifications.tsx`); the rest of the web app still has no toast system, and `confirm()` is still used for destructive actions (the `Dialog` could replace it).
  - The main bundle is 488 kB; the editor and Monaco are split out, the other pages aren't.
  - The label editors' "Add" button takes the whole field label as its accessible name (the M9 e2e relies on it: `/^Headers Sent with every request/`).
  - The editor has no undo/redo across blocks, no copy/paste of blocks, and no "create function from selection". No release diff view yet (`releases.get` returns the definition for one). Functions can't be test-run on their own yet (their params' `testValue` is stored but unused).
  - The run panel's logs tab shows the first 500 lines. The resources playground still uses textareas.
- **Editor completions** cover the latest finished run only; there's no environment choice for them.
- **Managed database (M7):**
  - No foreign keys or indexes in the schema editor; no promotion of a schema from staging to production; no read-only tier (Use is everything).
  - The managed tables share the platform's Postgres: a heavy query competes with the platform (statement timeout 120 s, `maxRows` 10k, connection limit 50 per role).
  - A CSV export holds one of `optiply_db`'s 5 pooled connections (per process) for the whole download, at the client's pace: a few slow downloads at once make playground and Database page requests wait. (Each cursor fetch has its own statement timeout, so long downloads aren't cut off.) A separate pool, or a cap on concurrent exports, would fix it.
  - Plain `SET`s in queries outlast their transaction on pooled connections (true of every Postgres resource). The Database page pins what it relies on per transaction (search_path, DateStyle, read write, UTC; from the PR #8 review), but workflow and playground queries see whatever an earlier query left behind.
  - The grid edits one cell at a time; no multi-cell paste, no undo. Deleting rows uses `confirm()`.
  - Import problems stop at the first failing batch (≤ 20 problems reported from it), not the whole file.
  - The CSV preview reads the first 256 kB; a column whose only odd value comes later can be guessed wrong (the import then reports the line).
  - MySQL's `NOT IN ({{ [] }})` matches nothing (documented in `mysql.ts`; from the PR #7 review).
  - With `TEST_DATABASE_URL` (a shared server), test databases leave their `owdb_*` roles behind.
- **Apps (M8, M10):**
  - The watchdog's 5 s also stops legitimate synchronous work that long (a huge sort in a JS query); Restart starts afresh (typed values and results lost).
  - No modules, mobile layout, custom components, Query Library, themes or multiplayer editing.
  - Table: no column filters (one search box), no per-row column templates (`currentRow`), no adding rows inside the table (use a Form), no column resizing. Server-side mode needs a second query for `totalRowCount` (or none: Next stays on while a page comes back full). `sql.column` is for SQL resources; REST APIs take the sort as plain values.
  - Pages: no per-page access (pages are navigation, not security: every page's queries run with Use on the app); page names in code strings (`utils.openPage('…')`) aren't rewritten on rename; no page-scoped variables; Navigation renders buttons, not links (no middle-click to a new tab); pages reorder with up/down only; deleting a page uses `confirm()`.
  - Folders: nested folders exist in the API (`parentId`) but the lists show one level and offer no rename; folder names are visible to everyone listing that kind.
  - Apps and workflows from before M10 with an entity or block named `url` or `sql` must rename it (the validator says so).
  - Editor: no dragging between containers ("Inside" moves a component), no undo/redo, no copy/paste of components, REST queries edited as JSON (SQL resources have the full editor), no release diff.
  - Charts: light mode only, no time-scale axes (dates are categories), no texture fills.
  - Automatic queries aren't audited (by design); manual ones are, without values.
  - Rollback asks with `confirm()`, like the workflow editor.
- **OAuth and custom auth (M9):**
  - Disconnecting doesn't revoke the token at the provider.
  - A custom flow's sign-in that keeps failing (a wrong password) is tried again on every query: no back-off.
  - No per-user custom flows (a form step), no admin view of other people's connections (only a count), no status card for custom flows (Test connection signs in).
  - The process refreshing holds a pooled connection (and the lock) while calling the provider; waiters don't.
  - Code steps of custom flows run in a sandbox shared by the process (the API's, or the worker's own), not the run's.
  - The workflow editor's run panel shows `auth_required` as a plain error (no Connect button there yet).
- **Git sync (M11):**
  - GitHub only (other hosts work for push and pull without the pull request API: no PR is opened, a compare link is shown).
  - Resources, folders and config vars aren't in Git; no promotion between instances.
  - Update from branch replaces the draft: no three-way merge of both sides' edits. A conflict needs updating (dropping local edits) or committing first.
  - A protected object's name and description can't be changed in the editors yet (the API's `branchDrafts.save` takes them).
  - On a protected app's main the inspector's inputs aren't disabled (edits are ignored; the banner explains).
  - Deploys aren't retried on their own for problems the instance fixes later (a resource created): Deploy now does it.
  - The GitHub token is one per instance; commits are authored by the person but pushed with that token. No GitHub App.
  - The branch list shows every branch of the repo; no filtering by object.
  - The Git settings page polls deploys every 15 s; there's no notification when a deploy has problems.
- **Not built yet:** multipart REST bodies.

## 14. Next: M12, Python (planned in session 12)

Agreed with the user (session 12): **an nsjail service**, **a curated set of packages**, **data in, data out**. The design is `architecture.md` §2.14; the milestone row is §2.7. Branch `feat/m12-python`, a draft PR from the plan commit. Six steps, each its own commit (big ones split a/b, as in M10 and M11):

1. **The executor** (`apps/code-executor`), starting with a timeboxed spike: nsjail built from source in Docker Desktop and on a GitHub Actions runner (which privileges it needs: `privileged`, or `SYS_ADMIN` plus seccomp/AppArmor relaxed and cgroup v2 delegation), and what an execution costs (a bare interpreter; `import pandas`). Then the image (Python 3.12, nsjail, the curated virtualenv pinned with hashes), the stdlib HTTP server (`/run`, `/check`, `/health`, bearer token, concurrency limit, kill on a closed request), the jail's config and limits, the protocol (stdin in, fd 3 out, logs capped), the JSON conversion (pandas, numpy, datetime, Decimal, NaN). Tests against the container: no environment, no network, no writes outside `/tmp`, memory, time, PID and output limits, a forged result on stdout ignored. `startTestExecutor` (like `startTestMysql`). Sets the latency target for the done-when.
2. **The definition**: `language` on code blocks and loop code runners (sparse), the Python tokenizer and its references in `@ow/expressions` (f-strings, keyword arguments, attributes), scope references, `self_reference`/`not_ancestor`, rename, Python keywords reserved, `python_unsupported`; git-format writes `.py`. Property tests for the tokenizer (round-trips, rename only touching names).
3. **Engine and server**: `PythonRuntime` (HTTP) in the engine's services, `runCode` by language, cancel and timeouts, logs and errors; config (`PYTHON_EXECUTOR_URL`, `PYTHON_EXECUTOR_TOKEN`), `checkDefinition`'s syntax check through `/check`, `workflows.checkPython`, `python_unavailable` without an executor. Engine and server tests against the executor container.
4. **The editor**: the language in the toolbar's Code menu and the inspector (switching keeps the text), Monaco's Python mode, completions from the last run, markers from `workflows.checkPython`, the loop's code runner; Playwright.
5. **Ops**: the `code-executor` Compose service (narrowest privileges from step 1, no published port), CI (the image built in the docker job; the executor started for `check` and `e2e`), a runbook page (limits, adding a package, logs).
6. **Done-when, Compose check, docs**: the done-when in Playwright and on the Compose stack (ask first: it's shared), the latency measured there; this file and `architecture.md`.

Also open, for later milestones (M13+, `architecture.md` §2.7): SQS/Kafka triggers, multiplayer editing (Yjs), AI actions; Git sync's gaps (§13: resources and config vars in Git, three-way merge, renaming on a branch) and a live check against real GitHub (§12, item 12); the apps list (modules, mobile layout, custom components, a Query Library, themes; editor undo/redo and copy/paste).

## 15. How to start the next session

```bash
cd /Users/optiply/optiply-workflows
git switch feat/m12-python && git pull           # M12 (§14)
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install                            # compiles isolated-vm (the patch)
corepack pnpm dev:db &                           # Postgres on :5433
corepack pnpm --filter @ow/server dev &          # API + worker on :3000 (auto-migrates; needs ENCRYPTION_KEYS in .env)
corepack pnpm --filter @ow/web dev               # http://localhost:5173
```
