# Optiply Workflows: a Retool-style internal platform

## Context
Optiply wants its own internal-tools platform, built like Retool but with our own interface. It will let us connect data sources (**Resources**), automate backend processes (**Workflows**), keep simple tables (**Database**), and later build internal UIs (**Apps**).

The repo (`/Users/optiply/optiply-workflows`) is empty, so this is a greenfield build.

Decisions so far:
- **Stack:** TypeScript full-stack (React + Vite, Node, Postgres).
- **Audience:** a single org, self-hosted, for Optiply internal use only.
- **MVP focus:** Resources and Workflows first. Database and the App builder come in later phases.

Part 1 explains how Retool works. Part 2 is the build plan.

---

# Part 1: How Retool works

> Retool runs two app builders as of 2026. In **classic apps** you drag and drop components and wire them up with `{{ }}` bindings. The **new app builder** (beta since May 2026) has an AI agent that generates React 19, shadcn and Tailwind code, with server-side TypeScript functions. Everything below describes the classic model, which is the core of the product and what we are cloning.

## 1.1 Platform architecture
- **One backend image, many roles**, chosen with `SERVICE_TYPE`:
  - `api`: serves the frontend and REST API, and runs queries from apps.
  - `db-connector` / `db-ssh-connector`: execute queries against resources.
  - `jobs-runner`: exactly one replica. Runs migrations, Git sync and cron jobs.
  - `multiplayer`: WebSocket co-editing.
  - `workflows-worker`: a Temporal worker.
  - `workflows-backend`: runs queries for workflows and stores block results.
  - `code-executor`: user JS and Python, sandboxed with nsjail.
  - `agent-*`.
- **Dependencies:**
  - **Postgres**: the platform database holding apps, resources (encrypted), users, permissions, `page_saves` history, `audit_trail_events`, `workflow_run` and `workflow_block_results`.
  - **Temporal**: durable execution for Workflows and Agents.
  - Optional Redis (cache) and S3 (large block results).
- **Secrets:**
  - `ENCRYPTION_KEY` (AES-GCM) encrypts resource credentials. Losing it means losing every resource.
  - `JWT_SECRET` signs sessions.
- **Queries always run on the server.** The browser sends the query ID plus the evaluated `{{ }}` values. The server loads the resource config, decrypts the credentials, and executes. Credentials never reach the browser.
  - SQL `{{ }}` values become **prepared-statement bind parameters**, which prevents SQL injection but means you cannot pass a dynamic table name.
  - `current_user` is injected on the server, which prevents spoofing.
- **Tech stack:** TypeScript, Node and React (18), built with Vite. App state is probably Redux plus Immutable.js. User JS runs in a **cross-origin iframe**, on a separate `SANDBOX_DOMAIN`.

## 1.2 Resources (connections)
- There are about 80 connector types:
  - **SQL:** Postgres, MySQL, MSSQL, Snowflake, BigQuery, …
  - **NoSQL:** Mongo, Redis, Dynamo, …
  - **APIs:** REST (manual or from an **OpenAPI spec**), GraphQL, gRPC.
  - **SaaS:** Stripe, Slack, Google, Salesforce, …
  - **AI:** OpenAI, Anthropic, …
  - **Storage and messaging:** S3, SQS, Kafka.
- **Config per environment:** each resource has separate host and credentials for `production` and `staging`, plus any custom environments. Apps and workflows stay the same; only the resource binding changes, selected with `_environment` or `?environment=`.
- **Auth methods:**
  - API key, Basic, Bearer, AWS SigV4, Google service account.
  - **OAuth2**: authorization code, client credentials or PKCE, with tokens stored per user and per environment, or shared via "share credentials between users".
  - **Custom auth flows**: ordered steps (form → API request → JS → define variable) plus a refresh flow that retries once after a non-2xx response.
- **Networking:** SSH tunnels through a bastion host, SSL client certs, and an outbound IP allowlist.
- **SQL query editor:**
  - **SQL mode**: raw SQL with bind params.
  - **GUI mode** for writes: insert, update, upsert, delete, plus bulk variants by primary key. Its fields are Table, Changeset, Filter-by and Primary key. A guard blocks writes to multiple rows unless you opt in.
- **REST query editor:** method, path, params, headers, cookies, and body (JSON, raw, form, multipart or binary). When a spec is attached it guides you through the operation.
- **Config variables and secrets:** per-environment values, referenced as `{{ retoolContext.configVars.X }}`. Secrets stay on the server.
- **Permissions:** Use / Edit / Own per group, on resources and resource folders, set per environment. Enterprise adds row and column **access policies** using user attributes.
- **Pooling and timeouts:** Postgres pools default to 10 connections; query timeout defaults to 120s (720s in workflows).

## 1.3 Workflows
- **Canvas model:**
  - Named **blocks** are joined by **connectors**, starting from `startTrigger`.
  - Fan-out runs in parallel. A block with several parents waits for all of them.
  - Every block exposes `name.data`, `name.error` and `name.metadata`. Any block that already ran can be read with `{{ }}`.
- **Block types:**

  | Block | What it does |
  |---|---|
  | startTrigger | `data`, `headers`, `pathParams`, `urlParams` from the trigger |
  | Resource query | Any resource, same editors as in apps |
  | Code | JS (Node 20, npm via package.json) or Python 3.x (requirements.txt), sandboxed with nsjail |
  | Branch | if / else-if / else, each with its own output connector |
  | Filter | iterable plus an expression on `value` / `index` |
  | Loop | runner = query / JS / function / workflow; parallel, sequential or batch(size, delay); per-iteration timeout, retries and error policy |
  | Function | Reusable subflow with named params; called from a Function block, `await fn()` in JS, or a Loop |
  | Workflow | Calls a child workflow, sync ("Finished") or async ("Queued") |
  | Response | HTTP status plus JSON body, the reply to a sync webhook or app call |
  | Wait | Durable delay, up to 60 days |
  | User Task | Human-in-the-loop. Assigns an app-based task to users or groups; the workflow resumes with its output. |
  | AI Action / Invoke Agent | LLM actions (generate, classify, extract…) and agents |
  | Global error handler | Unconnected block that runs on any unhandled error |

- **Settings on every block:** `timeoutMs` (default 10s), `retryCount`, `interval`, `exponential`, `coefficient`, `maxInterval`, and `finally` = stop or continue. "Continue" exposes a red **on-error** connector.
- **Triggers:**
  - **Manual**: the editor's Run button, using test JSON.
  - **Schedule**: interval or cron with a timezone; runs never overlap; jitter is added.
  - **Webhook**: `POST /api/workflows/:id/startTrigger` or an alias with `:params`, authenticated with an `X-Workflow-Api-Key` header. It is **synchronous if a Response block exists**. `?environment=` picks the environment.
  - Also: called from an app, called from another workflow, SQS/Kafka polling, and Retool platform events.
- **Context objects:** `workflowContext {currentRun, lastRun, lastSuccessfulRun, environment, triggerType}` and `retoolContext {configVars, secrets, users, groups}`.
- **Engine:** each run is a Temporal workflow. A worker calls code-executor (nsjail) for code blocks and workflows-backend for queries. Block results live in **Postgres or S3, not in Temporal**, because of Temporal's payload size limits.
- **Limits:**
  - Async runs: 30h. Sync runs: 15 min to the Response block.
  - 2.5 GB memory per run.
  - 50 in-flight requests per run.
  - 100 runs of a workflow per 15 min.
- **Versioning:** an autosaved **draft**, plus SemVer **releases**. Only the live release runs from schedules and webhooks.
- **Run history:** each run shows per-block status, logs, timing and data, with filters and JSON export. Default retention is 30 days.
- **IDE features:**
  - Run a single block, using cached upstream results.
  - Autolayout, minimap, README.
  - "Create function" from a selection of blocks.
  - Libraries tab, environment picker, AI-generated workflows.

## 1.4 Retool Database
- **What it is:** managed **Postgres** (self-hosted: a separate `retooldb-postgres`), exposed as a built-in resource named "Retool Database".
- **Spreadsheet-like editor:**
  - Tables list and tabs, inline cell editing, add or delete rows.
  - Filter, sort, hide and pin columns.
  - **Import CSV** or generate a schema with AI; export to CSV.
  - An `id` primary key is added automatically; foreign-key fields can open the linked row.
  - Field options: type, nullable, unique, default value (including SQL defaults).
- **Environments:** each environment gets its own isolated tables. Schemas are **migrated** between environments using a reviewed diff and generated SQL; data is not copied.

## 1.5 Apps (classic builder)
- **Layout:**
  - A **12-column grid** with fixed-height rows. **Frames** are Main, Header, Sidebar (240px), Modal, Drawer and Split pane.
  - **Containers** hold nested grids and support tabbed, stepped and multi-view variants. **Stack** is a flexbox container.
  - **List View / Grid View** repeat a template using `item` and `i`.
  - **Multipage** apps have global or per-page scope. **Modules** are reusable sub-apps with typed inputs and outputs.
  - A separate **mobile layout**, used below 600px.
- **Components:** about 100, grouped as buttons, Plotly charts, containers, forms, the Table, date, number, select and text inputs, presentation components, and special ones (file, signature, scanner, LLM chat).
  - Every component has an `id`, **properties** (configurable and runtime state), **methods** (`setValue`, `setHidden`, …) and **events**.
  - **Table** is the flagship component: selection, server-side pagination, filters and sort, editable cells (`changesetArray` → bulk-upsert query), row actions, grouping and export.
  - **Form** collects child `formDataKey`s into `form.data`, with validation and submit. It can be generated from a DB table, along with an insert query.
- **Reactivity:**
  - Every field can contain `{{ js }}`. All components, queries, transformers and variables are global identifiers.
  - A **dependency graph** re-evaluates the values that depend on a change, spreadsheet-style.
  - **Transformers** are pure.
  - **JS queries** have side effects: `query.trigger({additionalScope})`, `setValue`, and `utils.*`.
  - **Variables** hold temporary state; `localStorage` and `url` params are also available.
  - JS runs in a sandboxed cross-origin iframe with `_`, `moment`, `uuid`, `numbro` and `Papa` preloaded.
- **Queries in apps:**
  - Run behavior is **automatic** (reads and GETs) or **manual** (writes).
  - Options: run on page load, periodic runs, watched inputs, disabled-if, a confirmation prompt, throttle, timeout, cache TTL (on the server), and failure conditions.
  - Success and failure **event handlers** are how queries get chained.
- **Event handlers:** control query, control component, run script, go to app/page/URL, notify, set variable, set localStorage, set URL params, copy, export. Advanced options include "only run when", debounce and throttle.
  - Handlers on the same event run in parallel.
- **Reusing queries:** the **Query Library** offers org-wide versioned queries; apps can pin a version or follow the latest.
- **Serialization:** **Toolscript (`.rsx`)**, a JSX-like format:
  - `main.rsx` and `functions.rsx`.
  - Query bodies extracted to `lib/*.sql` and `*.js`.
  - **Layout stored separately** in `.positions/*.json`, which keeps diffs clean.
- **Releases and history:**
  - Every save is a history point. SemVer releases can be draft or published.
  - URL params: `_releaseVersion`, `_historyOffset`, `_environment`, `_embed`.
- **Extensibility:** custom component libraries are React built with a CLI and loaded in a sandboxed iframe through `Retool.useStateX` hooks. Also themes (tokens, light and dark), custom CSS, preloaded JS, Embed (signed single-use URLs for external users), and public apps.
- **Collaboration:** multiplayer editing (CRDT over WebSockets, last write wins, presence) and Debug Tools (console REPL, timeline, state and dependency inspector, linting, performance).

## 1.6 Org-level features
- **Tenancy:** Instance → Organization → **Spaces** (Enterprise: isolated sub-orgs on one instance).
- **Seats and groups:**
  - Seat types: builder, internal user, external user.
  - Default groups: `admin`, `editor`, `viewer`, `All Users`. Custom groups are available.
- **Permissions:** Use / Edit / Own on apps, resources (per environment), workflows, agents and folders. When several grants apply, the highest wins.
- **Admin controls:** granular admin roles, and **user attributes** (`current_user.metadata.*`) for row-level logic.
- **Identity:** SSO through SAML or OIDC with group sync at login, JIT provisioning, SCIM 2.0, and forced SSO per domain.
- **Audit logs:** logins, page views, query runs with parameters, and permission changes. Export to CSV or Datadog.
- **Source Control:** GitHub, GitLab and others. "Protected" objects are edited on branches, then go through a PR; merging auto-deploys. Multi-instance promotion (dev → prod).

## 1.7 Open-source reference points

| Project | Licence | Study it for |
|---|---|---|
| **Appsmith** | Apache-2.0 | `{{ }}` evaluation in a Web Worker: acorn dependency extraction, topological evaluation. Safe to borrow ideas from. |
| **Lowcoder/Openblocks** | AGPL | A clean typed node-graph eval engine. Study only. |
| **ToolJet** | AGPL | NestJS, TypeORM, Postgres, Temporal, isolated-vm, Yjs. Closest in shape to our stack. Study only. |
| **Windmill** | AGPL | Postgres as the job queue, nsjail workers, flows. Study only. |
| **n8n** | Sustainable Use (not OSI) | Node and plugin model. Do not copy code. |

**Rule:** we write our own code. We borrow ideas only, and code only from Apache-2.0 or MIT sources.

---

# Part 2: Build plan

## 2.1 Key decisions

| Area | Decision | Why |
|---|---|---|
| Execution engine | **Our own run-level orchestrator on Postgres.** No Temporal, no pg-boss. `workflow_runs` is the queue: claimed with `FOR UPDATE SKIP LOCKED`, workers woken by `LISTEN/NOTIFY`, protected by leases with **fencing epochs**. Each block result is checkpointed to `block_runs`. | Temporal adds a cluster plus replay/versioning costs on every interpreter change. Block-as-job on pg-boss has a join race, two sources of truth, about 0.5s of poll latency per hop, and can't support `await fn()` from JS. Durable timers, retries and leases are about 400 lines of code when the program is data. Hide the engine behind `RunDispatcher`/`RunExecutor` interfaces so it can be swapped. |
| Sync webhooks | The API runs the run in-process (the same engine, under a semaphore). When the semaphore is full, the run is queued and the API waits on `NOTIFY`. After `syncTimeoutMs`, or if the run suspends, it returns `202 {runId}`. | Target p50 under 50ms. |
| JS sandbox | **isolated-vm.** One isolate per run lease and a fresh context per evaluation. A snapshotted stdlib (lodash, dayjs, uuid, papaparse, numbro). A watchdog calls `dispose()` at the timeout, and memory is capped (128MB by default). Host bridges provide `fetch` (SSRF-guarded), `console` (into run_logs, redacted), and `await fn()`. | No Node APIs are exposed, so `process.env` and `ENCRYPTION_KEY` stay out of reach. The `CodeRuntime` interface allows a QuickJS or remote fallback. Python comes later as a separate nsjail executor. |
| Backend | Fastify v5 + **tRPC v11** for UI↔API calls, plus REST + zod with OpenAPI for public routes (webhooks, runs API). | End-to-end types, and clean public contracts. |
| DB | Postgres 18 (native `uuidv7()`), Drizzle ORM with committed SQL migrations, postgres.js driver. | |
| Frontend | Vite, React 19, TanStack Router + Query, **@xyflow/react** canvas + dagre autolayout (`@dagrejs/dagre`, MIT; elkjs was dropped in M3 because it's EPL-2.0), **Monaco** (bundled locally), shadcn/ui + Tailwind v4, zustand for editor state. | |
| Auth | Google Workspace OIDC limited to `optiply.nl`, plus a break-glass local admin. Groups `admins` and `all_users` plus custom groups. Use/Edit/Own permissions per object, set per environment. | Internal-only use. |
| Secrets | AES-256-GCM with versioned keys (`ENCRYPTION_KEYS=v1:…,v2:…`), and **AAD = `table:rowId:envId`** so a ciphertext can't be swapped into another row. A `rekey` CLI re-encrypts existing rows. Secrets are never returned to the browser; responses show `{set:true}`. | |
| Deploy | One Docker image (`node:<lts>-bookworm-slim`, which isolated-vm needs for glibc). `ROLE=api|worker|migrate|all`. Docker Compose for local and server use. | This mirrors Retool's `SERVICE_TYPE` pattern. |

## 2.2 Workflow semantics (filling the gaps Retool leaves undocumented)

- **Block status:** `pending | running | succeeded | errored | failed | skipped | waiting | cancelled | interrupted`.
- **Edges** carry ports: `out`, `error`, `cond:<id>`, `else`.
- **Readiness:**
  - A block becomes ready when every incoming edge is resolved, and it runs if **at least one edge fired**.
  - If every incoming edge is dead, the block is `skipped`, and the skip propagates downstream (dead-path elimination). So a join after an if/else just works.
- **Branch:** only the first truthy condition fires. A condition that throws is a block error.
- **Errors:**
  - `finally=stop`: the run fails, in-flight sibling blocks are aborted, and the global error handler runs.
  - `finally=continue`: the block's `out` edge is dead and its `error` edge fires. To mean "always run C", connect both `out` and `error` to C.
- **References:** an expression may only reference static graph **ancestors** plus globals. Anything else is a lint error. A skipped ancestor evaluates to `{data:null, error:null, metadata:{status:'skipped'}}`.
- **Response:**
  - The first Response block sends the HTTP reply, and execution **continues**. Later Response blocks are marked `ignored`.
  - No Response reached: `200 {runId, status}`. Failure before a Response: `500`, unless the error handler contains a Response block.
- **Loop:**
  - `data` is an array the same length and order as the input.
  - `metadata.iterations[]` records each iteration's status.
  - Each iteration is checkpointed (`loop1[17]`), so a crash resumes without recomputing completed iterations.
  - `onError` is `stop` or `continue` (continue puts `null` in the failed slot).
- **Functions:** a subgraph with `params`. It returns the data of its return block. Called from a Function block, a Loop runner, or `await fn()` in JS.
- **Wait, sync child workflow, and User Task** persist the run as `waiting` with an `available_at`, which frees the worker slot. Time spent waiting doesn't count toward the run timeout (default 15 min, maximum 6h).
- **Delivery:** blocks execute at least once, and their outputs are committed exactly once (epoch fence plus unique `(run_id, block_key)`).
  - The scope exposes `idempotencyKey`.
  - Webhooks accept an `Idempotency-Key` header.
  - A run whose worker keeps crashing fails after 3 recoveries.
- **Schedules:** our own scheduler, rather than a library's.
  - `workflow_triggers.next_fire_at` holds the next fire time. Every worker ticks every 5s using SKIP LOCKED.
  - Overlap policy is `skip` (default), `queue` or `allow`. Runs are inserted with `ON CONFLICT (trigger_id, scheduled_for)`, so each fire happens exactly once.
  - After downtime the schedule catches up with one run, not a storm.
  - Timezone defaults to `Europe/Amsterdam`.

## 2.2a How §2.2 is tested

Built in M2 unless the status says otherwise. Engine tests are in `packages/engine/test/`: `semantics.test.ts`, `advanced-semantics.test.ts`, `functions-loops.test.ts` and `children.test.ts` (in-memory store), and `dispatcher.test.ts`, `crash.test.ts`, `scheduler.test.ts`, `inline.test.ts`, `waiting.test.ts`, `loops-pg.test.ts`, `children-pg.test.ts`, `tasks-pg.test.ts` and `retention.test.ts` (Postgres). Server tests are in `apps/server/test/`. Validator tests are in `packages/definition/test/validate.test.ts`; schema tests in `packages/db/test/workflows.test.ts`.

| Rule | Status | Covered by |
|---|---|---|
| Block statuses | ✅ `running`, `succeeded`, `errored`, `failed`, `skipped`, `waiting` (M5), `cancelled`, `interrupted`. `pending` is never written: a block gets a row when it starts or is skipped. | semantics (all groups); dispatcher "recovers runs…" (`interrupted`); waiting "pauses at a wait…" (`waiting`) |
| Edge ports | ✅ | semantics "branch", "errors"; validator "edges" |
| Readiness: all edges resolved, at least one fired | ✅ | semantics "fans out in parallel, and a join waits for every parent" |
| Dead-path elimination, join after if/else | ✅ | semantics "skips a block whose incoming edges are all dead…", "runs a join after if/else…", "skips blocks that nothing connects to" |
| Branch: first truthy only; a throwing condition is a block error | ✅ | semantics "branch" |
| `finally=stop`: run fails, in-flight siblings aborted | ✅ | semantics "with finally=stop…" |
| Global error handler: runs on failure (incl. run timeout) with `{ block, code, message }`, reads the main path, own 60 s limit; the run still fails | ✅ (M5) | advanced-semantics "the global error handler" (all); server webhooks "answers with the error handler's Response…"; validator "the error handler" |
| `finally=continue`, and "always run C" via both ports | ✅ | semantics "with finally=continue…", "always runs a block connected to both out and error" |
| References: ancestors and globals only | ✅ | validator "references"; semantics "refuses an invalid definition…"; server "refuses to start runs that would fail anyway" |
| A skipped ancestor reads as `{data:null, error:null, metadata:{status:'skipped'}}` | ✅ | semantics "runs a join after if/else…" |
| Response: the first one replies, execution continues, later ones `ignored` | ✅, including across a resume | semantics "response", "does not reply again when an earlier lease already did" |
| Response HTTP mapping (no Response → 200 `{runId, status}`; failure → 500, or the error handler's Response) | ✅ (M4 webhooks, M5 error handler) | server webhooks "answers with the Response block's status, headers and body", "answers 200 { runId, status } without a Response block, and 500 when the run fails first"; semantics "has no response when no Response block runs" |
| Loop: data in input order, per-iteration checkpoints `loop1[17]`, `onError` stop/continue, modes, per-item timeout and retries | ✅ (M5). `metadata.iterations` is a summary `{ total, succeeded, failed, resumed }` plus the first 100 failures; each item's status is its own row. | functions-loops "loops" (all); loops-pg (batched commits, errored rows); crash "resumes a 10,000-iteration loop after kill -9…"; server "lists a loop's iterations…" |
| Functions: subgraph with `params`, returns its return block's data; Function block, loop runner, `await fn()` | ✅ (M5). Calls aren't checkpointed (they belong to the calling block). | functions-loops "functions" (all); validator "functions"; server "runs loops and functions that query resources…" |
| Wait / sync child, `waiting` with `available_at`, waiting not counted toward the run timeout | ✅ (M5) | advanced-semantics "wait"; waiting "waiting" (all, incl. surviving every worker stopping and the timeout test); children-pg "pauses the parent while its child waits…"; children "the Workflow block" |
| User Task: the run waits (no worker held) until an assignee answers; completing it wakes the run, also when no worker ran at the time; expiry fails the block; a run ending any other way closes its tasks | ✅ (M6). The answer is checked against the fields (`checkTaskSubmission`, browser and server); completion locks the run row first, so a pause and an answer can't miss each other. | tasks-pg (all, incl. "a run waits for its task, and completing it resumes the run, even with no worker running at the time"); definition tasks; server tasks; e2e tasks.spec |
| Cancel: queued/waiting at once; running stopped (SQL cancelled, fetch aborted); children cascade | ✅ (M5) | advanced-semantics "cancel"; waiting "cancel" (all); children-pg "cancels the children…"; server "cancels a running draft run…" |
| Run timeout (default 15 min, max 6 h) | ✅ | dispatcher "claims a queued run…" (15 min deadline); semantics "fails the run at its deadline…"; definition schema "bounds the run timeout…" |
| Delivery: at least once, committed exactly once | ✅ | crash "resumes a run on another worker after kill -9…"; dispatcher "fences off a zombie worker…", "never overwrites a committed result…"; semantics "delivery and resume"; db "commits one result per block key" |
| `idempotencyKey` in scope | ✅ (the caller's key, or the run id) | dispatcher "exposes the caller's idempotency key…" |
| Webhook `Idempotency-Key` header | ✅ (M4) | server webhooks "gives a repeated Idempotency-Key the same run and reply"; engine inline "returns the earlier run for a repeated idempotency key"; db "accepts an idempotency key once per workflow" |
| Fails after 3 recoveries | ✅ | dispatcher "recovers runs whose lease expired and fails one that keeps losing its worker" |
| Retention (§2.3): runs finished more than 30 days ago are deleted in short transactions, never blocking the queue | ✅ (M6) | retention "deletes 100k old block rows in short statements while the queue keeps claiming runs" (no lock waits, every statement ≤ 5,000 rows), "the daily job" |
| Schedules: tick with SKIP LOCKED, each fire once, catch-up with one run, overlap `skip`/`queue`/`allow`, Europe/Amsterdam default | ✅ (M4) | engine scheduler (all groups, incl. the minute-by-minute "1-minute cron whose runs take 2 minutes" and "across the Amsterdam DST changes"); definition cron "daylight saving time in Europe/Amsterdam"; db "records each schedule fire once…"; server releases "runs the live release when a published schedule comes due" |

## 2.3 Data model (Drizzle, `packages/db`)
- **Identity:** `users`, `sessions`, `groups`, `group_members`, `permissions(group_id, object_type, object_id?, environment_id?, level)`, `environments`, `folders`.
- **Resources:**
  - `resources`
  - `resource_configs(resource_id, environment_id, config jsonb, secrets)`. In M1, `secrets` became one self-describing token `<keyVersion>.<iv>.<ciphertext>.<tag>` instead of separate ciphertext, IV and key-version columns; see `docs/handoff.md` §2.
  - `oauth_tokens` (M9): one row per resource config and owner (`user_id` null = the shared account): the encrypted tokens of an OAuth authorization-code connection, or a custom auth flow's variables; expiry, granted scopes, the account's label, `status` active/reconnect, and a fingerprint of the consent settings (or the flow) they belong to. `UNIQUE NULLS NOT DISTINCT (resource_config_id, user_id)`.
  - `config_vars` + `config_var_values` (per environment, optionally secret)
  - `api_keys` (prefix + sha256 hash, scoped to workflows and environments; built in M4 with expiry, revoke and last use). Runs record the key that started them (`workflow_runs.api_key_id`).
- **Workflows:**
  - `workflows(draft_definition, draft_revision, live_release_id, max_concurrent_runs)`
  - `workflow_draft_snapshots`
  - `workflow_releases(version semver, definition frozen, definition_hash)`
  - `workflow_triggers`: the runtime projection of the live release's triggers, holding the webhook alias and `next_fire_at`. M4: rows are matched by kind and name so ids survive releases; `alias_shape` (unique) keeps two live webhooks off the same URLs; `environment_id` and `last_fired_at` for schedules.
- **Runs:**
  - `workflow_runs`: status, input/output/error, lease fields, `available_at`, `idempotency_key`, `scheduled_for`, `parent_run_id`. In M2, `output` became `response` (the first Response block's reply), and each run points at exactly one release or draft snapshot. M5 added `suspended_at` (when a run paused; its deadline moves on by the time spent waiting) and `cancel_requested_at`. Child runs use `parent_run_id` and an idempotency key `child:<parentRun>:<block>:<attempt>`.
  - `block_runs(run_id, block_key, status, attempt, timings, error, metadata)`. M2 added `epoch` (the lease that wrote it) and `port` (the output that fired). M5: loop iterations are rows keyed `loop1[17]`; a `waiting` row's metadata holds `until` (and a child run's `childRunId` and `since`; M6: a User Task's `taskId`).
  - `block_run_payloads` (data jsonb, 10MB cap)
  - `run_logs`
  - `user_tasks` (M6): one per run and block; status `open | completed | expired | cancelled`; title, description, fields (defaults evaluated) and outcomes as they were when it opened; assignee user and group ids (resolved from emails and group names); `due_at`; the answer (`outcome`, `values`, `completed_by`, `completed_at`).
- **Audit:** `audit_events`, append-only; the app's DB role gets INSERT/SELECT only. M6: filters and a streamed CSV export for admins.
- **Managed database** (M7): `managed_databases(environment_id, schema_name, role_name)` records each environment's schema and role; `resources.system_kind` (`database`) marks the built-in `optiply_db` resource, whose per-environment `resource_configs` row logs in as that role. The tables themselves live in the `owdb_<environment>` schemas of the same database (§2.10).
- **Apps** (M8): `apps(slug, draft_definition, draft_revision, live_release_id, folder_id)` and `app_releases(version semver, definition canonical, definition_hash)`; `app` is a folder and permission object type (grants for every environment only). No draft snapshots: nothing pins an app's draft revision. App definitions are `@ow/app-definition`'s format (§2.11).
- **Git sync** (M11): `git_settings` (one row: repo URL, branch, the token and webhook secret encrypted together, and the deploy state: the deployed commit, the last check and error, the lease and pending request); `git_objects` (each workflow and app directory on the branch: the tree it last deployed, its status `deployed`/`problem`/`missing`, its problems, the version made live); `git_deploys` (each new commit deployed, or Deploy now: per-object outcomes; the last 200 kept); `workflows.git_protected` and `apps.git_protected`; `workflow_releases.git_commit` and `app_releases.git_commit` (releases made by Git sync, `created_by` null). More in §2.13.
- **Retention** (M6): once a day one worker (claimed through `maintenance_jobs`) deletes runs that finished more than `RUN_RETENTION_DAYS` (30) ago, and draft snapshots no run uses, at most 5,000 rows per statement, each its own transaction (payloads, then blocks and logs, then the run rows). Runs with an unfinished child are kept. `workflow_runs_finished_idx` finds them.

## 2.4 Workflow definition (`packages/definition`, zod v4)
- **Shape:** `{schemaVersion, settings, triggers{webhook, schedules[], manual}, blocks[], edges[], functions[], layout}`.
- **Block types:** `startTrigger`, `errorTrigger`, `resourceQuery`, `code`, `branch`, `filter`, `loop`, `function`, `workflow`, `response`, `wait`, `userTask`.
- **Settings on every block:** `{timeoutMs, retry{count, intervalMs, exponential, coefficient, maxIntervalMs}, finally}`.
- **Built for Git:**
  - Block **names** are the identity. Resources and child workflows are referenced by **slug**.
  - Layout is stored separately, and JSON is canonical.
  - `definition_hash` covers everything except layout.
  - No secrets appear in a definition.
- **Validator** (`validateDefinition()` returns diagnostics for the editor):
  - unique names
  - valid ports
  - no cycles
  - exactly one start trigger
  - expression identifiers are ancestors or globals
  - no Response block inside functions
  - each query passes its connector's `querySchema`
  - at release time, the publisher has Use on every resource in the target environments

## 2.5 Connectors (`packages/connectors`)
- **Interface:** `Connector { type, configSchema, secretsSchema, querySchema, ui, poolKey, createClient, destroyClient, testConnection, compile, execute, introspect? }`.
- **Pools:** a PoolManager holds them in an LRU and evicts idle pools. `NOTIFY resource_changed` invalidates them everywhere.
- **SQL `{{ }}` → bind parameters**, through one shared lexer that is aware of quotes and comments:
  - Postgres uses `$n` (arrays bind natively, so you write `= ANY({{ids}})`).
  - MySQL uses `?` and expands arrays.
  - BigQuery uses `@pN` named parameters.
  - A `{{ }}` inside a string literal is a validation error that suggests a fix.
  - **Sort columns (M10):** `{{ sql.column(value, ['name', 'price'], 'id') }}` and `{{ sql.direction(value) }}` become SQL text, not parameters. The compiler accepts them only as the whole `{{ }}` with the columns written as string literals (`sqlFragment`); the connector evaluates the value like any other (in apps, the browser sends it) and checks it against that list (or the fallback) before quoting it as an identifier for the dialect (`fragmentText`, `"p"."name"` or `` `p`.`name` ``) or writing `ASC`/`DESC`, all before the database sees the statement. `sql` is a stdlib global (server sandbox and app Worker), so it's a reserved name since M10.
  - Per-resource `disablePreparedStatements` is for Own/admin only (not built: every connector binds parameters).
- **MVP connectors:**
  - **Postgres** (postgres.js): `SET LOCAL statement_timeout`, cancel on abort, `maxRows`, optional read-only mode.
  - **REST** (undici):
    - Config: base URL, default headers and parameters, `allowedHosts`.
    - Auth: none, API key, bearer, basic, or OAuth2 client-credentials (tokens cached, refreshed once on a 401). M9: OAuth2 authorization code (shared or per-user accounts; tokens from the server through `QueryContext.credentials`) and custom auth flows (variables rendered into the resource's headers and parameters); see §2.12.
    - Bodies: json, form, raw or multipart.
    - Non-2xx responses error.
  - **MySQL** (mysql2, built in M6): server-side prepared statements, arrays expanded, `KILL QUERY` on cancel and timeouts, a read-only session option, `maxRows`, no local file reads.
  - **BigQuery** (built in M6 on the REST API with undici, not `@google-cloud/bigquery`): a service-account key (RS256 JWT), typed named parameters, `maximumBytesBilled` guardrail (10 GiB default), job labels for cost attribution (the resource's plus workflow, run and environment), the job cancelled on cancel and timeouts.
- **The built-in database resource** (M7): `optiply_db` is a Postgres resource the platform keeps configured per environment (§2.10); nobody can edit, re-point, rename or delete it, and testing it with other settings is refused (it would send the stored password elsewhere). Built-in resources list after people's own, so new query blocks keep defaulting to theirs.
- **Who runs as whom:** editor test runs use the editing user's Use permission. Released runs (schedule, webhook) were permission-checked when the release was published.

## 2.6 Monorepo layout (pnpm + Turborepo)
```
apps/
  web/      React editor + run history + resources UI (later: database editor, app builder)
  server/   main.ts ROLE switch → api/ (Fastify, tRPC, webhooks, SSE) · worker/ (claim loop, reaper,
            scheduler tick, retention) · cli/ (rekey, create-admin)
packages/
  definition/   zod schema, validator, graph utils, canonical JSON + hash           [web+server]
  git-format/   workflows and apps as repo files and back (M11)                     [web+server]
  expressions/  {{ }} parser, acorn free-identifier analysis, rename refactor, SQL lexer [web+server]
  engine/       orchestrator, block executors, scheduler, dispatcher (claim/lease/fast path)
  sandbox/      CodeRuntime, IvmRuntime, esbuild stdlib bundle + snapshot, host bridges
  connectors/   registry, PoolManager, postgres/ rest/ mysql/ bigquery/
  db/           Drizzle schema, migrations, repositories, LISTEN/NOTIFY helper
  crypto/       AES-GCM versioned keys + AAD, api-key hashing, secret redaction
  api-contract/ tRPC router types + REST zod/OpenAPI
  ui/           shared shadcn components (reused by the App builder later)
```
- **Files that carry the design:** `packages/definition/src/schema.ts`, `packages/engine/src/orchestrator.ts`, `packages/engine/src/dispatcher.ts`, `packages/db/src/schema.ts`, `packages/sandbox/src/ivm-runtime.ts`, `packages/connectors/src/types.ts`.
- **Editor features:**
  - **Canvas:** React Flow nodes per block type, ports for `out`, `error` and `cond:*`, a dagre-based autolayout button, and a minimap.
  - **Inspector panel:** each block type has its own form. SQL and JS use Monaco, with a `.d.ts` generated from the last run's outputs so `query1.data[0].` autocompletes.
  - **Running:** Run (with test JSON), plus **Run block**, which uses the cached upstream outputs.
  - **Live status:** each block shows its status on the canvas, pushed over SSE.
  - **Run history panel:** filters, per-block data, logs, timing, and JSON export.
  - **Saving:** autosave with `draft_revision` (optimistic concurrency). A Releases tab handles publishing and rollback.
  - **App navigation:** the sidebar has Workflows, Resources, Runs and Settings (environments, groups, config vars, API keys, audit). Database and Apps are added in later phases.

## 2.7 Milestones

| # | Scope | Done when |
|---|---|---|
| **M0 Foundations** | `corepack enable` (pnpm), Docker/OrbStack (**neither is on PATH today**). Monorepo skeleton, CI (lint, typecheck, test), Docker image and Compose, Drizzle + migrate role, Google OIDC login, groups/admin, audit skeleton. **isolated-vm spike on Node 24 LTS** (fall back to Node 22). | `docker compose up` gives a working login. CI green. The spike shows a fresh isolate starting in under 10ms with the stdlib, and infinite-loop and memory-bomb tests are killed cleanly. |
| **M1 Resources** | crypto, environments (production/staging), resource CRUD per environment, Postgres + REST connectors, test connection, query playground with `{{ }}`, permissions, config vars and secrets | Snapshot tests show no secret in any API response. SQL injection fixtures stay inert and `pg_stat_activity` shows `$1`. A ciphertext swapped between rows fails to decrypt. |
| **M2 Headless engine** | definition + validator, orchestrator (startTrigger, code, resourceQuery, branch, filter, response), retries/timeouts/finally, claim/lease/reaper, block_runs/logs, manual-run REST API | **Golden semantics tests** cover every rule in 2.2. A `kill -9` of a worker mid-run resumes without re-running completed blocks. The zombie-worker fencing test passes. |
| **M3 Editor** | canvas, block inspectors, Monaco + generated types, autosave, Run / Run block, SSE live status, run history | Playwright: build "query → branch → code → response", run it, rename a block, and its references update. |
| **M4 Releases & triggers** | semver releases and rollback, trigger projection, webhooks (sync and async, aliases with `:params`, API keys, `?environment=`, Idempotency-Key), schedules (cron/interval, timezone, overlap), per-workflow concurrency | Sync webhook p50 under 50ms. Tests pass across the Amsterdam DST change. A 1-min cron with a 2-min run never overlaps. |
| **M5 Advanced blocks** | Loop (all modes and runners), Functions + `await fn()`, Workflow block, durable Wait, global error handler, run timeout, cancel | A 10k-iteration loop survives a crash. A Wait survives a full stack restart. Cancel aborts in-flight SQL and fetch calls. |
| **M6 Hardening** | MySQL, BigQuery, OAuth2 client-credentials, retention, audit UI, Prometheus `/metrics`, backup runbook, User Tasks + inbox | Retention runs without long locks. A User Task resumes its run. |
| **M7 Database** | Retool-DB clone: a managed Postgres schema per environment, a spreadsheet editor (TanStack Table / Glide Data Grid), schema editor, CSV import/export, exposed as a built-in resource | Create a table, import CSV, query it from a workflow. |
| **M8 App builder** | 12-column grid (react-grid-layout), component registry (`id`, props, methods, events), reactive `{{ }}` graph in a Web Worker (acorn deps + topological evaluation, reusing `packages/expressions`), queries proxied through the same connectors, event handlers, Table/Form/inputs first | Build a CRUD app on a Postgres table with an editable Table and a save query. |
| **M9 OAuth** | REST resources sign in with the OAuth 2.0 authorization code (presets for Google, HubSpot, Slack, Microsoft 365; shared or per-user accounts) and with custom auth flows; tokens stored encrypted, refreshed under locks | A resource connected with the authorization code runs queries from the playground, a workflow (incl. a scheduled live run) and an app; expired tokens refresh, revoked ones ask for a reconnect; per-user accounts in an app; a custom flow refreshes once on a 401. |
| **M10 Finishing apps** | The app sandbox in a Worker (an infinite loop no longer freezes the tab; a watchdog and Restart), Table paging, sorting and search (in the browser, or server-side through `pagination`, `sort` and `searchText`), multipage apps (optional `pages`, no schema bump: global and page-scoped components and queries, page URLs with params, `utils.openPage`, a pages panel, a Navigation component), folders for workflows and apps | A two-page app: its list page pages, sorts and searches a 100k-row table server-side; a row opens the detail page with the id in the URL; the app sits in a folder granting a group Use; an infinite loop in its code is stopped and the tab stays responsive. |
| **M11 Git sync** | Workflows and apps in one GitHub repo (§2.13): files with code and SQL split out, admin Git settings (repo, token, webhook secret), **protected** objects edited on branches (a draft per branch, run like today's draft), Commit and Open PR from the editors, and deploy on merge (a push webhook plus polling: a release per changed object goes live, made by Git sync; a broken commit is reported and the previous release stays live) | Protect a workflow and an app; edit both on a branch and run the branch draft; commit (the repo shows the code blocks as `.js` and the SQL as `.sql`) and open a PR; merging it deploys a new live release of each within seconds of the webhook (and on the next poll without it), and a new workflow added on the branch is created; main is read-only for protected objects in the editors; a commit on main with an invalid definition deploys nothing and says why. Against a local bare repo and a fake GitHub API in tests; against a real GitHub repo once by hand. |
| **M12 Python** | Python in workflow Code blocks and loop code runners (§2.14): a `code-executor` service running CPython 3.12 under nsjail with a curated set of packages (pandas, numpy, …), data in and data out (no network in the jail), references to blocks found by a Python tokenizer (scope, rename, ancestors), syntax checked by the executor, `.py` files in Git, the editor's Python mode | A workflow whose Python block uses pandas to aggregate a query's rows returns the result, its `print()` lines in the run log; renaming the query rewrites the Python; a syntax error shows in the editor before running; Python code can't read the worker's environment, reach the network or write outside `/tmp`; an infinite loop stops at the block timeout and a 1 GB allocation fails as a memory error, the worker unharmed; a trivial Python block's p50 on Compose is under 100 ms (39 ms over HTTP on the Mac in step 1). |
| **M13 Editor polish** | Undo/redo, copy/paste, duplicate and keyboard shortcuts in the workflow and app editors (§2.15): a history of definition snapshots per editor (edits grouped per field, one step per drag), the clipboard through the browser's copy and paste events (JSON, parsed as untrusted), pasting with fresh names and references among the pasted items rewritten, the functions pasted blocks call brought along, multi-selection on the workflow canvas | In both editors, about 50 mixed edits undone one by one return the exact starting definition (layout included), the server's draft hash after autosave matching the start, and redoing returns the final one; blocks (or a component with its children) copied from one workflow (app) and pasted into another keep their internal connections and references under fresh names and bring the functions they use; Monaco fields keep their own undo. |
| **M14 Modules & Query Library** | App modules (reusable sub-apps with typed inputs and outputs) and the Query Library (org-wide versioned queries, pinned or following the latest): new object kinds with their own permissions, releases, Git format and server checks (a release still vouches for every query it runs) | n/a (planned at the start of M14) |
| **M15+** | SQS/Kafka triggers, multiplayer editing (Yjs); Git sync's gaps (resources and config vars, three-way merge); Python's follow-ups; **AI actions last** (the user's choice, session 13) | n/a |

## 2.7a M0 implementation detail (in progress)

**Environment facts (checked):**
- Node v24.15.0, arm64 macOS. There is no pnpm, Docker or Postgres on PATH.
- pnpm runs through `corepack pnpm` (pinned `packageManager: pnpm@10.34.7`), so no global install is needed.
- **Postgres for dev and tests comes from `embedded-postgres@18.4.0-beta.17`** (downloads PG18 binaries via npm), so Docker isn't needed locally. Docker Compose files are still written for deployment, but can't be run on this machine until Docker or OrbStack is installed.
- **TypeScript is pinned to `~6.0.3`**, not 7.x. TS 7 is the Go-native compiler and tooling such as drizzle-kit relies on the JS compiler API.
- `isolated-vm@7.0.1` requires Node ≥24, which is a match.

**Pinned versions:**

| Package | Version |
|---|---|
| turbo | 2.11.7 |
| biome | 2.5.15 |
| vitest | 5.0.4 |
| drizzle-orm | 0.45.4 |
| drizzle-kit | 0.31.11 |
| postgres.js | 3.4.9 |
| fastify | 5.12.5 |
| tRPC | 11.19.0 |
| zod | 4.6.7 |
| openid-client | 6.8.8 |
| vite | 8.3.4 |
| react | 19.3.0 |
| TanStack Router | 1.170.x |
| TanStack Query | 5.104.x |
| tailwindcss | 4.3.3 |
| uuid | 14.0.3 |

**Conventions:**
- Internal packages export TypeScript source (`"exports": {".": "./src/index.ts"}`). There is no per-package build.
- The server runs with `tsx` in dev and is bundled with esbuild for the Docker image. The web app is built by Vite.
- IDs are UUIDv7, generated app-side (`uuid` v7) rather than depending on PG18's `uuidv7()`.

**Done:**
- Root config: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`.
- `docs/architecture.md`, a copy of this plan.
- `packages/db`: `package.json`, `tsconfig.json`, `drizzle.config.ts`, and `src/schema.ts` with tables users, sessions, groups, group_members, environments and audit_events.

**Remaining M0 steps:**
1. **`packages/db`:**
   - `src/client.ts`: `createDb(url)` returning drizzle with postgres.js.
   - `src/migrate.ts`: runs the drizzle migrator under `pg_advisory_lock`, then idempotently seeds environments `production` (default) and `staging`, and groups `admins` and `all_users`.
   - `src/dev-db.ts`: embedded PG on :5433, data in `.data/pg`.
   - `src/testing.ts`: `startTestDatabase()` uses embedded PG with a temp dir and a random port, or `TEST_DATABASE_URL` if set.
   - `src/index.ts`.
   - Run `drizzle-kit generate` to produce `migrations/0000_*.sql`.
2. **`packages/sandbox`, the isolated-vm spike:**
   - `CodeRuntime` interface and `IvmRuntime` providing `evalExpression` and `runCode`.
   - The stdlib (lodash, dayjs) is bundled with esbuild and loaded into the isolate.
   - Memory limit, a watchdog that calls `dispose()`, and a fresh context for every evaluation.
   - Vitest tests:
     - a fresh context starts in under 10ms
     - the stdlib works
     - `while(true){}` is killed at the timeout
     - a memory bomb is killed
     - `process`, `require` and `globalThis.process` are undefined
     - the isolate is recreated after an out-of-memory error
3. **`apps/server`:**
   - `src/config.ts`: environment variables parsed with zod (`DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_URL`, `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET`, `OIDC_ALLOWED_DOMAIN=optiply.nl`, `LOCAL_LOGIN_ENABLED`, `ROLE`).
   - `src/main.ts`: the ROLE switch for api, worker, migrate and all.
   - `src/api/app.ts`: Fastify with cookie and static plugins, `/api/health`, and tRPC at `/api/trpc`.
   - `src/api/auth.ts`:
     - Google OIDC authorization code + PKCE with openid-client v6.
     - Rejects emails outside the allowed domain (checks `hd` and the email suffix).
     - Upserts the user by `oidcSubject` or email, then adds them to `all_users`.
     - The first user ever is added to `admins`.
     - Opaque session token in an httpOnly SameSite=Lax cookie, stored as its sha256.
     - Break-glass `POST /api/auth/local` using scrypt, only if `LOCAL_LOGIN_ENABLED`.
     - Logout.
   - `src/trpc.ts`: context, plus `authed` and `admin` procedures.
   - Routers:
     - `me`
     - `users.list`, `users.setDisabled`
     - `groups.list`, `create`, `rename`, `delete`, `addMember`, `removeMember` (system groups are protected, and you cannot remove the last admin)
     - `environments.list`
     - `audit.list` (paginated)
   - `src/audit.ts`: `recordAudit()` with redaction.
   - `src/worker/index.ts`: a placeholder loop with heartbeat logging. The engine itself comes in M2.
   - `src/cli/create-admin.ts`: creates a local user with a password in `admins`.
   - Tests: Fastify `inject` against an embedded PG. Cover the health check, that an unauthenticated tRPC call returns 401, local login creating a session, that admin-only procedures reject non-admins, that the last admin can't be removed, and that audit rows are written.
4. **`apps/web`:**
   - Vite, React 19, TanStack Router (file-based), TanStack Query, tRPC client, Tailwind v4, and small shadcn-style UI primitives.
   - Login page with a Google button and an optional local form.
   - App shell with a sidebar: Workflows, Resources and Runs (placeholders), and Settings.
   - Settings pages: Users, Groups (with members), Environments (read-only) and Audit log.
   - The Vite dev server proxies `/api` to `:3000`.
5. **Ops:**
   - `Dockerfile`, multi-stage: turbo prune, a build stage with python3/make/g++, and a runtime on `node:24-bookworm-slim` started with `node --no-node-snapshot`.
   - `docker-compose.yml`: postgres:18, migrate, api, and 2× worker.
   - `.env.example`.
   - `.github/workflows/ci.yml`: corepack, `pnpm install --frozen-lockfile`, lint, typecheck, test.
   - `README.md` with dev quickstart steps: `corepack pnpm install` → `pnpm dev:db` → `pnpm db:migrate` → `pnpm dev`.
6. **Verify M0:**
   - `corepack pnpm install` succeeds, including the isolated-vm native build.
   - `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass.
   - Start the dev DB, run migrate, create a local admin, then run `pnpm dev`. Log in with the local admin at http://localhost:5173, then add a group and a member and check the action appears in the audit log.
   - Google login is verified once you provide OAuth client credentials. Docker Compose is verified once Docker is installed.
   - No commits are made unless you ask.

## 2.8 Verification (end to end, from M4 on)
1. `docker compose up` (postgres, migrate, api, 2× worker), then log in with Google.
2. Create a Postgres resource pointing at a seeded demo database in the same Compose file, with separate production and staging configs. Test connection succeeds. Check the API response contains no password.
3. Build the workflow webhook → `getOrders` (SQL with `{{ startTrigger.data.customerId }}`) → JS transform → Branch → Response, then publish v1.0.0.
4. `curl -X POST -H 'X-Api-Key: …' /api/workflows/<slug>/run -d '{"customerId":1}'` returns the Response body synchronously. Repeat with `?environment=staging` and check that it hits the staging database.
5. Add a 1-minute cron: runs appear in history with per-block data and logs, and none overlap.
6. Run `kill -9` on a worker mid-run. The run resumes on the other worker and completed blocks are not re-run.
7. M7: on the Database page, create a table and import a CSV into it; a workflow with a query on `optiply_db` returns its rows, in each environment its own (handoff §9a has the Compose run).
8. M8: build an app on an `optiply_db` table (a query, a Table with an editable column, a save query over `changesetArray`), publish it, edit a cell in the published app and save it; the row changes in the database (`apps/web/e2e/m8-done-when.spec.ts`; handoff §9b has the Compose run).
9. M9: connect a REST resource's shared account through the provider's consent screen (a pop-up), query it from the playground, a scheduled live run and an app; expire the token (refreshed once), revoke it (the playground asks for a reconnect; Reconnect fixes it); a custom flow signs in once and refreshes once on a 401 (`apps/web/e2e/m9-done-when.spec.ts`; handoff §9c has the Compose run).
10. M6: a run waiting on a User Task survives `docker compose down`/`up` and resumes when the task is completed; retention deletes 100k old block rows while runs keep flowing, with no lock waits (handoff §9 has the numbers).
11. Automated: `pnpm test` (Vitest unit and golden-semantics tests; Postgres comes from embedded-postgres, not Testcontainers) and `pnpm --filter @ow/web e2e` (Playwright, against the bundled server; see `apps/web/e2e`).
12. M13: in a workflow and an app, a series of edits undone to the start and redone to the end through the toolbar and the shortcuts, the drafts saved each way; blocks with a function and a component with its children copied into a second workflow and app, keeping their connections and references (`apps/web/e2e/m13-done-when.spec.ts`).

## 2.9 Open items (defaults chosen; change later if needed)
- Importing existing Retool workflows: block names, `{{ }}` semantics and settings were kept compatible, so an importer is cheap. It is not in scope yet.
- Under `skip`, a run that is waiting blocks the next scheduled fire. The default is yes, and each trigger can override it.
- Block results are capped at 10MB in Postgres. Object storage can come later.
- Licences: we write our own code. Ideas only from AGPL projects; code only from Apache-2.0 or MIT ones.

## 2.10 The managed database (M7)

A Retool-Database-style store for tables people make and fill in the platform itself.

- **Where the tables live:** the platform's own Postgres, one schema per environment (`owdb_production`, `owdb_staging`). Each schema is owned by a **login role** of its own (`owdb_<md5(database)[:6]>_<environment>`; roles are shared by every database on a server, hence the tag) that has no rights on anything else: not the platform's tables, not the other environment's schema, and no role it could switch to.
- **Why a login role and not `SET ROLE`:** a query could switch back mid-statement (`set_config('role', …)`, then dynamic SQL such as `query_to_xml`), because the session user may always return to itself. So the role logs in with its own generated password, stored encrypted in the built-in resource's config like any secret and sent to Postgres as a SCRAM verifier (never as plain text).
- **Provisioning** (`apps/server/src/services/database.ts`) runs at every start (migrate and API), in one transaction under an advisory lock, and repairs drift: role attributes and password, roles granted to it by hand (revoked), schema and object owners (what a restore onto another server leaves), `CREATE` on `public` before Postgres 15. It needs superuser or `CREATEROLE`; without either it reports what to grant and the platform runs on.
- **Access:** Use on `optiply_db` in an environment is the whole of it (rows, schema and SQL), like Use on any resource, whose queries run with the resource's rights. A read-only tier would need a second, SELECT-only role and resource.
- **The schema editor** (`services/managed-db.ts`): tables always get `id bigint generated by default as identity primary key`; nine column types (text, integer, bigint, decimal, boolean, date, datetime, json, uuid; anything else made in SQL shows as "other"); defaults are a value or `now()` / `current_date` / `gen_random_uuid()`; type changes cast the values, all or nothing. Every statement runs as the environment's role, waits at most 5 s for a lock, and is audited.
- **Rows** (`services/managed-db-rows.ts`): pages with sort and 11 filter operators, counts capped at 10,000; values in JSON-exact shapes (bigint/decimal as strings, datetimes ISO in UTC, JSON as JSON); writes by single-column primary key, each value checked against its type first so errors name their field; values sent as text and cast in SQL (postgres.js would otherwise convert booleans, dates and JSON by its own rules).
- **CSV** (`services/csv.ts`, `services/managed-db-csv.ts`, `api/database.ts`): our own streaming RFC 4180 parser; a preview that guesses delimiter, names, types, date order and decimal commas; imports streamed as one line of JSON spec plus the file, all rows or none, problems reported by line and column; exports streamed with the grid's selection, formula-guarded in text cells only.
- **The web app:** `/database` (its own chunk): environments and tables, a TanStack Table 8 + Virtual grid (pages of 100 as you scroll, server-side sort and filter, in-place editing), the schema editor and the import wizard.
- **Not yet:** foreign keys and indexes in the editor, promoting a schema from staging to production (Retool's reviewed diff), a read-only tier, a separate database server for the managed tables.

## 2.11 Apps (M8)

Retool-style internal UIs: components on a grid, wired together with `{{ }}`, reading and writing data through queries.

- **The definition** (`packages/app-definition`): components (with a parent container and sparse props), queries (resource: a connector query plus `run: auto | manual`; JS: browser code), transformers and variables, sharing one namespace of JS identifiers; the layout apart from the logic; every string a template. The registry lists each component type's props (type, default), state (with the prop it starts from), methods and events. The canonical hash counts the layout (unlike a workflow's): moving a component is a change people see.
- **The reactive graph:** one node per readable value (`table1.selectedRow`, `query1.data`), with dependencies per property where the code names one (`freeIdentifierRefs(…, { properties: true })`), cycles found with Tarjan's algorithm, evaluation in topological order. A change re-evaluates only what depends on it and stops where a value comes out the same; input state restarts only when its default's value changes; an automatic query's `$deps` node tells it to run again.
- **Where code runs:** in the browser (Retool's way), inside a hidden iframe with `sandbox="allow-scripts"` (an opaque origin: no cookies, no access to the page) and a CSP without network access (`default-src 'none'`); it talks to the page over a MessageChannel. The page runs queries, keeps the state for React, and checks effects (http(s)/mailto links, text/CSV/JSON downloads). The sandbox's script (`@ow/app-runtime` plus the stdlib) is bundled by esbuild at build time and written into the frame's document. **Since M10 the app runs in a Worker** the frame starts from a blob: URL (the CSP adds `worker-src blob:`); the Worker inherits the frame's CSP (checked in Chrome, Firefox and WebKit: fetch, XHR, WebSocket, EventSource, `importScripts`, `import()` and nested workers all refused, nothing reaching the server), and refuses to start if a `data:` fetch isn't blocked. The frame passes the page's port on, so the page talks to the Worker directly. A watchdog pings it every second; one ping unanswered for 5 s (while the page's own timers run on time) removes the frame, which ends the Worker, and offers Restart. In the editor an edit restarts a stopped app.
- **Queries stay on the server** (`apps.runQuery`): the browser sends a query's name and the values of its `{{ }}`s (keyed by their code), never SQL; the server binds them as parameters, so values never become SQL. Expressions reading only `current_user` are evaluated on the server (what the browser sends is ignored); mixing `current_user` with app values is refused (validator and server).
- **Access:** Use on an app opens its live release and runs its queries without any grant on their resources; whoever publishes vouches for them (Edit on the app, Use on every queried resource in every environment), like a workflow's webhook. Draft queries (the editor) need Edit on the app and Use on the resource in that environment. A release that's no longer live is refused, so an open page can't keep running an old version. Manual (write) query runs are audited without values.
- **The editor** (`/apps/<slug>/edit`): react-grid-layout canvas (a grid per container, drag by handle), palette and tree, the inspector (props with `fx` switches, handlers), a bottom panel (queries, transformers, variables, state, problems, console), autosave with optimistic concurrency. The draft runs live and follows edits without restarting (typed values, query results and variables carry over; automatic queries re-run only when they or their values changed).
- **Components** (`apps/web/src/pages/apps/components`): Table (virtualized, sorting, selection, keyboard editing into `changesetArray` keyed by primary key, Save fires `save` and clears the changes once it succeeded), Form (`form.data` from its inputs, required inputs checked by the runtime), inputs, Button, Text, Container, Modal, and Chart (Chart.js in its own chunk; the dataviz reference palette in a fixed order, a table view).
- **Pages (M10):** optional `pages` (`{ name, title? }`, in order, the first opening by default) and an optional `page` on top-level components, queries and transformers; what names no page is global (components show on every page, above it; queries run on every page). Components inside a container are on its page; variables are always global. An app without `pages` is one page holding everything, so existing drafts and releases need no upgrade (no schema version bump). Code on a page reads what's global and what's on its page; global code reads only what's global; the same goes for event handlers' targets (`other_page` in the validator, with `unknown_page`, `duplicate_page` and `invalid_page`). `url` is built in (a reserved name, an entity in the graph so code reading it re-evaluates): `url.page` (the page shown, null without pages; an unknown page opens the first) and `url.params` (the URL's query parameters). `entityPages`, `defaultPage`, `resolvePage` and `pageVisible` in `packages/app-definition/src/pages.ts`. `edit` can't name a page (`/apps/<slug>/edit` is the editor). An app or workflow from before M10 with an entity or block named `url` or `sql` must rename it (the validator says so); until then a running app with its own `url` simply doesn't follow page changes.
  - **At run time:** the viewer is one route, `/apps/$slug/{-$page}` (two routes would remount the app between pages), and the router reads and writes search params as plain text (`URLSearchParams`, not TanStack's JSON). The page passes `url` (page, query string without `env`) with `start` and as `navigate` whenever the URL changes (links, Back, Forward); `AppRuntime.navigate` sets `url.*`, then runs the opened page's automatic queries that never ran or went stale while it was closed (an automatic query on a closed page only marks itself stale) and its run-on-load queries. `utils.openPage(page, { params, newTab })` checks the page and sends an `openPage` effect; the viewer changes the URL (or opens a tab), and the editor's host navigates in place. The canvas draws the global components' grid, then the page's.
  - **In the editor (M10 step 4):** the page being edited is the editor store's `url` (page and the params `utils.openPage` gave); the running draft follows it (`host.navigate`), and the host re-sends it after each definition update, since a page added or renamed may be navigated to before the draft has it. The pages panel calls the pure edits (`addPage`, which moves a pageless app's top-level components, queries and transformers onto `page1`; `renamePage`, which relinks Navigation; `setPageTitle`, `movePage`, `removePage` with `onPage`; `setEntityPage`); new components, queries and transformers get the edited page. The canvas has a frame grid (`grid-frame`, page null) and the page's (`grid-page`), each taking drops for its own page. Navigation (`items`: `{ page, label? }`, or every page; links to missing pages are an `unknown_page` error) opens pages through `host.openPage`, like `utils.openPage`.
- **Table paging, sorting and search (M10):** `paging` is `scroll`, `pages` or `server`; the pure `tableView` (search over the shown cells, ignoring case and accents, then sort, then the page, keeping each row's position in `data` for selection and edits) does it in the browser, and in `server` mode shows `data` as it came. State `page`, `sort` (`{ column, desc }`) and `searchText` (set through `setPage`/`setSort`/`setSearchText`, or the search box's acknowledged `set`; sorting and searching go back to page 0), and `pagination` (`{ page, pageSize, offset }`), a read-only node derived from `page` and `pageSize` like a form's `data`. Server sorting uses `sql.column`/`sql.direction` (§2.3).
- **Releases:** semver publish and rollback like workflows; `/apps/<slug>` shows the live release in an environment the viewer picks.
- **Folders for workflows and apps (M10):** `folders.*` takes the object type (`resource` when missing, as before): `list` returns a type's folders and `canManage`, creating, renaming and deleting need the type's create right (`canCreateResources`, `canCreateWorkflows`, `canCreateApps`), and a subfolder is of its parent's type. Deleting a folder sets what's in it to no folder (`ON DELETE SET NULL`) and removes the folder's grants. Moves still need Own and a folder of the object's type (`checkFolderMove`, since M8's review); folder grants stay admin-only. The web app's `components/folders.tsx` (`FolderSections`, `FolderSelect`, `NewFolderForm`, `useFolders`) is shared by the Resources, Workflows and Apps lists.
- **Not yet:** modules, a mobile layout, custom components, a Query Library, per-row column templates, multiplayer editing, themes.

## 2.12 Signing in to APIs (M9)

REST resources that act as a person or a workspace, or that have their own login.

- **OAuth 2.0 authorization code.** The settings hold the authorization and token URLs, client ID, scopes, extra consent parameters, client auth, PKCE (S256, on by default) and the token mode (`shared` or `perUser`); the client secret is with the other secrets. Presets (`@ow/connectors/oauth-presets`, browser-safe) fill these in for Google (offline access and a consent prompt, so a refresh token is issued), HubSpot, Slack (`ok: false` answers; user tokens in `authed_user`) and Microsoft 365 (a `{tenant}` placeholder; the scopes are sent again on refresh; refresh tokens rotate).
- **The connect flow** (`apps/server/src/api/oauth.ts`): `/api/oauth/start` (session; Edit for the shared account, Use for one's own) puts state, the PKCE verifier, the person and a fingerprint of the consent settings in a signed, HttpOnly cookie named after the state (10 minutes, path `/api/oauth`), then redirects to the consent screen. `/api/oauth/callback` (one redirect URI for every resource) needs that cookie, the same state and the same person's session, checks access and the consent settings again, exchanges the code and stores the tokens; it ends on a page that posts `ow:oauth` to the opener (`PUBLIC_URL`'s origin) and closes. Connects, disconnects and refused refreshes are audited without tokens.
- **Tokens in queries:** connectors ask the server through `QueryContext.credentials` (`accessToken({ force })`), so user tokens never sit in pooled clients; a 401 forces one refresh and a retry. Refreshes run under an advisory lock per owner, taken by trying and sleeping outside any transaction (waiters hold no connection), and whoever waited uses what the other stored: rotating refresh tokens are never spent twice. A refused refresh (`invalid_grant`) marks the row `reconnect` (committed) and later queries fail at once with `auth_required` (details: reason, shared/user, resource, environment), which the UI turns into Connect / Reconnect prompts. Changing the consent settings (including the token mode and where requests go: the base URL's origin and the allowed hosts) disconnects accounts, so a resource can't be pointed elsewhere to receive its token.
- **Whose account:** the shared one, or on per-user resources the person behind the query: the playground's caller, an app's viewer (who may connect their own account through the app, without access to the resource), a draft run's starter (the engine's `actingUserId`). Runs of a release have nobody behind them, so publishing (and rollback) refuses workflows that query a per-user resource.
- **Custom auth flows** (auth type `custom`): ordered steps (a REST request through the resource's base URL and allowed hosts without its default headers, JavaScript in the sandbox, or a variable), with `secrets.NAME` (named secret values), `auth` and earlier steps in scope; optional refresh steps (run on a 401 from the current variables, falling back to signing in) and `ttlSeconds`. The variables (`auth.NAME`) are rendered into the resource's headers and parameters on each attempt, scrubbed from results, stored encrypted in `oauth_tokens` (one shared row), and signed in for under a transaction-scoped advisory lock per config. Test connection signs in afresh in memory.
- **Not yet:** token revocation at the provider on disconnect, per-user custom flows (a form step), a back-off for a sign-in that keeps failing, live checks against the real providers (only the fake one so far), admin views of other people's connections.

## 2.13 Git sync (M11)

Retool's Source Control, for one instance and one GitHub repo: workflows and apps that matter are reviewed in a PR before they go live, and the repo is their history.

- **What's in the repo:** workflows and apps, nothing else (resources, folders and config vars stay on the instance; definitions already name resources by slug and hold no secrets). One directory per object, named by its slug, under `workflows/` and `apps/`, plus `ow.json` at the root (the format version). The files are the canonical definition with every code and SQL string moved into a file named after its block, query or transformer, so a PR diff reads like code:
  ```
  ow.json
  workflows/sync-orders/
    workflow.json        # name, description, settings, triggers, blocks, edges (canonical, no layout)
    layout.json          # canvas positions
    blocks/fetchOrders.sql
    blocks/transform.js
    functions/notify/blocks/send.js
  apps/order-admin/
    app.json             # name, description, components, queries, pages (canonical, no layout)
    layout.json
    queries/listOrders.sql
    queries/listOrders.transform.js
    queries/saveOrder.js
    transformers/rows.js
  ```
  `.sql` holds a resource query's `sql` (the `{{ }}`s stay as they are; a loop's query runner too); `.js` a code block's or a loop's code, a JS query's or a transformer's, and `<query>.transform.js` a query's transform. Other strings (REST queries, branch and filter conditions, props, event handler scripts) stay in the JSON. Files outside `workflows/` and `apps/` (a README, CI) are ignored. Files end with a newline that reading takes off again, so a value's own trailing newlines survive. A value written inline in the JSON (by hand) still reads; inline *and* in a file is a problem. Empty workflow layouts aren't kept (the same canvas); an app's layout is kept exactly, since it counts in the app's hash. `maxConcurrentRuns` isn't versioned and stays on the instance. Reading the files back gives the same canonical definition and hash (a property test over 400 generated workflows and apps); a file that doesn't parse, a missing or stray file, an invalid slug or a schema problem is a problem naming its path (and the path inside the JSON), and one broken object doesn't hide the others. Names that differ only in case give a warning (a macOS or Windows checkout would keep one file).
- **Protected objects** (`services/git/protection.ts`, M11 step 4a): an Own holder protects a workflow or app (`git.protect`). Its live release (or its draft, if it has none) is committed as its directory onto a branch (`protect/<kind>-<slug>` by default, from the deploy branch; an empty repo first gets a commit with `ow.json`, and `ow.json` is added when missing), and a pull request adds it to the deploy branch. **It's protected at once** (decided while building it: waiting for the merge would let main drift meanwhile), and merging deploys it (nothing new when it's what's live). On a protected object, main is read-only: saving the draft, renaming it or changing its description (the repo holds them), and publishing are refused (`PRECONDITION_FAILED`); its folder and concurrency limit stay the instance's. Making another release live is for admins only, as an emergency rollback until the next deploy (audited with `emergency: true`). `git.unprotect` (Own) lets it be edited here again; its directory stays in the repo and stops deploying (`not_protected`). Workflows and apps can also be created protected (`protected: true`), when Git sync is set up: edited on branches from the start, deployed by the first merge. Summaries carry `gitProtected`; release lists carry `gitCommit` (Git sync's releases have no `createdBy`).
- **Branches** (`services/git/branch-drafts.ts`, `branchDrafts.*`, M11 step 4b): repo-wide, named by people, made from the deploy branch. A protected object's editor picks a branch; each (object, branch) has its own draft on the instance (`git_branch_drafts`: definition, name, description, revision, the commit its files came from, whether the branch exists yet, the last commit), all with Edit on the object. **Open** loads the object's directory from the branch (or, with `create`, from the deploy branch: the branch is made by the first commit); where the repo doesn't have the object yet (created protected, or its protect PR isn't merged), it starts from the live release or the draft; a directory whose files have problems isn't opened (fix it in the repo). **Save** is optimistic like the main draft (schema checked, diagnostics back). **Run**: workflow runs and Run block take `draftId` and run a snapshot of the branch draft's revision (`workflow_draft_snapshots.branch_draft_id`, without a foreign key so runs outlive a discarded draft; retention keeps an open draft's current revision); `apps.runQuery` takes `branchDraftId`. **Changes** lists the files a commit would add, modify or delete against the branch's tip (texts up to 200 kB), and whether the branch moved (`behind`) or changed the object's files too (`conflict`). **Commit** (the revision the person is looking at) writes the object's directory onto the branch as one commit (message; author = the person's name and email; `ow.json` added if the base lacks it) and pushes; if the branch moved, it goes on top when the object's files didn't change there, and is refused otherwise (CONFLICT). **Update from branch** loads the branch's files into the draft (refused while it has uncommitted changes, unless they're discarded). **Discard** closes the draft; what's committed stays. **Open PR** (`git.openPullRequest`) opens the branch's pull request into the deploy branch, or returns the one already open; `git.pullRequest` finds it (open ones first) with its state and whether it merged; `git.branches` lists the repo's branches, the deploy branch first. A branch can carry several objects. The GitHub API (`services/git/github.ts`) is api.github.com for github.com and `<host>/api/v3` for GitHub Enterprise Server (`GITHUB_API_URL` overrides it, for tests), called with the repo's token, no redirects; its failures (not GitHub, no token, a refused token) come back as a message, not an error, so the branch is still there to open a PR by hand.
- **Deploy on merge** (`apps/server/src/services/git/deploy.ts`): GitHub's push webhook (`POST /api/git/webhook`, HMAC-SHA256 of the raw body with the webhook secret in `X-Hub-Signature-256`; JSON or form-encoded; `ping` answers, other events and branches are ignored; 404 without a secret) asks for a deploy, and workers poll the branch every `GIT_POLL_SECONDS` (60; 0 off). One deploy runs at a time across processes: a lease on the `git_settings` row; a request while another process deploys marks it, and the holder goes again when its round ends (at most 5 rounds). A deploy fetches the branch; an unchanged tip does nothing. Otherwise it reads `ow.json`, `workflows/` and `apps/`, decodes every directory (`@ow/git-format`) and compares each directory's tree with what it last deployed: an unchanged one is skipped while its object is still there and protected. Each changed directory creates its object (protected, no owner: admins grant access) or, for a protected one, updates its name, description and draft and, when the definition differs from the live release's, publishes a patch release made by Git sync (`created_by` null, notes = the commit's subject, `git_commit`) and makes it live, with every check publishing does except people's grants (validity, connectors' query checks, per-user accounts, schedule environments, webhook aliases). Workflows go first, then apps, in passes, so a new workflow can call another one new in the same commit. A directory whose slug belongs to an unprotected object isn't touched (`not_protected`). Problems (a file that doesn't parse, an invalid definition, a resource missing) skip that object and keep its live release; the rest still deploys. A directory that left the branch is flagged `missing` (the object stays). A repo without a readable `ow.json` deploys nothing. Deploy now (admins) re-checks every directory, for instance after creating a missing resource. Deploys are audited (`git.deployed`, and `<kind>.created` / `<kind>.release_published` with `source: git` and the commit, actor null).
- **Who may deploy:** writing to main (GitHub's branch protection and reviews) is the right to deploy protected objects; the instance doesn't check the merger's grants on resources. Committing from the instance needs Edit on the object.
- **Git itself** (`apps/server/src/services/git/`): the `git` CLI (in the runtime image since step 2; Debian's 2.39) on a bare cache repo per process (`GIT_CACHE_DIR`, default `<tmp>/ow-git-<pid>`; one directory per repo URL; one command at a time per process), with plumbing only: `ls-remote`, `fetch` of one branch, `ls-tree` + `cat-file --batch` to read files, a temporary index (`GIT_INDEX_FILE`, `read-tree`, `update-index --index-info`) + `hash-object`, `write-tree` and `commit-tree` to write, a fast-forward `push --porcelain` (`[rejected]`: the branch moved, fetch and retry; `[remote rejected]`: refused by the server, such as branch protection). No working tree, no checkout, no merge. `commitToBranch` writes directories onto a branch from the commit a change started from: it goes on top of a moved branch when none of the same paths changed there, and is a conflict otherwise; a lost push race tries again (3 times). Git runs with no system or global config, no credential helpers, no prompts, no hooks, `http.followRedirects=false` and only `https` (plus `http` and `file` with `GIT_ALLOW_INSECURE_URLS`, for development and tests). The token reaches git through `GIT_ASKPASS` (a script reading it from the environment of that one git process), never argv or the remote URL, and is blanked out of error messages. Errors are `auth`, `not_found`, `unreachable`, `refused` or `failed`. The GitHub REST API (pull requests, step 4) is called with the same token (a fine-grained token with Contents and Pull requests on the one repo). Settings (`git_settings`, one row, admins only, `git.*` in tRPC): repo URL (https, no credentials, query or fragment), branch (`main`), token and webhook secret in one encrypted value (AAD `git_settings:<id>:-`; covered by rekey and verify); the browser only sees whether they're set. Pointing the repo at another host needs the token again. Test connection signs in, reads the branch and counts the workflows and apps on it, and reports whether `ow.json` is there. Saving and clearing are audited (what changed, never the values). Tests use local bare repos (`file://`), `git http-backend` behind basic auth for the token path and a refusing hook, and a fake GitHub API (step 4).
- **The UI (M11 step 5a):** Settings → Git (admins): the repo URL, deploy branch, token (never shown; "Set", Remove) and webhook secret (generated in the browser, shown once to copy into GitHub, then only "Set"), Test connection, the webhook's payload URL and settings to paste into GitHub, and the deploys: the deployed commit, the last check and error, Deploy now, each directory's state (deployed version, problems by file) and the recent deploys (commit, the PR's title, what each object did). `git.info` (everyone) says whether Git sync is set up, the deploy branch and the repo's web address (https URLs without `.git`) for commit links. The Workflows and Apps lists show an "In Git" badge, a Protect button for owners (a dialog explaining what changes, the branch, then the commit and the pull request, or a link to open one by hand) and "Create it in Git" when making one. Release lists show "Git sync from <commit>" for deployed releases, and only admins see Make live on protected objects (an emergency rollback, said so in the confirm). Release notes of a deploy from a GitHub merge commit are the pull request's title and number, not "Merge pull request #N from …".
- **The editors (M11 step 5b):** a protected workflow's or app's editor has a Git bar (`components/git-bar.tsx`) under its header: a branch picker (the deploy branch, read-only; the object's open drafts and the repo's branches; New branch…), and the branch in the URL (`?branch=`). On the deploy branch the draft is read-only (the stores ignore edits: `readOnly`; no toolbar or palette, no autosave, no Publish) and still runs; a banner says to pick a branch. On a branch the editor loads the branch draft (`branchDrafts.open`, made if needed), autosaves through `branchDrafts.save`, and runs it (`draftId` on runs and Run block, `branchDraftId` in the app host's queries). The bar shows whether the branch exists yet, the last commit, whether the branch moved or conflicts (rechecked every 30 s), Update from branch (confirming when it drops uncommitted changes), the pull request and its state, and Close draft. Commit saves, then lists the files that change with a line diff each (`lib/diff.ts`: LCS with the common ends trimmed, unchanged stretches folded; texts over 3000 lines aren't compared), a message, and afterwards Open pull request (or the one already open). Switching back to the deploy branch fetches the object again (a merge may have deployed it). Settings: Protect in Git / Unprotect for owners (the workflow's Settings tab, the app's settings dialog); a protected app's name and description are read-only there (they live in the repo; changing them on a branch isn't in the editors yet).
- **Not yet:** GitLab and other hosts, resources and config vars in Git, promotion between instances, merging a branch draft with others' changes (update discards local ones), creating a brand-new object from the repo side only while editing (it appears on deploy).

## 2.14 Python (M12)

Retool's Python blocks, for workflows: data work (pandas, numpy) next to JavaScript, in a sandbox that holds nothing worth stealing.

- **Agreed with the user at the start of M12:** an **nsjail service** (a separate `code-executor` container running CPython; only it gets elevated privileges, and it holds no secrets), a **curated set of packages** baked into its image (adding one is a change to the image), and **data in, data out** (no network in the jail; no `fetch`, no workflow functions from Python: HTTP stays in REST resource blocks).
- **Where:** workflow Code blocks and loop code runners, in the main graph and in functions: `config.language: 'python'` / `runner.language: 'python'`, stored sparsely (absent means JavaScript, so existing hashes don't change). Templates (`{{ }}`), branch and filter conditions stay JavaScript; apps stay JavaScript (their code runs in the browser).
- **The code** is a function body, like JavaScript's: `return` gives the block's data (wrapped by the executor in a function; line numbers in errors are the block's own). In scope: the blocks it refers to, as variables with attribute and key access (`query1.data`, `query1["data"]`, `startTrigger.data`), `configVars` (non-secret ones in draft runs, as in JS), `workflowContext`, `idempotencyKey`, and `value`/`index` in loop runners, `params` in functions. The result must be JSON: dicts, lists, strings, numbers, booleans and `None`, plus `datetime`/`date` (ISO strings), `Decimal` and numpy scalars (numbers), NaN/infinity (`null`), a pandas DataFrame (a list of row dicts) and Series (a list); anything else is a `serialization` error. The 10 MB result cap applies. `print()` goes to the run log (`log`), `sys.stderr` to `error`, in the order written (the runner sends both through one pipe as tagged frames; bytes written to the file descriptors directly arrive untagged), at most 1 MB per execution (then cut off, said so).
- **Errors** reuse the sandbox's kinds: `syntax` (with the line), `runtime` (the exception's type and message and the line in the block's code, the traceback trimmed to the user's frames), `timeout`, `memory`, `serialization`. Retries, `finally` and the error handler work as for JS.
- **Finding references without a Python parser in TypeScript** (`analyzePython` in `@ow/expressions`, M12 step 2): a tokenizer (strings with every prefix, triple quotes, f-strings whose `{…}` fields are code, Python 3.12's nested quotes; comments; line continuations; implicit line joining in brackets) and a pass over the tokens. Not references: attributes (`a.b`), keyword arguments' names (`f(x=…)`), import statements' module paths, keywords, and **every name the code binds**, as Python's own rule is that a name bound anywhere in a function is local to it (assignments including tuple, chained, augmented and annotated ones, `for` targets in statements and comprehensions, `as`, `def`/`class`, parameters of `def` and `lambda`, imports, `:=`, `del`; `global`/`nonlocal` names stay references). Builtins (`len`, `sum`, Python 3.12's list) are kept apart: a block named like one can't be read from Python (warning `python_builtin`). What's left are the code's references: they decide the scope (only referenced blocks are copied in, as for JS), `self_reference` and `not_ancestor`, and renaming a block rewrites them (f-string fields included; a name the code binds or a builtin is refused as the new name, like a captured JS name). Nested functions and comprehensions count as part of the body (their bindings count everywhere), which only matters when a block shares a name with one of their variables. Checked against Python itself: a test compares it with `symtable` on a corpus of 38 realistic and tricky snippets (Python 3.12+ where installed; CI's runner has it). Never a syntax error here; there's no `unknown_identifier` for Python (a `NameError` at run time says it). Python's keywords JavaScript doesn't have (`None`, `pass`, `lambda`, `def`, …) become reserved block names (an existing block named so must be renamed, the validator says so); apps keep JavaScript's rules. A Python field naming `fetch` or a workflow function is an error (`python_unsupported`), and isn't counted as a function call.
- **Syntax:** the browser can't parse Python, so the server asks the executor to compile it (`POST /check`, `compile()` only, in a jail too): `checkDefinition` (before runs, at publish and Git deploys) adds `syntax` diagnostics with offsets, and the editor asks `workflows.checkPython` a second after a Python field stops changing, for markers.
- **The executor** (`apps/code-executor`, M12 step 1): a small HTTP server in Python's standard library (`executor/server.py`; nothing installed outside the jail) on `python:3.12-slim-bookworm`, with nsjail 3.6 built from source at a pinned commit (Apache-2.0; Debian doesn't package it) in a build stage, and the curated packages in a virtualenv (`/opt/py`) pinned with hashes (`requirements.in` → `requirements.lock` by pip-compile; releases at least two weeks old; numpy, pandas, python-dateutil, pytz, tzdata), pip removed afterwards. `POST /run { code, scope, timeoutMs }` → `{ ok, result | error, logs }`, `POST /check { fields: [{ id, code }] }` → `{ ok, problems }`, `GET /health` (Python and package versions); a bearer token (`PYTHON_EXECUTOR_TOKEN`, 16+ characters) shared with the workers and API; one jail per execution (`executor/runner.py` inside it); at most `PYTHON_MAX_CONCURRENT` at once (default the CPU count), others wait up to 30 s, then 503; a caller that hangs up (cancelled, timed out) has its jail killed; a refused request closes the connection (its unread body would be taken for the next request). No database, no encryption keys, no published port: only the app containers reach it. Structured JSON logs (one line per execution: path, ms, outcome).
- **The jail** (`executor/jail.cfg`): new user, PID, mount, network, IPC, UTS and cgroup namespaces; no network (a loopback, down); read-only `/usr` (with `/lib`, `/lib64` and `/bin` as symlinks into it: x86-64 binaries load through `/lib64/ld-linux-x86-64.so.2`, arm64 ones through `/lib`), the virtualenv, the runner and `/etc/ld.so.cache` (without `/proc` the loader can't find `libpython` through `$ORIGIN`), `/dev/null` and `/dev/urandom`, `/tmp` a 64 MB tmpfs (charged to the memory cgroup), nothing else: no `/proc` (a fresh procfs can't be mounted under Docker's masked `/proc` without more privileges) and no `/sys`; uid/gid 65534 inside **and outside** (not the executor's root); cgroup v2 limits on memory (256 MB without swap by default, `PYTHON_MEMORY_MB`), PIDs (32) and CPU (one); a wall-clock limit of the timeout rounded up to seconds plus one, the same CPU-time limit, and the server's own deadline 1.5 s later; rlimits (no core files, 256 open files, 16 MB files). A seccomp deny list on top of the container's profile (kafel): ptrace and reading other processes' memory, every mount call, `unshare`, `setns` and `clone` with namespace flags (`clone3` answers ENOSYS so libc uses `clone`), keys, bpf, perf, userfaultfd, modules, kexec, swap, reboot, io_uring; `fork` works. The environment is only `TZ=UTC`, `HOME=/tmp`, `LANG=C.UTF-8`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONHASHSEED=0`, `PYTHONUNBUFFERED=1`. Code and scope go in on stdin; the outcome comes back on its own pipe (whose fd is passed with `--pass_fd` and named in the request), so prints never mix with the result. Without an outcome, the error is `internal` when the jail never started (nsjail's own error, also in the executor's log), else a `timeout` (past the time), `memory` (killed otherwise) or the exit code.
- **What it costs** (step 1, on the Mac's Docker Desktop): a bare jailed interpreter 12 ms (nsjail adds ~6 ms), with `json`/`datetime`/`decimal` 19 ms, `import numpy` 58 ms, `import pandas` 213 ms; a trivial block over HTTP 39 ms p50 (78 ms p90). Each execution starts a fresh interpreter; a warm pool can come later if pandas' import cost matters.
- **The container's privileges** (step 1's spike): `--cap-add SYS_ADMIN` and a seccomp profile that is Docker's default plus `pivot_root` (`apps/code-executor/seccomp.json`, from moby/profiles); on hosts with AppArmor, `apparmor=unconfined` too (Docker's profile refuses nsjail's mounts). Not `--privileged`. The entrypoint remounts the container's cgroup writable (it can, with SYS_ADMIN), moves itself into a child cgroup and delegates the memory, PID and CPU controllers, so nsjail can give each jail its own. Without SYS_ADMIN nsjail can't create its namespaces; with Docker's default seccomp profile `pivot_root` is refused.
- **Engine and server** (M12 step 3): `PythonExecutorClient` (`@ow/sandbox`, a `PythonRunner`: `run` and `check` over HTTP with the token) is the engine's `services.python` (`RunExecutorOptions.python`, for the worker's Dispatcher and the API's InlineRunner); `runCode` picks by language (code blocks and loop runners), sends the block's scope as is (the blocks it reads, the run's globals, `value`/`index`, `params`) and aborts the request with the work (timeout, run failure, cancel), so the executor kills the jail; the logs come back with the result, a line each, and go through `work.log` like JavaScript's (scrubbed, a loop's prefixed with the iteration). Errors are `SandboxError`s: `syntax` ("… (line 1, column 11)"), `runtime` ("ZeroDivisionError: … (line 2)") with `details: { line, column?, traceback }` that reach the run's error, `timeout`, `memory`, `serialization`, and `unavailable` (the executor unreachable, busy, refusing, or unable to start a jail); retries apply like any failure. No executor: the block fails `python_unavailable`. Config: `PYTHON_EXECUTOR_URL` and `PYTHON_EXECUTOR_TOKEN` (16+ characters, required with the URL); the server keeps one client per process (`services/python.ts`, set up by the API and the worker at startup), so `checkDefinition` (before draft and live runs, at publish, rollback and Git deploys) adds the executor's `syntax` diagnostics (with offsets; one past the end marks the last character) or, without an executor or when it can't be reached, a `python_unavailable` error per Python field. `workflows.checkPython` (a mutation, as code can be long; any signed-in person) answers the editor: `{ available, problems | message }`. `pythonFields(def)` and `lineColumnOffset` (`@ow/definition`) find the fields and place the errors for both.
- **Git:** a Python code block or runner is `blocks/<name>.py` (`.js` stays for JavaScript).
- **The editor** (M12 step 4): the toolbar has "Add a Python code block" next to Code (named `python1`, … ; `return None` to start); a Python code block shows as "Python" with its own icon on the canvas and in the inspector (`kindOf`). The inspector's Language picker (code blocks and loop code runners) switches between JavaScript and Python keeping the text, and stores `language` only for Python. The editor is Monaco's Python mode on its own model (`code.py`, `runner.py`: JavaScript keeps `code.js`), with the validator's problems (ancestors, `python_unsupported`, `python_builtin`) at once and the executor's syntax errors a second after the code stops changing (`usePythonCheck` → `workflows.checkPython`; an answer for older code is dropped); when the instance has no executor, a note under the field says the code can't run here. Completions of blocks and globals, then `.data` and keys from the last run's values, as in `{{ }}` (without JavaScript's `_`, `dayjs`, `sql`).
- **Ops** (M12 step 5): a `code-executor` service in Compose (built from `apps/code-executor`; the only one with extra privileges: SYS_ADMIN, the seccomp profile, AppArmor off; `mem_limit` 2 GB, 512 PIDs, a health check; no published port) on an `executor` network that is `internal` and holds only it, the API and the workers, so the executor reaches neither the database nor the internet; the API and workers wait for it to be healthy. `PYTHON_EXECUTOR_TOKEN` is required in `.env` (like `SESSION_SECRET`); `PYTHON_MEMORY_MB` and `PYTHON_MAX_CONCURRENT` (4) pass through. CI's docker job builds its image too; server and engine tests start it like the MySQL container (`startTestExecutor` in `@ow/code-executor/testing`: builds this checkout's image, tagged by a hash of its sources, and runs it on a random local port; `PYTHON_EXECUTOR_TEST_URL`/`_TOKEN` to use another; skipped locally without Docker, required in CI); the e2e setup too. The runbook is `docs/runbooks/python.md` (configuration, privileges, adding a package, logs, symptoms).
- **Not in M12:** network access, `fetch` and workflow functions from Python, per-workflow packages, Python in apps, a Python debugger or step-through, keeping a Python process warm between blocks (each execution starts a fresh interpreter; step 1 measures what that costs).
- **From the PR #14 review** (session 12; these replace what's above where they differ):
  - **Runs don't wait for the executor's syntax check**: `checkDefinition(…, 'run')` only needs an executor configured (no network call), so a busy executor can't refuse runs, and a syntax error fails its block (with its line). Publishing, rollback and Git deploys still check the syntax.
  - **A check that fails says so**: `/check` answering `ok: false` (no jail, out of time) is `unavailable`, never "no problems". Checks time out after 15 s and runs after their timeout plus 35 s, if nothing else hangs up first.
  - **Timeouts keep the prints**: the client asks the executor to stop 500 ms before the block's timeout, and the executor's deadline is the timeout exactly (nsjail's whole-second limits a second later are the backstop), so it answers `timeout` with what the code printed; the message names the block's timeout.
  - **Checks have slots of their own** in the executor (`PYTHON_MAX_CHECKS`, 2): they never hold up runs. `workflows.checkPython` needs Edit on a workflow (`workflowId`), at most 20 fields of 200 kB.
  - **`del a[0]` and `del a.b` read `a`** (only `del a` binds it).
  - **Python's keywords aren't reserved block names** any more (JavaScript-only workflows from before M12 may use `pass` or `from`): in a workflow with Python they're a warning (`python_keyword`), and renaming a block Python reads to one is refused (the references wouldn't survive).
  - **Assigning a block's or run global's name** (`value = value * 2`, `rows = rows.data`, `configVars = …`) is a warning (`python_shadowed`): in Python that makes it the code's own variable, and reading it before fails with UnboundLocalError. (`from m import *` is a syntax error inside the function body: the executor's check says so.)
  - **Python is optional in Compose**: without `PYTHON_EXECUTOR_TOKEN` the app starts and Python stays off (a warning at start; blocks fail `python_unavailable`), the executor refuses to start; the API and workers start without waiting for it (`required: false`). A URL without a token is no longer a config error.

## 2.15 Editor polish (M13)

Undo, redo, copy, paste and duplicate in both editors, the way any editor has them.

- **Agreed with the user at the start of M13 (session 13):** M13 is undo/redo, copy/paste, duplicate and shortcuts in **both** editors; app modules and the Query Library are **M14** (each is a new object kind); AI actions go **last** on the roadmap.
- **History** (`apps/web/src/lib/history.ts`, pure: `record`, `undo`, `redo`): **snapshots of the definition**, not patches (every edit already returns a new object sharing what didn't change, so no dependency and no inverse-patch bugs). An entry is `{before, after, view}`; the view is what was selected (workflows: the block and the open function; apps: the component, the open code item and the page) and is put back on undo (a page through `resolvePage`; a function that no longer exists isn't opened). At most 100 entries. **Grouping** (automatic, decided in step 1: no keys at the call sites): `changeKey` compares the two definitions by reference and names the plain values the edit replaced (`.blocks.1.config.code`); consecutive edits with the same key, less than 1 s apart, merge (typing in a field, nudging a block); edits that change the shape (adding or removing blocks, edges or objects) never merge; undo, redo and a change of selection end a group. An edit that changes nothing (`sameValue`: some fields report the value they have) is ignored: no step, no save. A new edit drops the redo entries.
- **In the stores** (both): `update(edit)`, `undo`, `redo`. **To the server an undo is an edit like any other**: autosave saves it with the usual revision; history never holds revisions. `load()` clears the history (reloading after a conflict, switching branches, the Git bar replacing the draft). Undo is off while read-only or in conflict. The workflow store gets the app store's check against the saved JSON, so undoing back to what's saved doesn't save again. An `epoch` counter, raised by undo, redo and paste, keys the side panel, inspector and code panel: what they read once when mounted (name drafts, a trigger's test input, a default value, a request's JSON) and Monaco's models start afresh.
- **Shortcuts** (`apps/web/src/lib/shortcuts.ts`): Mod+Z, Mod+Shift+Z and Mod+Y, Mod+D (duplicate; the browser's bookmark shortcut is prevented), Delete as today; copy and paste through the browser's own events. Ignored in inputs, text areas, editable content, Monaco (`.monaco-editor`) and the side panel (`.nokey`), while a dialog is open and while composing (IME): **Monaco keeps its own undo**. Undo and Redo buttons in the toolbars.
- **The clipboard:** the `copy` and `paste` events (`clipboardData`: no permission prompt, so no Paste button, which would need `navigator.clipboard.readText`), copy skipped while text is selected on the page (run logs). The payload is JSON: `{ ow: 'workflow-blocks' | 'app-components' | 'app-queries', v: 1, … }`, so it works between workflows, between apps and between tabs. Copy works on read-only drafts; paste doesn't. **What's pasted is untrusted** (any page can put text on the clipboard): parsed with the definition schemas and a size cap; copying keeps the payload's hash in `localStorage`, and pasting anything else asks first, listing what will be added (in apps, how many queries run by themselves: the running draft follows edits within 300 ms).
- **Pasting blocks** (`packages/definition/src/paste.ts`: `copyBlocks`, `pasteBlocks`): names that are free in the target (not its blocks, functions or reserved words, nor the other pasted names, so renames never chain), given on a definition holding only the pasted items through `renameBlock` (references, edges and layout rewritten; a `captured` rename takes the next number). Edges are kept between pasted blocks only; positions are offset. The start trigger isn't pasted; a second error trigger, and blocks a function can't hold (the validator's `notInFunction`, exported), are skipped. **The functions the blocks call come along** (Function blocks, loop runners, calls in code; and the functions those call): added when missing, reused when the same (`canonicalJson`), the target's kept when different (said so). With exactly one block selected (not a branch), it's connected to the pasted roots, like Add. A summary lists what was skipped or reused and **the references to blocks that weren't copied** (they'd point at a block of that name in the target).
- **Selection on the workflow canvas:** `selection: string[]` in the store, kept in step with React Flow's (an equality check stops the loop) and fed back to the nodes, so a multi-selection survives edits. Copy, duplicate and delete use it.
- **Pasting in apps** (`packages/app-definition/src/paste.ts`: `pasteComponents` with their descendants, `pasteQueries` for queries, transformers and variables): fresh names in the app's one namespace through `renameAppEntity` (references, parents, handler targets, layout keys). Pasted into the selected component when it's a container (modals too), else next to it; overlays at the top level without layout; top-level items on the current page (global code stays global); the roots at the bottom of the grid they land in, keeping their offsets, children where they were in their container.
- **Fixed on the way:** the workflow editor loaded people with Use as editable (canvas edits went dirty and were never saved, and every refetch reloaded the draft); they now get it read-only, and a read-only canvas can't drag, connect or delete.
- **Not in M13:** modules and the Query Library (M14), selecting several components at once in apps, a Paste button, undo across reloads, pasting many cells in the Database grid.
