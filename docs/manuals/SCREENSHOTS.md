# Screenshots used by the manuals

The contract between the manuals (`user-guide.md`, `admin-guide.md`) and the screenshot tour
(`apps/web/e2e-manual/manual-screenshots.spec.ts`, run with `apps/web/playwright.manual.config.ts`). Each file is
`docs/manuals/images/<name>.png`, 1440×900 unless noted, light theme, taken from a test copy of the app filled with
demo data (never the production server). Rename or add one here first, then in the tour and the manuals.

| Name | What it shows |
|---|---|
| **Getting started** | |
| `login` | The sign-in page ("Sign in with Google") |
| `waiting-approval` | The page a new person sees while waiting for an admin's approval |
| `home-sidebar` | The app's frame: the sidebar with its sections, the Workflows list as the page |
| `command-palette` | ⌘K open, searching for a workflow |
| **Workflows** | |
| `workflows-list` | Workflows list with a few demo workflows and folders |
| `workflow-new` | The "New workflow" dialog |
| `workflow-import` | The "Import from Retool" dialog (workflows) |
| `workflow-editor` | The editor: a canvas with a start trigger and 4–5 connected blocks (query, code, branch, response) |
| `workflow-add-block` | Adding a block: the block picker open |
| `workflow-block-code` | A JavaScript code block, its code visible |
| `workflow-block-python` | A Python code block |
| `workflow-block-query` | A resource query block with SQL on a database resource |
| `workflow-block-branch` | A branch block with its conditions |
| `workflow-block-loop` | A loop block |
| `workflow-block-task` | A User Task block (fields, assignees, outcomes) |
| `workflow-triggers` | The start trigger's Triggers panel: webhook and schedules |
| `workflow-webhook` | The webhook trigger's settings: URL, method, auth |
| `workflow-schedule` | A schedule trigger (cron, time zone, next fires) |
| `workflow-run-panel` | After a test run: the run panel with a block's data |
| `workflow-run-logs` | The run panel's logs tab |
| `workflow-publish` | The Publish menu: versions, compare with live, history |
| `workflow-access` | The workflow's Access dialog (share with a person or group) |
| `workflow-settings` | The workflow's settings (environment, concurrency, timeouts) |
| `runs-list` | The Runs page with several runs (succeeded, failed) |
| `run-detail` | One run's page: blocks, data, timing |
| `inbox` | The Inbox with an open User Task |
| `inbox-task` | One task opened: its fields and outcome buttons |
| **Apps** | |
| `apps-list` | Apps list with a few demo apps |
| `app-new` | The "New app" dialog |
| `app-editor` | The app editor: canvas with components, the component panel, the inspector |
| `app-components` | The component picker (palette) |
| `app-inspector` | A Table component selected: its inspector |
| `app-query` | The query panel at the bottom: a SQL query and its results |
| `app-expressions` | Typing `{{ }}` in a property: autocomplete with components and queries |
| `app-events` | An event handler on a button (run a query, show a notification) |
| `app-pages` | Pages: the page list / navigation of a multipage app |
| `app-publish` | The app's Publish menu |
| `app-view` | A published app opened at its URL (just the app, slim bar) |
| `app-access` | The app's Access dialog |
| **Reuse** | |
| `library` | The Query Library with a saved query |
| `modules` | Modules list or a module open |
| `component-libraries` | Custom component libraries |
| **Resources** | |
| `resources-list` | Resources list, grouped by kind |
| `resource-new` | "New resource": the type picker |
| `resource-postgres` | A PostgreSQL resource's settings, per environment |
| `resource-rest` | A REST API resource's settings (base URL, auth) |
| `resource-ssh` | A resource's SSH tunnel section (host or Google IAP) |
| `resource-playground` | The resource playground running a query |
| **Database** | |
| `database-tables` | The Database section: the list of tables |
| `database-table` | One table open: rows, columns, edit |
| **Your account and the API** | |
| `account-menu` | The account menu (theme, sign out) |
| **Settings (admins)** | |
| `settings-users` | Settings → Users: people, a waiting request, Invite people (disabled) |
| `settings-user` | One person's page: groups, what's shared with them |
| `settings-groups` | Settings → Groups |
| `settings-group` | One group: members and its access |
| `settings-api-keys` | Settings → API keys |
| `settings-access-tokens` | Settings → Access tokens |
| `settings-environments` | Settings → Environments |
| `settings-config-vars` | Settings → Config vars |
| `settings-git` | Settings → Git |
| `settings-python` | Settings → Python (package indexes) |
| `settings-npm` | Settings → npm registries |
| `settings-jdbc` | Settings → JDBC drivers |
| `settings-audit` | Settings → Audit log |

## How to regenerate the screenshots

From the repo root, build first (the tour serves the built web app and server), then run the tour from `apps/web`:

```sh
corepack pnpm --filter @ow/server --filter @ow/web build
cd apps/web && npx playwright test -c playwright.manual.config.ts --reporter=line
```

It starts its own throwaway Postgres and server (`e2e/global-setup.ts`; Docker is used for the Python executor when
it runs), fills them with the demo data in `apps/web/e2e-manual/demo-data.ts`, and overwrites every PNG here. Take only
some with `SHOTS=login,apps-list` before the command. The normal e2e run (`playwright.config.ts`) doesn't include
the tour.
