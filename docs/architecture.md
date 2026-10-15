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
  - `oauth_tokens`
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
  - Per-resource `disablePreparedStatements` is for Own/admin only (not built: every connector binds parameters).
- **MVP connectors:**
  - **Postgres** (postgres.js): `SET LOCAL statement_timeout`, cancel on abort, `maxRows`, optional read-only mode.
  - **REST** (undici):
    - Config: base URL, default headers and parameters, `allowedHosts`.
    - Auth: none, API key, bearer, basic, or OAuth2 client-credentials (tokens cached, refreshed once on a 401).
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
| **M9+** | Python executor (nsjail), SQS/Kafka triggers, OAuth auth-code + custom auth flows, Git sync (canonical JSON already exists), multiplayer editing (Yjs), AI actions | n/a |

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
9. M6: a run waiting on a User Task survives `docker compose down`/`up` and resumes when the task is completed; retention deletes 100k old block rows while runs keep flowing, with no lock waits (handoff §9 has the numbers).
10. Automated: `pnpm test` (Vitest unit and golden-semantics tests; Postgres comes from embedded-postgres, not Testcontainers) and `pnpm --filter @ow/web e2e` (Playwright, against the bundled server; see `apps/web/e2e`).

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
- **Where code runs:** in the browser (Retool's way), inside a hidden iframe with `sandbox="allow-scripts"` (an opaque origin: no cookies, no access to the page) and a CSP without network access (`default-src 'none'`); it talks to the page over a MessageChannel. The page runs queries, keeps the state for React, and checks effects (http(s)/mailto links, text/CSV/JSON downloads). The sandbox's script (`@ow/app-runtime` plus the stdlib) is bundled by esbuild at build time and written into the frame's document. Known limit: the sandbox shares the page's thread, so an infinite loop freezes the tab.
- **Queries stay on the server** (`apps.runQuery`): the browser sends a query's name and the values of its `{{ }}`s (keyed by their code), never SQL; the server binds them as parameters, so values never become SQL. Expressions reading only `current_user` are evaluated on the server (what the browser sends is ignored); mixing `current_user` with app values is refused (validator and server).
- **Access:** Use on an app opens its live release and runs its queries without any grant on their resources; whoever publishes vouches for them (Edit on the app, Use on every queried resource in every environment), like a workflow's webhook. Draft queries (the editor) need Edit on the app and Use on the resource in that environment. A release that's no longer live is refused, so an open page can't keep running an old version. Manual (write) query runs are audited without values.
- **The editor** (`/apps/<slug>/edit`): react-grid-layout canvas (a grid per container, drag by handle), palette and tree, the inspector (props with `fx` switches, handlers), a bottom panel (queries, transformers, variables, state, problems, console), autosave with optimistic concurrency. The draft runs live and follows edits without restarting (typed values, query results and variables carry over; automatic queries re-run only when they or their values changed).
- **Components** (`apps/web/src/pages/apps/components`): Table (virtualized, sorting, selection, keyboard editing into `changesetArray` keyed by primary key, Save fires `save` and clears the changes once it succeeded), Form (`form.data` from its inputs, required inputs checked by the runtime), inputs, Button, Text, Container, Modal, and Chart (Chart.js in its own chunk; the dataviz reference palette in a fixed order, a table view).
- **Releases:** semver publish and rollback like workflows; `/apps/<slug>` shows the live release in an environment the viewer picks.
- **Not yet:** multipage apps, modules, a mobile layout, custom components, a Query Library, server-side paging for tables, per-row column templates, folders for apps, multiplayer editing, themes, running the sandbox off the page's thread.
